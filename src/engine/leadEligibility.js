'use strict';

const { getConfig } = require('../config/loader');
const { resolveAccount } = require('./accountResolver');
const { classifyPerson } = require('./personClassifier');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function criterionResult(ok, detail) {
  return detail ? { ok, detail } : { ok };
}

async function flagList(key) {
  const raw = await getConfig(key);
  if (!raw) return null;
  return String(raw).split(',').map(s => s.trim()).filter(Boolean);
}

async function flagNumber(key) {
  const raw = await getConfig(key);
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

// ── Individual criteria ──────────────────────────────────────────────────────
// Each returns { ok, detail? } and may be async. They never throw on bad data;
// an empty/invalid payload fails the criterion with a detail string instead.

function personType(payload) {
  const { kind } = classifyPerson(payload);
  const ok = kind === 'lead' && !payload.crmLeadId && !payload.crmContactId;
  return criterionResult(ok, ok ? null : 'person is not an unresolved lead');
}

function emailValid(payload) {
  if (!payload.email)                   return criterionResult(false, 'email missing');
  if (!EMAIL_RE.test(payload.email))    return criterionResult(false, 'email malformed');
  return criterionResult(true);
}

async function companyExists(payload, ctx) {
  const ids = {
    accountnumber: payload.accountNumber,
    name:          payload.company,
  };
  if (!ids.accountnumber && !ids.name) {
    // Company is optional — skip account linkage, lead will be created without a parent account.
    return criterionResult(true);
  }
  const { targetId } = await ctx.accountResolver.resolveAccount({ ids, token: ctx.token });
  if (targetId) {
    payload._resolvedAccountId = targetId;
    return criterionResult(true);
  }

  // Account not found — auto-create it in Dynamics so the Lead can be linked.
  const logger = require('../audit/logger');
  const { writeDynamicsAccount } = require('../writers/dynamics');
  const companyName = ids.name || ids.accountnumber;
  logger.info(
    { company: companyName },
    '[leadEligibility] company not found in CRM — auto-creating account',
  );
  try {
    const accountBody = { name: companyName };
    if (ids.accountnumber) accountBody.accountnumber = ids.accountnumber;
    const { targetId: newAccountId } = await writeDynamicsAccount(
      { action: 'create', ...accountBody },
      ctx.token,
    );
    if (newAccountId) {
      payload._resolvedAccountId = newAccountId;
      logger.info({ accountId: newAccountId, company: companyName }, '[leadEligibility] account auto-created');
      return criterionResult(true);
    }
    return criterionResult(false, `failed to auto-create account for ${companyName}`);
  } catch (err) {
    logger.error({ err: err.message, company: companyName }, '[leadEligibility] account auto-create failed');
    return criterionResult(false, `auto-create account error: ${err.message}`);
  }
}

function consent(payload) {
  const ok = payload.unsubscribed !== true;
  return criterionResult(ok, ok ? null : 'unsubscribed=true');
}

function dataCompleteness(payload) {
  const missing = [];
  if (!payload.firstName) missing.push('firstName');
  if (!payload.lastName)  missing.push('lastName');
  if (!payload.email)     missing.push('email');
  // company is optional — Dynamics does not require it for lead/contact creation
  return missing.length
    ? criterionResult(false, `missing: ${missing.join(',')}`)
    : criterionResult(true);
}

async function countryScope(payload) {
  const list = await flagList('LEAD_COUNTRY_ALLOWLIST');
  if (!list) return criterionResult(true); // flag disabled
  if (!payload.country) return criterionResult(false, 'no country on payload');
  return list.includes(payload.country)
    ? criterionResult(true)
    : criterionResult(false, `country ${payload.country} not in allowlist`);
}

async function lifecycleGate(payload) {
  const min = await flagNumber('LEAD_LIFECYCLE_MIN');
  if (min == null) return criterionResult(true); // flag disabled
  const score = Number(payload.leadScore);
  if (!Number.isFinite(score)) {
    return criterionResult(false, 'leadScore absent or non-numeric');
  }
  return score >= min
    ? criterionResult(true)
    : criterionResult(false, `leadScore ${score} < min ${min}`);
}

async function sourceChannelScope(payload) {
  const list = await flagList('LEAD_SOURCE_ALLOWLIST');
  if (!list) return criterionResult(true); // flag disabled
  if (!payload.source) return criterionResult(false, 'no source on payload');
  return list.includes(payload.source)
    ? criterionResult(true)
    : criterionResult(false, `source ${payload.source} not in allowlist`);
}

/**
 * Evaluate every Lead eligibility criterion and collect all failures (do not
 * short-circuit — operators need the full picture).
 *
 * @param {object} payload  Marketo Person payload.
 * @param {{ token: string,
 *           accountResolver?: { resolveAccount: Function },
 *           config?: object }} ctx
 * @returns {Promise<{ ok: boolean,
 *                     failures: Array<{ criterion: string, detail?: string }>,
 *                     resolvedAccountId: string|null }>}
 */
async function evaluateEligibility(payload, ctx = {}) {
  if (!ctx.token) throw new Error('[leadEligibility] ctx.token required');
  const accountResolver = ctx.accountResolver || { resolveAccount };
  const fullCtx = { ...ctx, accountResolver };

  const checks = [
    ['personType',          personType(payload)],
    ['emailValid',          emailValid(payload)],
    ['consent',             consent(payload)],
    ['dataCompleteness',    dataCompleteness(payload)],
    ['companyExists',       companyExists(payload, fullCtx)],
    ['countryScope',        countryScope(payload)],
    ['lifecycleGate',       lifecycleGate(payload)],
    ['sourceChannelScope',  sourceChannelScope(payload)],
  ];

  const failures = [];
  for (const [name, promise] of checks) {
    const res = await Promise.resolve(promise);
    if (!res.ok) failures.push({ criterion: name, detail: res.detail });
  }

  return {
    ok: failures.length === 0,
    failures,
    resolvedAccountId: payload._resolvedAccountId || null,
  };
}

module.exports = { evaluateEligibility };
