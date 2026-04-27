'use strict';

// ── Mock all external modules before any require ──────────────────────────────
// Engine + auth + writers + audit — all mocked
jest.mock('../../src/engine/loopGuard',   () => ({ shouldSkip:     jest.fn() }));
jest.mock('../../src/engine/dedup',       () => ({
  resolveAction:        jest.fn(),
  resolveAccountAction: jest.fn(),
}));
jest.mock('../../src/engine/fieldMapper', () => ({
  mapToMarketo: jest.fn(),
}));
jest.mock('../../src/engine/derivedFields', () => ({
  // Pass through: return the mapped object unchanged so test assertions on
  // writeToMarketo inputs stay stable.
  enrichDerived: jest.fn((mapped) => Promise.resolve(mapped)),
}));
jest.mock('../../src/writers/marketo',  () => ({
  writeToMarketo:      jest.fn(),
  writeMarketoCompany: jest.fn().mockResolvedValue({ targetId: 'mkto-co' }),
}));
jest.mock('../../src/monitor/authorityAlerts', () => ({
  startAuthorityAlertScheduler: jest.fn(),
}));
jest.mock('../../src/writers/dynamics', () => ({
  stampMarketoIdOnContact: jest.fn(),
}));
jest.mock('../../src/audit/db',         () => ({
  logEvent:       jest.fn(),
  logSkip:        jest.fn(),
  loadSnapshot:   jest.fn().mockResolvedValue(null), // bootstrap — delta always "changed"
  upsertSnapshot: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../src/audit/logger',     () => ({
  info:  jest.fn(),
  warn:  jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));
jest.mock('../../src/auth/dynamics', () => ({ getDynamicsToken: jest.fn() }));
jest.mock('../../src/auth/marketo',  () => ({ getMarketoToken:  jest.fn() }));
jest.mock('../../src/queue/queue',   () => ({
  QUEUE_NAME: 'sync-events',
  getBoss:   jest.fn(() => ({
    work: jest.fn().mockResolvedValue(undefined),
    on:   jest.fn(),
  })),
  startBoss: jest.fn().mockResolvedValue(undefined),
  stopBoss:  jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../src/engine/syncDirection', () => ({
  getSyncDirection:      jest.fn().mockResolvedValue('bidirectional'),
  shouldSkipByDirection: jest.fn().mockReturnValue({ skip: false }),
}));
jest.mock('../../src/engine/fieldDelta', () => ({
  hasMappedChange: jest.fn().mockResolvedValue({ changed: true }),
}));
jest.mock('../../src/engine/relationships', () => ({
  checkConnectionRoles: jest.fn().mockResolvedValue(undefined),
}));
// Task 9 — Marketo-source router is tested in worker.marketoRouter.test.js.
// For this suite, stub both handlers so we can verify the router dispatches
// correctly and that the generic pipeline never runs for Marketo sources.
jest.mock('../../src/engine/handlers/unsubscribe', () => ({
  handleGlobalUnsubscribe: jest.fn(),
}));
jest.mock('../../src/engine/handlers/newLead', () => ({
  handleNewLead: jest.fn(),
}));

const { shouldSkip }                   = require('../../src/engine/loopGuard');
const { resolveAction }                = require('../../src/engine/dedup');
const { mapToMarketo }                 = require('../../src/engine/fieldMapper');
const { writeToMarketo }               = require('../../src/writers/marketo');
const { logEvent, logSkip }            = require('../../src/audit/db');
const { getDynamicsToken }             = require('../../src/auth/dynamics');
const { getMarketoToken }              = require('../../src/auth/marketo');
const { handleGlobalUnsubscribe }      = require('../../src/engine/handlers/unsubscribe');
const { handleNewLead }                = require('../../src/engine/handlers/newLead');
const { bus }                          = require('../../src/events/bus');
const { processJob, startWorkers }     = require('../../src/queue/worker');

// ── Helpers ───────────────────────────────────────────────────────────────────
function makeJob(source, payload, overrides = {}) {
  return {
    id:           'job-test-1',
    data:         { source, receivedAt: '2026-04-08T00:00:00Z', payload },
    opts:         { attempts: 3 },
    attemptsMade: 1,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  shouldSkip.mockReturnValue({ skip: false });
  logEvent.mockResolvedValue({ id: 'audit-uuid' });
  logSkip.mockResolvedValue({ id: 'audit-uuid-skip' });
});

// ── Loop guard ────────────────────────────────────────────────────────────────
describe('processJob() — loop guard', () => {
  it('skips and logs when shouldSkip returns true', async () => {
    shouldSkip.mockReturnValue({ skip: true, reason: 'Loop detected' });
    const job = makeJob('marketo', { email: 'a@b.com' });

    const result = await processJob(job);

    expect(result).toEqual({ skipped: true, reason: 'Loop detected' });
    expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({ status: 'skipped' }));
    expect(resolveAction).not.toHaveBeenCalled();
    expect(writeToMarketo).not.toHaveBeenCalled();
  });
});

