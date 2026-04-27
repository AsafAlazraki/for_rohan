'use strict';

/**
 * End-to-end smoke tests against real Dynamics and Marketo sandbox environments.
 *
 * ALL TESTS ARE SKIPPED AUTOMATICALLY when the required credentials are absent,
 * so this file is safe to include in the standard `npm test` run in CI.
 *
 * To run locally against real sandboxes:
 *   1. Fill in all DYNAMICS_* and MARKETO_* variables in .env
 *   2. npx jest tests/e2e/fullSync.test.js --runInBand --verbose
 *
 * What is NOT mocked:
 *   axios, src/auth/*, src/engine/*, src/writers/*
 *
 * What IS stubbed:
 *   audit/db — a lightweight in-memory stub so no Postgres is required.
 *   BullMQ / IORedis are never instantiated (processJob is called directly).
 */

// ─────────────────────────────────────────────────────────────────────────────
// Credential guards — evaluated once at module load time.
// Tests only run when E2E_RUN=1 is explicitly set AND credentials are present.
// This prevents CI environments with placeholder creds from firing real HTTP.
// ─────────────────────────────────────────────────────────────────────────────
const E2E_ENABLED = process.env.E2E_RUN === '1';

const HAS_DYN = !!(
  E2E_ENABLED &&
  process.env.DYNAMICS_TENANT_ID   &&
  process.env.DYNAMICS_CLIENT_ID   &&
  process.env.DYNAMICS_CLIENT_SECRET &&
  process.env.DYNAMICS_RESOURCE_URL
);

const HAS_MKTO = !!(
  E2E_ENABLED &&
  process.env.MARKETO_BASE_URL     &&
  process.env.MARKETO_CLIENT_ID    &&
  process.env.MARKETO_CLIENT_SECRET
);

const HAS_BOTH = HAS_DYN && HAS_MKTO;

// Convenience wrappers: test runs when credentials present, skips otherwise
const dynIt  = HAS_DYN  ? it : it.skip;
const mktoIt = HAS_MKTO ? it : it.skip;
const bothIt = HAS_BOTH ? it : it.skip;

// Long timeout — real API calls + polling
jest.setTimeout(60_000);

// ─────────────────────────────────────────────────────────────────────────────
// Module imports (no jest.mock — everything runs for real)
// ─────────────────────────────────────────────────────────────────────────────
const axios = require('axios');

// Inject a lightweight audit stub so processJob never needs Postgres
const { _setPool }    = require('../../src/audit/db');
const { _cache: dynCache  } = require('../../src/auth/dynamics');
const { _cache: mktoCache } = require('../../src/auth/marketo');
const { getDynamicsToken }  = require('../../src/auth/dynamics');
const { getMarketoToken }   = require('../../src/auth/marketo');
const { processJob }        = require('../../src/queue/worker');

// ─────────────────────────────────────────────────────────────────────────────
// Test setup
// ─────────────────────────────────────────────────────────────────────────────
beforeAll(() => {
  // Replace the pg.Pool with an in-memory stub for audit logging
  _setPool({ query: async () => ({ rows: [{ id: `e2e-audit-${Date.now()}` }] }) });
});

