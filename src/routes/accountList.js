'use strict';

const express = require('express');
const logger  = require('../audit/logger');
const { getMarketoToken } = require('../auth/marketo');
const {
  createNamedAccountList,
  upsertNamedAccounts,
  addNamedAccountsToList,
} = require('../writers/marketoLists');

const router = express.Router();

const MAX_ACCOUNTS = 100;

function defaultListName() {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `D365 Account Sync — ${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

/**
 * Reduce a Dynamics account record (raw OData shape) to the fields Marketo's
 * Named Account API accepts. Marketo Named Accounts dedupe on `name`; the rest
 * are optional enrichment fields.
 *
 * This projection is decoupled from the compliance-scoped fieldmap (Task 11)
 * on purpose — the spec's CRM→Marketo account sync is narrower (accountnumber,
 * choices, lookups). The ABM Named Account API has its own schema and benefits
 * from a wider enrichment set, so we read the Dynamics row directly here.
 */
function shapeForMarketo(row) {
  const name = row.name || row.company;
  if (!name) return null;
  const out = { name };
  if (row.websiteurl)       out.domain           = row.websiteurl;
  if (row.industrycode)     out.industry         = row.industrycode;
  if (row.revenue)          out.annualRevenue    = row.revenue;
  if (row.numberofemployees) out.numberOfEmployees = row.numberofemployees;
  if (row.address1_city)    out.billingCity      = row.address1_city;
  if (row.address1_stateorprovince) out.billingState = row.address1_stateorprovince;
  if (row.address1_country) out.billingCountry   = row.address1_country;
  return out;
}

function validateBody(body, requireListName) {
  if (!body || typeof body !== 'object') {
    return { error: 'request body required' };
  }
  if (requireListName && (!body.listName || typeof body.listName !== 'string' || !body.listName.trim())) {
    return { error: 'listName is required' };
  }
  if (!Array.isArray(body.accounts) || body.accounts.length === 0) {
    return { error: 'accounts array is required and non-empty' };
  }
  if (body.accounts.length > MAX_ACCOUNTS) {
    return { error: `Too many accounts: max is ${MAX_ACCOUNTS} per request` };
  }
  return null;
}

/**
 * POST /api/account-list/dry-run
 * Body: { listName?, accounts: [...d365 account rows] }
 * No external calls. Returns what the real sync WOULD do.
 */
router.post('/dry-run', (req, res) => {
  const err = validateBody(req.body, false);
  if (err) return res.status(400).json(err);

  const listName = (req.body.listName && req.body.listName.trim()) || defaultListName();
  const shaped   = req.body.accounts.map(shapeForMarketo).filter(Boolean);
  const dropped  = req.body.accounts.length - shaped.length;

  res.json({
    dryRun:    true,
    listName,
    members:   shaped,
    droppedNoName: dropped,
    note:      'No external API calls were made. Toggle to Real World mode to actually create the list in Marketo.',
  });
});

/**
 * POST /api/account-list/sync
 * Body: { listName?, description?, accounts: [...d365 account rows] }
 *
 * Full real-mode flow:
 *   1. Create Named Account List in Marketo
 *   2. Upsert each account as a Named Account
 *   3. Add the resulting Named Accounts to the list
 *
 * Returns per-step + per-account status so the UI can show the user exactly
 * what happened. ABM-not-enabled errors surface verbatim.
 */
router.post('/sync', async (req, res) => {
  const err = validateBody(req.body, true);
  if (err) return res.status(400).json(err);

  const listName    = req.body.listName.trim();
  const description = req.body.description || `Created via Sync View on ${new Date().toISOString()}`;
  const shaped      = req.body.accounts.map(shapeForMarketo).filter(Boolean);
  if (shaped.length === 0) {
    return res.status(400).json({ error: 'No accounts had a usable name field after mapping' });
  }

  const out = {
    listName,
    listId:        null,
    upserted:      [],
    addedToList:   [],
    error:         null,
  };

  let token;
  try {
    token = await getMarketoToken();
  } catch (e) {
    return res.status(502).json({ ...out, error: `Marketo auth failed: ${e.message}` });
  }

  // 1. Create the list. Most likely failure mode: ABM add-on not enabled.
  try {
    const created = await createNamedAccountList({ name: listName, description, token });
    out.listId   = created.listId;
    out.listName = created.name;
  } catch (e) {
    logger.warn({ error: e.message }, '[accountList/sync] create list failed');
    return res.status(502).json({
      ...out,
      error: e.message,
      hint:  /403|404|not authorized|access/i.test(e.message)
        ? "Marketo's Named Account Lists require the Account-Based Marketing add-on. Check whether your tenant has it enabled."
        : undefined,
    });
  }

  // 2. Upsert each account as a Named Account so they exist in Marketo.
  try {
    out.upserted = await upsertNamedAccounts({ accounts: shaped, token });
  } catch (e) {
    logger.warn({ error: e.message }, '[accountList/sync] upsert named accounts failed');
    return res.status(502).json({ ...out, error: `Upsert step failed: ${e.message}` });
  }

  // 3. Add the successful upserts to the list.
  const ids = out.upserted
    .filter(r => r.namedAccountId && r.status !== 'skipped' && r.status !== 'failed')
    .map(r => r.namedAccountId);

  if (ids.length === 0) {
    out.error = 'No accounts were upserted successfully — nothing to add to the list.';
    return res.status(207).json(out); // 207 multi-status: partial result
  }

  try {
    out.addedToList = await addNamedAccountsToList({ listId: out.listId, namedAccountIds: ids, token });
  } catch (e) {
    logger.warn({ error: e.message }, '[accountList/sync] add to list failed');
    return res.status(502).json({ ...out, error: `Add-to-list step failed: ${e.message}` });
  }

  logger.info({
    listId: out.listId,
    upserted: out.upserted.length,
    added: out.addedToList.length,
  }, '[accountList/sync] complete');

  res.json(out);
});

module.exports = { router, _shapeForMarketo: shapeForMarketo, _defaultListName: defaultListName };