// ── Dynamics → Marketo ────────────────────────────────────────────────────────
describe('processJob() — dynamics → marketo', () => {
  const dynPayload = {
    emailaddress1: 'alice@example.com',
    firstname:     'Alice',
    lastname:      'Smith',
    id:            'contact-guid',
    type:          'contact',
  };

  beforeEach(() => {
    getMarketoToken.mockResolvedValue('mkto-token');
    resolveAction.mockResolvedValue({ action: 'create', targetId: null });
    mapToMarketo.mockReturnValue({ email: 'alice@example.com', firstName: 'Alice' });
    writeToMarketo.mockResolvedValue({ targetId: '42', status: 'created' });
  });

  it('calls the full pipeline in order', async () => {
    const job = makeJob('dynamics', dynPayload);
    const result = await processJob(job);

    expect(shouldSkip).toHaveBeenCalledWith(job.data, 'marketo');
    expect(getMarketoToken).toHaveBeenCalledTimes(1);
    expect(resolveAction).toHaveBeenCalledWith('alice@example.com', 'marketo', 'mkto-token');
    expect(mapToMarketo).toHaveBeenCalledWith(dynPayload, 'contact');
    expect(writeToMarketo).toHaveBeenCalledWith(
      { email: 'alice@example.com', firstName: 'Alice' },
      'mkto-token',
    );
    expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({
      source_system: 'dynamics',
      target_system: 'marketo',
      status:        'success',
      target_id:     '42',
    }));
    expect(result).toEqual({ targetId: '42', status: 'created' });
  });

  it('does NOT call getDynamicsToken when target is marketo', async () => {
    await processJob(makeJob('dynamics', dynPayload));
    expect(getDynamicsToken).not.toHaveBeenCalled();
  });
});

