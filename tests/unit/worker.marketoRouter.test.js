'use strict';

// Standalone router test: asserts the three Marketo-source branches dispatch
// correctly and that writeDynamicsAccount is NEVER called on any Marketo job.
// Writers are spy-mocked so any invocation is visible.

jest.mock('../../src/engine/loopGuard',       () => ({ shouldSkip: jest.fn(() => ({ skip: false })) }));
jest.mock('../../src/engine/syncDirection',   () => ({
  getSyncDirection:     jest.fn().mockResolvedValue('bidirectional'),
  shouldSkipByDirection: jest.fn(() => ({ skip: false })),
}));
jest.mock('../../src/engine/dedup',           () => ({
  resolveAction:        jest.fn(),
  resolveAccountAction: jest.fn(),
}));
jest.mock('../../src/engine/fieldMapper',     () => ({
  mapToMarketo: jest.fn(),
}));
jest.mock('../../src/engine/derivedFields',   () => ({
  enrichDerived: jest.fn((mapped) => Promise.resolve(mapped)),
}));
jest.mock('../../src/writers/marketo',        () => ({
  writeToMarketo:      jest.fn(),
  writeMarketoCompany: jest.fn(),
}));
jest.mock('../../src/writers/dynamics',       () => ({
  stampMarketoIdOnContact: jest.fn(),
}));
jest.mock('../../src/audit/db',               () => ({
  logEvent:       jest.fn().mockResolvedValue({ id: 'x' }),
  logSkip:        jest.fn().mockResolvedValue({ id: 'x-skip' }),
  loadSnapshot:   jest.fn().mockResolvedValue(null),
  upsertSnapshot: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../src/audit/logger',           () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../../src/auth/dynamics',          () => ({ getDynamicsToken: jest.fn().mockResolvedValue('dyn-token') }));
jest.mock('../../src/auth/marketo',           () => ({ getMarketoToken:  jest.fn().mockResolvedValue('mkto-token') }));
jest.mock('../../src/queue/queue',            () => ({
  QUEUE_NAME: 'sync-events',
  getBoss:    jest.fn(),
  startBoss:  jest.fn(),
}));
jest.mock('../../src/engine/handlers/unsubscribe', () => ({
  handleGlobalUnsubscribe: jest.fn(),
}));
jest.mock('../../src/engine/handlers/newLead', () => ({
  handleNewLead: jest.fn(),
}));

const { writeToMarketo, writeMarketoCompany }   = require('../../src/writers/marketo');
const { handleGlobalUnsubscribe }               = require('../../src/engine/handlers/unsubscribe');
const { handleNewLead }                         = require('../../src/engine/handlers/newLead');
const { resolveAccountAction }                  = require('../../src/engine/dedup');
const { processJob }                            = require('../../src/queue/worker');

function marketoJob(payload, id = 'job-x') {
  return { id, data: { source: 'marketo', payload } };
}

beforeEach(() => jest.clearAllMocks());

describe('worker — Marketo-source router branches', () => {
  it('GLOBAL_UNSUBSCRIBE branch routes to handleGlobalUnsubscribe only', async () => {
    handleGlobalUnsubscribe.mockResolvedValue({ status: 'success', targetId: 'c1' });

    await processJob(marketoJob({ unsubscribed: true, email: 'a@b.com', crmContactId: 'C1' }));

    expect(handleGlobalUnsubscribe).toHaveBeenCalledTimes(1);
    expect(handleNewLead).not.toHaveBeenCalled();
  });

  it('NEW_LEAD branch routes to handleNewLead only', async () => {
    handleNewLead.mockResolvedValue({ status: 'success', targetId: 'l1' });

    await processJob(marketoJob({ isLead: true, email: 'new@acme.com', company: 'Acme' }));

    expect(handleNewLead).toHaveBeenCalledTimes(1);
    expect(handleGlobalUnsubscribe).not.toHaveBeenCalled();
  });

  it('UNAUTHORIZED branch invokes neither handler', async () => {
    await processJob(marketoJob({ crmLeadId: 'L1', email: 'x@y.com' }));

    expect(handleGlobalUnsubscribe).not.toHaveBeenCalled();
    expect(handleNewLead).not.toHaveBeenCalled();
  });

  it('no writer or Marketo-side resolver is called on any Marketo-sourced job', async () => {
    handleGlobalUnsubscribe.mockResolvedValue({ status: 'success', targetId: 'c' });
    handleNewLead.mockResolvedValue({ status: 'success', targetId: 'l' });

    const fixtures = [
      { unsubscribed: true, email: 'a@b.com', crmContactId: 'C' },  // unsub
      { isLead: true, email: 'n@l.com', company: 'Acme' },          // new lead
      { crmLeadId: 'L', email: 'x@y.com' },                         // unauthorized
      { type: 'account', name: 'Acme' },                            // explicit account
      { email: 'nobody@anon.com' },                                 // undetermined
    ];

    for (const payload of fixtures) {
      await processJob(marketoJob(payload));
    }

    // Generic Dynamics→Marketo writers must never run for Marketo-source jobs.
    expect(writeToMarketo).not.toHaveBeenCalled();
    expect(writeMarketoCompany).not.toHaveBeenCalled();
    expect(resolveAccountAction).not.toHaveBeenCalled();
  });
});
