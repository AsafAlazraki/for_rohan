'use strict';

/**
 * Task 17 — Dataverse `connection` management for named relationship roles
 * (KAM / Technology / HR / Procurement / Logistics / Finance).
 *
 * Roles are never auto-created (ASSUMPTIONS.md §3). Role-name → GUID lookups
 * cache for 1 h (mirrors optionSetResolver). If a role is missing from CRM,
 * `setRelationship` returns `{ skipped, reason }` and WARNs once; `checkConnectionRoles`
 * surfaces missing roles at worker boot.
 */

const axios = require('axios');
const { getConfig } = require('../config/loader');
const logger = require('../audit/logger');

const TTL_MS = 60 * 60 * 1000;
const EXPECTED_ROLES = ['KAM', 'Technology', 'HR', 'Procurement', 'Logistics', 'Finance'];

// Map<roleName, { at: number, roleId: string|null }>
const _roleCache = new Map();
// Guards per-role "missing" WARNs so we don't spam logs.
const _warnedMissing = new Set();

function oDataEscape(v) { return String(v).replace(/'/g, "''"); }

async function dynamicsBase() {
  const resourceUrl = await getConfig('DYNAMICS_RESOURCE_URL');
  if (!resourceUrl) throw new Error('[relationships] DYNAMICS_RESOURCE_URL not set');
  const apiVersion = (await getConfig('DYNAMICS_API_VERSION')) || '9.2';
  return `${resourceUrl}/api/data/v${apiVersion}`;
}

function headers(token) {
  return {
    Authorization:      `Bearer ${token}`,
    'OData-MaxVersion': '4.0',
    'OData-Version':    '4.0',
    Accept:             'application/json',
    'Content-Type':     'application/json',
  };
}

function connectionFilter(accountId, contactId, roleId) {
    return `_record1id_value eq ${accountId}`
      + ` and _record2id_value eq ${contactId}`
      + ` and _record1roleid_value eq ${roleId}`;
}

async function findActiveConnection(base, token, accountId, contactId, roleId) {
  const { data } = await axios.get(`${base}/connections`, {
    headers: headers(token),
    params:  {
      $filter: connectionFilter(accountId, contactId, roleId),
      $select: 'connectionid',
      $top:    1,
    },
  });
  return data?.value?.[0] || null;
}

/** Returns the connection-role GUID, or null if the role is not in CRM. */
async function resolveRoleId(roleName, token) {
  const hit = _roleCache.get(roleName);
  if (hit && (Date.now() - hit.at) < TTL_MS) return hit.roleId;

  const base = await dynamicsBase();
  const { data } = await axios.get(`${base}/connectionroles`, {
    headers: headers(token),
    params: {
      $filter: `name eq '${oDataEscape(roleName)}'`,
      $select: 'connectionroleid,name',
      $top:    1,
    },
  });
  const rec = data?.value?.[0];
  const roleId = rec ? rec.connectionroleid : null;
  _roleCache.set(roleName, { at: Date.now(), roleId });
  return roleId;
}

function warnMissingRoleOnce(roleName) {
  if (_warnedMissing.has(roleName)) return;
  _warnedMissing.add(roleName);
  logger.warn({ roleName },
    '[relationships] connection role missing in CRM — skipping relationship writes');
}

function missingRoleSkip(roleName) {
  warnMissingRoleOnce(roleName);
  return { skipped: true, reason: `connection-role-missing:${roleName}` };
}

/**
 * Idempotent create of an active `connection` (record1=Account, record2=Contact,
 * role=<roleName>). No-op when a matching connection already exists.
 * Returns `{ skipped, reason }` if the role is missing — never throws for that
 * case (ASSUMPTIONS §3).
 */
async function setRelationship({ accountId, contactId, roleName, token }) {
  if (!accountId || !contactId || !roleName) {
    throw new Error('[relationships.setRelationship] accountId, contactId, roleName required');
  }

  const roleId = await resolveRoleId(roleName, token);
  if (!roleId) return missingRoleSkip(roleName);

  const base = await dynamicsBase();
  const existing = await findActiveConnection(base, token, accountId, contactId, roleId);
  if (existing) {
    return { created: false, connectionId: existing.connectionid, roleId };
  }

  const body = {
    'record1id_account@odata.bind': `/accounts(${accountId})`,
    'record2id_contact@odata.bind': `/contacts(${contactId})`,
    'record1roleid@odata.bind':     `/connectionroles(${roleId})`,
  };
  const { headers: respHeaders, data } = await axios.post(
    `${base}/connections`, body, { headers: headers(token) },
  );

  let connectionId = data?.connectionid || null;
  if (!connectionId && respHeaders) {
    const loc = respHeaders['OData-EntityId'] || respHeaders['odata-entityid'];
    const m = typeof loc === 'string' ? loc.match(/\(([^)]+)\)\s*$/) : null;
    if (m) connectionId = m[1];
  }
  return { created: true, connectionId, roleId };
}

/**
 * Deactivate the active `connection` matching the triple (statecode=1,
 * statuscode=2). No-op when none exists or the role is missing.
 */
async function clearRelationship({ accountId, contactId, roleName, token }) {
  if (!accountId || !contactId || !roleName) {
    throw new Error('[relationships.clearRelationship] accountId, contactId, roleName required');
  }

  const roleId = await resolveRoleId(roleName, token);
  if (!roleId) return missingRoleSkip(roleName);

  const base = await dynamicsBase();
  const rec = await findActiveConnection(base, token, accountId, contactId, roleId);
  if (!rec) return { cleared: false, reason: 'not-found' };

  await axios.patch(
    `${base}/connections(${rec.connectionid})`,
    { statecode: 1, statuscode: 2 },
    { headers: headers(token) },
  );
  return { cleared: true, connectionId: rec.connectionid };
}

/**
 * Boot check — looks up every expected role and WARNs for any missing ones.
 * Never throws; per-role failures are logged and swallowed. Skips with INFO
 * if no token is available.
 */
async function checkConnectionRoles(token) {
  if (!token) {
    logger.info('[relationships] no Dynamics token available — skipping connection-role boot check');
    return { checked: false, missing: [] };
  }
  const missing = [];
  for (const roleName of EXPECTED_ROLES) {
    try {
      const roleId = await resolveRoleId(roleName, token);
      if (!roleId) {
        missing.push(roleName);
        logger.warn({ roleName },
          '[relationships] expected connection role missing in CRM — seed via scripts/seed-connection-roles.js');
      }
    } catch (err) {
      logger.warn({ roleName, err: err.message },
        '[relationships] connection-role check failed — continuing');
    }
  }
  return { checked: true, missing };
}

function _resetCache() {
  _roleCache.clear();
  _warnedMissing.clear();
}

module.exports = {
  setRelationship,
  clearRelationship,
  checkConnectionRoles,
  EXPECTED_ROLES,
  _resetCache,
};