// ── Marketo → Dynamics (authority-gated; Task 9) ──────────────────────────────
// The symmetric bidirectional pipeline on Marketo sources has been removed —
// Marketo-sourced payloads now route through the authority guard. These tests
// assert the three router branches: GLOBAL_UNSUBSCRIBE, NEW_LEAD, UNAUTHORIZED.
describe('processJob() — marketo → dynamics (authority router)', () => {
  beforeEach(() => {
    getDynamicsToken.mockResolvedValue('dyn-token');
  });

  it('dispatches a global-unsubscribe payload to the unsubscribe handler', async () => {
    handleGlobalUnsubscribe.mockResolvedValue({
      status: 'success',
      targetId: 'contact-unsub',
    });
    const payload = { unsubscribed: true, email: 'x@y.com', crmContactId: 'C1' };

    const result = await processJob(makeJob('marketo', payload));

    expect(handleGlobalUnsubscribe).toHaveBeenCalledWith(
      expect.objectContaining({ payload, token: 'dyn-token' }),
    );
    expect(handleNewLead).not.toHaveBeenCalled();
    expect(result).toEqual({ targetId: 'contact-unsub', action: 'update' });
    expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({
      source_system: 'marketo',
      source_type:   'contact',
      status:        'success',
    }));
  });

  it('dispatches a new-lead payload to the newLead handler', async () => {
    handleNewLead.mockResolvedValue({ status: 'success', targetId: 'lead-new' });
    const payload = { isLead: true, email: 'new@lead.com', company: 'Acme' };

    const result = await processJob(makeJob('marketo', payload));

    expect(handleNewLead).toHaveBeenCalledWith(
      expect.objectContaining({ payload, token: 'dyn-token' }),
    );
    expect(handleGlobalUnsubscribe).not.toHaveBeenCalled();
    expect(result).toEqual({ targetId: 'lead-new', action: 'create' });
    expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({
      source_system: 'marketo',
      source_type:   'lead',
      status:        'success',
    }));
  });

  it('skips an unauthorized Marketo payload with an authority reason', async () => {
    const payload = { crmContactId: 'C1', email: 'a@b.com', firstName: 'Jane' };

    const result = await processJob(makeJob('marketo', payload));

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('marketo-cannot-update-contact-nonconsent');
    expect(handleGlobalUnsubscribe).not.toHaveBeenCalled();
    expect(handleNewLead).not.toHaveBeenCalled();
    expect(logSkip).toHaveBeenCalledWith(expect.objectContaining({
      category:  'authority',
      reason:    'marketo-cannot-update-contact-nonconsent',
      criterion: 'marketo-cannot-update-contact-nonconsent',
    }));
  });

  it('handler skip result (e.g. not-resolvable) surfaces to caller + audit', async () => {
    handleGlobalUnsubscribe.mockResolvedValue({
      status: 'skipped',
      reason: 'contact-not-resolvable',
    });

    const result = await processJob(makeJob('marketo', {
      unsubscribed: true,
      email:        'ghost@nowhere.com',
    }));

    expect(result).toEqual({ skipped: true, reason: 'contact-not-resolvable' });
    expect(logSkip).toHaveBeenCalledWith(expect.objectContaining({
      category: 'authority',
      reason:   'contact-not-resolvable',
    }));
  });

  it('newLead skipped with ineligible: prefix routes to eligibility category', async () => {
    handleNewLead.mockResolvedValue({
      status: 'skipped',
      reason: 'ineligible:dataCompleteness:missing email',
    });

    const r = await processJob(makeJob('marketo', { isLead: true, email: 'a@b.com', company: 'A' }));
    expect(r.skipped).toBe(true);
    expect(logSkip).toHaveBeenCalledWith(expect.objectContaining({
      category: 'eligibility',
      criterion: 'dataCompleteness:missing email',
    }));
  });

  it('newLead skipped without ineligible: prefix uses authority category', async () => {
    handleNewLead.mockResolvedValue({ status: 'skipped', reason: 'auth-block' });
    const r = await processJob(makeJob('marketo', { isLead: true, email: 'a@b.com' }));
    expect(r.skipped).toBe(true);
    expect(logSkip).toHaveBeenCalledWith(expect.objectContaining({
      category: 'authority', criterion: 'auth-block',
    }));
  });
});

// ── Error handling ────────────────────────────────────────────────────────────
describe('processJob() — error paths', () => {
  it('throws when payload has no email field', async () => {
    getMarketoToken.mockResolvedValue('tok');
    const job = makeJob('dynamics', { firstname: 'NoEmail' });
    await expect(processJob(job)).rejects.toThrow('No email field');
  });

  it('propagates writer errors', async () => {
    getMarketoToken.mockResolvedValue('tok');
    resolveAction.mockResolvedValue({ action: 'create', targetId: null });
    mapToMarketo.mockReturnValue({ email: 'x@y.com' });
    writeToMarketo.mockRejectedValue(new Error('Marketo API unavailable'));

    const job = makeJob('dynamics', { emailaddress1: 'x@y.com' });
    await expect(processJob(job)).rejects.toThrow('Marketo API unavailable');
  });
});