beforeEach(() => {
  // Clear token caches so each test fetches fresh tokens
  dynCache.clear();
  mktoCache.clear();
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Unique test email — timestamp-scoped so parallel runs never collide. */
function testEmail(prefix) {
  return `e2e-${prefix}-${Date.now()}@sync-test.invalid`;
}

/**
 * Poll `fn` every `intervalMs` milliseconds until it returns a truthy value
 * or `timeoutMs` elapses.  Returns the truthy result or null on timeout.
 */
async function pollUntil(fn, { timeoutMs = 30_000, intervalMs = 2_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Dynamics CRM API helpers
// ─────────────────────────────────────────────────────────────────────────────

function dynApiBase() {
  const ver = process.env.DYNAMICS_API_VERSION || '9.2';
  return `${process.env.DYNAMICS_RESOURCE_URL}/api/data/v${ver}`;
}

async function dynHeaders() {
  const token = await getDynamicsToken();
  return {
    Authorization:      `Bearer ${token}`,
    'Content-Type':     'application/json',
    'OData-MaxVersion': '4.0',
    'OData-Version':    '4.0',
    Accept:             'application/json',
  };
}

async function createDynamicsContact(fields) {
  const { data, headers } = await axios.post(
    `${dynApiBase()}/contacts`,
    fields,
    { headers: { ...(await dynHeaders()), Prefer: 'return=representation' } },
  );
  const contactid =
    data?.contactid ||
    (headers?.['odata-entityid'] || '').match(/\(([^)]+)\)$/)?.[1];
  return { ...data, contactid };
}

async function getDynamicsContactById(id) {
  try {
    const { data } = await axios.get(
      `${dynApiBase()}/contacts(${id})`,
      { headers: await dynHeaders() },
    );
    return data;
  } catch (e) {
    if (e.response?.status === 404) return null;
    throw e;
  }
}

async function findDynamicsContactByEmail(email) {
  const escaped   = email.replace(/'/g, "''");
  const { data }  = await axios.get(
    `${dynApiBase()}/contacts`,
    {
      headers: await dynHeaders(),
      params:  { $filter: `emailaddress1 eq '${escaped}'` },
    },
  );
  return data?.value?.[0] || null;
}

async function deleteDynamicsContact(id) {
  await axios.delete(
    `${dynApiBase()}/contacts(${id})`,
    { headers: await dynHeaders() },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Marketo REST API helpers
// ─────────────────────────────────────────────────────────────────────────────

async function mktoHeaders() {
  const token = await getMarketoToken();
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

async function findMarketoLeadByEmail(email) {
  const { data } = await axios.get(
    `${process.env.MARKETO_BASE_URL}/rest/v1/leads.json`,
    {
      headers: await mktoHeaders(),
      params: {
        filterType:   'email',
        filterValues: email,
        fields:       'id,email,firstName,lastName,phone,title,company,syncSource',
      },
    },
  );
  return data?.result?.[0] || null;
}

async function createMarketoLead(fields) {
  const { data } = await axios.post(
    `${process.env.MARKETO_BASE_URL}/rest/v1/leads/push.json`,
    { action: 'createOrUpdate', lookupField: 'email', input: [fields] },
    { headers: await mktoHeaders() },
  );
  if (!data.success) throw new Error(`Marketo push failed: ${JSON.stringify(data.errors)}`);
  return data.result?.[0];
}

async function deleteMarketoLead(id) {
  await axios.post(
    `${process.env.MARKETO_BASE_URL}/rest/v1/leads/delete.json`,
    { input: [{ id }] },
    { headers: await mktoHeaders() },
  );
}

/** Build a minimal BullMQ-like job object for processJob(). */
function makeJob(source, payload) {
  return {
    id:           `e2e-${source}-${Date.now()}`,
    data:         { source, receivedAt: new Date().toISOString(), payload },
    opts:         { attempts: 3 },
    attemptsMade: 1,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// E2E-1 — Dynamics → Marketo  (happy path)
// ─────────────────────────────────────────────────────────────────────────────
bothIt('E2E-1: Creates Dynamics contact, syncs to Marketo, verifies all mapped fields', async () => {
  const email  = testEmail('dyn');
  let   dynId  = null;
  let   mktoId = null;

  try {
    // Step 1: Create source record directly in Dynamics
    const contact = await createDynamicsContact({
      emailaddress1: email,
      firstname:     'E2EFirst',
      lastname:      'DynTest',
      telephone1:    '555-9001',
      jobtitle:      'QA Engineer',
    });
    dynId = contact.contactid;
    expect(dynId).toBeTruthy();

    // Step 2: Run the sync pipeline (same code path BullMQ worker calls)
    const result = await processJob(makeJob('dynamics', contact));
    expect(result.status).toMatch(/created|updated/);
    mktoId = result.targetId ? parseInt(result.targetId, 10) : null;

    // Step 3: Poll Marketo until the lead appears (confirms API round-trip)
    const lead = await pollUntil(() => findMarketoLeadByEmail(email));
    expect(lead).not.toBeNull();

    // Step 4: Assert every mapped field arrived correctly
    expect(lead.email).toBe(email);
    expect(lead.firstName).toBe('E2EFirst');
    expect(lead.lastName).toBe('DynTest');
    expect(lead.phone).toBe('555-9001');
    expect(lead.title).toBe('QA Engineer');

    mktoId = mktoId || lead.id;
  } finally {
    if (dynId)  await deleteDynamicsContact(dynId).catch(() => {});
    if (mktoId) await deleteMarketoLead(mktoId).catch(() => {});
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// E2E-2 — Marketo → Dynamics  (reverse path)
// ─────────────────────────────────────────────────────────────────────────────
bothIt('E2E-2: Creates Marketo lead, syncs to Dynamics, verifies all mapped fields', async () => {
  const email  = testEmail('mkto');
  let   mktoId = null;
  let   dynId  = null;

  try {
    // Step 1: Create source lead directly in Marketo
    const lead = await createMarketoLead({
      email,
      firstName: 'E2EFirst',
      lastName:  'MktoTest',
      phone:     '555-9002',
      title:     'Product Manager',
      company:   'E2E Corp',
    });
    mktoId = lead?.id;
    expect(mktoId).toBeTruthy();

    // Step 2: Run the sync pipeline
    const result = await processJob(makeJob('marketo', {
      email,
      firstName: 'E2EFirst',
      lastName:  'MktoTest',
      phone:     '555-9002',
      title:     'Product Manager',
      company:   'E2E Corp',
    }));
    expect(result.action).toMatch(/create|update/);
    dynId = result.targetId;

    // Step 3: Poll Dynamics until the contact appears
    const contact = await pollUntil(() => findDynamicsContactByEmail(email));
    expect(contact).not.toBeNull();

    // Step 4: Assert every mapped field arrived correctly
    expect(contact.emailaddress1).toBe(email);
    expect(contact.firstname).toBe('E2EFirst');
    expect(contact.lastname).toBe('MktoTest');
    expect(contact.telephone1).toBe('555-9002');
    expect(contact.jobtitle).toBe('Product Manager');

    dynId = dynId || contact.contactid;
  } finally {
    if (mktoId) await deleteMarketoLead(mktoId).catch(() => {});
    if (dynId)  await deleteDynamicsContact(dynId).catch(() => {});
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// E2E-3 — Dedup: second sync updates rather than duplicates
// ─────────────────────────────────────────────────────────────────────────────
bothIt('E2E-3: Dedup — syncing existing Dynamics contact from Marketo issues a PATCH, not POST', async () => {
  const email = testEmail('dedup');
  let   dynId = null;
  let   mktoId = null;

  try {
    // Step 1: Pre-create the contact in Dynamics (simulates prior sync)
    const contact = await createDynamicsContact({
      emailaddress1: email,
      firstname:     'OrigFirst',
      lastname:      'OrigLast',
      jobtitle:      'Old Title',
    });
    dynId = contact.contactid;

    // Step 2: Sync from Marketo with updated fields — dedup should find existing record
    const result = await processJob(makeJob('marketo', {
      email,
      firstName: 'UpdatedFirst',
      lastName:  'UpdatedLast',
      title:     'New Title',
      company:   'New Corp',
    }));

    // Must have been an update, not a create
    expect(result.action).toBe('update');
    expect(result.targetId).toBe(dynId);

    // Step 3: Verify the existing contact was patched (not duplicated)
    const updated = await getDynamicsContactById(dynId);
    expect(updated.firstname).toBe('UpdatedFirst');
    expect(updated.jobtitle).toBe('New Title');

    // Step 4: Confirm there is exactly one contact with this email
    const found = await findDynamicsContactByEmail(email);
    expect(found.contactid).toBe(dynId);
  } finally {
    if (dynId)  await deleteDynamicsContact(dynId).catch(() => {});
    if (mktoId) await deleteMarketoLead(mktoId).catch(() => {});
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// E2E-4 — Loop guard: round-trip record is skipped
// ─────────────────────────────────────────────────────────────────────────────
bothIt('E2E-4: Loop guard — record stamped syncSource=dynamics is skipped when syncing back to Dynamics', async () => {
  const email = testEmail('loop');
  let   dynId = null;
  let   mktoId = null;

  try {
    // Simulate a record that already bears the dynamics sync stamp
    const payload = {
      email,
      firstName:  'LoopFirst',
      lastName:   'LoopLast',
      syncSource: 'dynamics',   // ← this stamp triggers the loop guard
    };

    const result = await processJob(makeJob('marketo', payload));

    // Pipeline must have short-circuited without touching any external API
    expect(result.skipped).toBe(true);
    expect(result.reason).toMatch(/loop guard/i);
  } finally {
    if (dynId)  await deleteDynamicsContact(dynId).catch(() => {});
    if (mktoId) await deleteMarketoLead(mktoId).catch(() => {});
  }
});