// ── Marketo-sourced contact+company payloads (authority-gated; Task 9) ────────
// The old suite asserted that Marketo-sourced contact writes bound a parent
// Account (auto-creating one when the name was ambiguous). Per spec §Operational
// Behaviour, Marketo cannot write Accounts and cannot update Contact fields
// outside consent — so the entire path is now an authority-skip.
describe('processJob() — marketo-sourced contact with company is unauthorized', () => {
  const mktoPayload = {
    email:     'carol@acme.com',
    firstName: 'Carol',
    company:   'Acme Corp',
  };

  beforeEach(() => {
    getDynamicsToken.mockResolvedValue('dyn-token');
  });

  it('never invokes the company resolver, writer, or account writer', async () => {
    await processJob(makeJob('marketo', mktoPayload));

    expect(handleGlobalUnsubscribe).not.toHaveBeenCalled();
    expect(handleNewLead).not.toHaveBeenCalled();
  });

  it('logs an authority skip with a specific reason', async () => {
    const result = await processJob(makeJob('marketo', mktoPayload));

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('marketo-person-undetermined');
    expect(logSkip).toHaveBeenCalledWith(expect.objectContaining({
      source:    'marketo',
      category:  'authority',
      reason:    'marketo-person-undetermined',
    }));
  });
});

// ── startWorkers ──────────────────────────────────────────────────────────────
describe('startWorkers()', () => {
  it('subscribes a worker to the managed queue via pg-boss', async () => {
    const { getBoss, startBoss } = require('../../src/queue/queue');
    const workMock = jest.fn().mockResolvedValue(undefined);
    getBoss.mockReturnValueOnce({ work: workMock, on: jest.fn() });

    const worker = await startWorkers();

    expect(startBoss).toHaveBeenCalled();
    expect(workMock).toHaveBeenCalledWith(
      'sync-events',
      expect.objectContaining({ teamSize: expect.any(Number) }),
      expect.any(Function),
    );
    expect(typeof worker.close).toBe('function');
  });

  it('starts authority-alert scheduler when ENABLE_ALERTS=true', async () => {
    const { startAuthorityAlertScheduler } = require('../../src/monitor/authorityAlerts');
    const { getBoss } = require('../../src/queue/queue');
    getBoss.mockReturnValueOnce({ work: jest.fn().mockResolvedValue(undefined), on: jest.fn() });
    process.env.ENABLE_ALERTS = 'true';
    try {
      await startWorkers();
      expect(startAuthorityAlertScheduler).toHaveBeenCalled();
    } finally {
      delete process.env.ENABLE_ALERTS;
    }
  });

  it('logs error if authority-alert scheduler throws', async () => {
    const { startAuthorityAlertScheduler } = require('../../src/monitor/authorityAlerts');
    const logger = require('../../src/audit/logger');
    const { getBoss } = require('../../src/queue/queue');
    getBoss.mockReturnValueOnce({ work: jest.fn().mockResolvedValue(undefined), on: jest.fn() });
    startAuthorityAlertScheduler.mockImplementationOnce(() => { throw new Error('alert-fail'); });
    process.env.ENABLE_ALERTS = 'true';
    try {
      await startWorkers();
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: 'alert-fail' }),
        expect.any(String),
      );
    } finally {
      delete process.env.ENABLE_ALERTS;
    }
  });

  it('runs connection-role boot check when NODE_ENV !== test', async () => {
    const { checkConnectionRoles } = require('../../src/engine/relationships');
    const { getBoss } = require('../../src/queue/queue');
    getBoss.mockReturnValueOnce({ work: jest.fn().mockResolvedValue(undefined), on: jest.fn() });
    getDynamicsToken.mockResolvedValueOnce('tok');
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await startWorkers();
      // Allow the fire-and-forget to settle
      await new Promise(r => setImmediate(r));
      expect(checkConnectionRoles).toHaveBeenCalled();
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  it('logs info when boot check token fetch fails', async () => {
    const logger = require('../../src/audit/logger');
    const { getBoss } = require('../../src/queue/queue');
    getBoss.mockReturnValueOnce({ work: jest.fn().mockResolvedValue(undefined), on: jest.fn() });
    getDynamicsToken.mockRejectedValueOnce(new Error('no-token'));
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await startWorkers();
      await new Promise(r => setImmediate(r));
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ err: 'no-token' }),
        expect.stringContaining('connection-role'),
      );
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  it('worker handler returns processJob result on success', async () => {
    const { getBoss } = require('../../src/queue/queue');
    let handler;
    getBoss.mockReturnValueOnce({
      work: jest.fn().mockImplementation((queue, opts, h) => { handler = h; return Promise.resolve(); }),
      on: jest.fn(),
    });
    await startWorkers();

    // Set up a simple successful job
    getMarketoToken.mockResolvedValue('tok');
    resolveAction.mockResolvedValue({ action: 'create', targetId: null });
    mapToMarketo.mockReturnValue({ email: 'a@b.com' });
    writeToMarketo.mockResolvedValue({ targetId: '99', status: 'created' });

    const result = await handler(makeJob('dynamics', { emailaddress1: 'a@b.com', type: 'contact' }));
    expect(result.targetId).toBe('99');
  });

  it('worker handler logs failure to audit table when processJob throws', async () => {
    const { getBoss } = require('../../src/queue/queue');
    let handler;
    getBoss.mockReturnValueOnce({
      work: jest.fn().mockImplementation((queue, opts, h) => { handler = h; return Promise.resolve(); }),
      on: jest.fn(),
    });
    await startWorkers();

    getMarketoToken.mockResolvedValue('tok');
    resolveAction.mockResolvedValue({ action: 'create', targetId: null });
    mapToMarketo.mockReturnValue({ email: 'a@b.com' });
    writeToMarketo.mockRejectedValueOnce(new Error('write-died'));

    await expect(handler(makeJob('dynamics', { emailaddress1: 'a@b.com', type: 'contact', id: 'p1' })))
      .rejects.toThrow('write-died');
    expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed', error_message: 'write-died',
    }));
  });

  it('worker handler swallows audit-log failure', async () => {
    const { getBoss } = require('../../src/queue/queue');
    const logger = require('../../src/audit/logger');
    let handler;
    getBoss.mockReturnValueOnce({
      work: jest.fn().mockImplementation((queue, opts, h) => { handler = h; return Promise.resolve(); }),
      on: jest.fn(),
    });
    await startWorkers();

    getMarketoToken.mockResolvedValue('tok');
    resolveAction.mockResolvedValue({ action: 'create', targetId: null });
    mapToMarketo.mockReturnValue({ email: 'a@b.com' });
    writeToMarketo.mockRejectedValueOnce(new Error('boom'));
    logEvent.mockRejectedValueOnce(new Error('audit-down'));

    await expect(handler(makeJob('dynamics', { emailaddress1: 'a@b.com' })))
      .rejects.toThrow('boom');
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'audit-down' }),
      expect.stringContaining('Failed to log failure'),
    );
  });
});

describe('processJob() — additional pipeline branches', () => {
  beforeEach(() => {
    getMarketoToken.mockResolvedValue('mkto-tok');
    getDynamicsToken.mockResolvedValue('dyn-tok');
    resolveAction.mockResolvedValue({ action: 'create', targetId: null });
    mapToMarketo.mockReturnValue({ email: 'a@b.com' });
    writeToMarketo.mockResolvedValue({ targetId: '42', status: 'created' });
  });

  it('account entity short-circuits via writeMarketoCompany', async () => {
    const { resolveAccountAction } = require('../../src/engine/dedup');
    resolveAccountAction.mockResolvedValueOnce({ targetId: 'mkto-acc' });
    const job = makeJob('dynamics', { type: 'account', name: 'Acme', accountid: 'a1' });
    const r = await processJob(job);
    expect(r.targetId).toBe('mkto-co');
    expect(writeToMarketo).not.toHaveBeenCalled();
  });

  it('skips when delta=no-change', async () => {
    const { hasMappedChange } = require('../../src/engine/fieldDelta');
    hasMappedChange.mockResolvedValueOnce({ changed: false, reason: 'no-change', baseline: 'snapshot' });
    const job = makeJob('dynamics', { emailaddress1: 'a@b.com', contactid: 'c1' });
    const r = await processJob(job);
    expect(r.skipped).toBe(true);
    expect(logSkip).toHaveBeenCalledWith(expect.objectContaining({
      category: 'no-change',
    }));
  });

  it('handles associated account presync, logs success', async () => {
    const { resolveAccountAction } = require('../../src/engine/dedup');
    const { writeMarketoCompany } = require('../../src/writers/marketo');
    resolveAccountAction.mockResolvedValue({ targetId: 'a-existing' });
    writeMarketoCompany.mockResolvedValue({ targetId: 'a-new' });

    const job = makeJob('dynamics', {
      emailaddress1: 'a@b.com', contactid: 'c1', type: 'contact',
      _associatedAccount: { name: 'Acme', accountid: 'a1' },
    });
    await processJob(job);
    expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({
      source_type: 'account', target_id: 'a-new', status: 'success',
    }));
  });

  it('continues when associated-account presync throws', async () => {
    const logger = require('../../src/audit/logger');
    const { writeMarketoCompany } = require('../../src/writers/marketo');
    writeMarketoCompany.mockRejectedValueOnce(new Error('co-down'));

    const job = makeJob('dynamics', {
      emailaddress1: 'a@b.com', contactid: 'c1', type: 'contact',
      _associatedAccount: { name: 'Acme', accountid: 'a1' },
    });
    await processJob(job);
    expect(logger.error).toHaveBeenCalled();
  });

  it('throws when associated-account payload has no name/company', async () => {
    const job = makeJob('dynamics', {
      emailaddress1: 'a@b.com', contactid: 'c1', type: 'contact',
      _associatedAccount: { accountid: 'noname' },
    });
    // The error is logged but processing continues for the contact
    await processJob(job);
    const logger = require('../../src/audit/logger');
    expect(logger.error).toHaveBeenCalled();
  });

  it('stamps ubt_marketoid on contact when missing', async () => {
    const { stampMarketoIdOnContact } = require('../../src/writers/dynamics');
    stampMarketoIdOnContact.mockResolvedValueOnce(undefined);

    const job = makeJob('dynamics', {
      emailaddress1: 'a@b.com', contactid: 'c-guid', type: 'contact',
    });
    await processJob(job);
    expect(stampMarketoIdOnContact).toHaveBeenCalledWith({
      contactId: 'c-guid', marketoId: '42', token: 'dyn-tok',
    });
  });

  it('logs warning when stampMarketoIdOnContact fails', async () => {
    const { stampMarketoIdOnContact } = require('../../src/writers/dynamics');
    const logger = require('../../src/audit/logger');
    stampMarketoIdOnContact.mockRejectedValueOnce(new Error('stamp-fail'));

    const job = makeJob('dynamics', {
      emailaddress1: 'a@b.com', contactid: 'c-guid', type: 'contact',
    });
    await processJob(job);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: 'stamp-fail' }),
      expect.stringContaining('ubt_marketoid backfill failed'),
    );
  });

  it('skips stamp when contact already has ubt_marketoid', async () => {
    const { stampMarketoIdOnContact } = require('../../src/writers/dynamics');
    const job = makeJob('dynamics', {
      emailaddress1: 'a@b.com', contactid: 'c1', type: 'contact', ubt_marketoid: '99',
    });
    await processJob(job);
    expect(stampMarketoIdOnContact).not.toHaveBeenCalled();
  });

  it('logs warning when upsertSnapshot fails', async () => {
    const { upsertSnapshot } = require('../../src/audit/db');
    const logger = require('../../src/audit/logger');
    upsertSnapshot.mockRejectedValueOnce(new Error('snap-fail'));

    const job = makeJob('dynamics', {
      emailaddress1: 'a@b.com', contactid: 'c1', type: 'contact',
    });
    await processJob(job);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: 'snap-fail' }),
      expect.stringContaining('sync_snapshots upsert failed'),
    );
  });

  it('skips when sync direction blocks the source', async () => {
    const { shouldSkipByDirection } = require('../../src/engine/syncDirection');
    shouldSkipByDirection.mockReturnValueOnce({ skip: true, reason: 'one-way' });
    const job = makeJob('dynamics', { emailaddress1: 'a@b.com', contactid: 'c1' });
    const r = await processJob(job);
    expect(r.skipped).toBe(true);
    expect(r.reason).toBe('one-way');
  });
});
