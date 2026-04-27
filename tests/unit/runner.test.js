'use strict';

jest.mock('../../src/audit/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(),
}));

jest.mock('../../src/config/loader', () => ({
  getConfig: jest.fn(),
  setConfig: jest.fn(),
}));

jest.mock('../../src/auth/marketo', () => ({ getMarketoToken: jest.fn() }));
jest.mock('../../src/auth/dynamics', () => ({ getDynamicsToken: jest.fn() }));

jest.mock('../../src/engine/dedup', () => ({ resolveAction: jest.fn() }));

jest.mock('../../src/events/bus', () => ({ emitSync: jest.fn() }));

jest.mock('../../src/engagement/cursor', () => ({
  getCursor: jest.fn(),
  setCursor: jest.fn(),
}));

jest.mock('../../src/engagement/marketoActivities', () => ({
  getPagingToken:  jest.fn(),
  getActivityTypes: jest.fn(),
  fetchActivities: jest.fn(),
  fetchLeadEmails: jest.fn(),
}));

jest.mock('../../src/engagement/activityWriter', () => ({
  writeEngagementActivity: jest.fn(),
  TYPE_LABELS: { 1: 'Web Visit', 9: 'Email Click' },
}));

jest.mock('../../src/engagement/activityFilter', () => ({
  filterActivities: jest.fn(),
}));

jest.mock('../../src/engagement/dedupDb', () => ({
  insertDedup: jest.fn(),
}));

const { getConfig, setConfig } = require('../../src/config/loader');
const { getMarketoToken } = require('../../src/auth/marketo');
const { getDynamicsToken } = require('../../src/auth/dynamics');
const { resolveAction } = require('../../src/engine/dedup');
const { emitSync } = require('../../src/events/bus');
const cursor = require('../../src/engagement/cursor');
const acts = require('../../src/engagement/marketoActivities');
const writer = require('../../src/engagement/activityWriter');
const filter = require('../../src/engagement/activityFilter');
const dedupDb = require('../../src/engagement/dedupDb');
const runner = require('../../src/engagement/runner');

beforeEach(() => {
  jest.resetAllMocks();
  acts.getActivityTypes.mockResolvedValue([
    { id: 1 }, { id: 2 }, { id: 7 }, { id: 9 }, { id: 10 }, { id: 14 },
  ]);
  getMarketoToken.mockResolvedValue('mkto-tok');
  getDynamicsToken.mockResolvedValue('dyn-tok');
  cursor.getCursor.mockResolvedValue('cursor-1');
  cursor.setCursor.mockResolvedValue();
  setConfig.mockResolvedValue();
  getConfig.mockResolvedValue(null);
  filter.filterActivities.mockResolvedValue({ toWrite: [], toSkip: [] });
  acts.fetchLeadEmails.mockResolvedValue([]);
  dedupDb.insertDedup.mockResolvedValue();
});

describe('runner.runOnce — early exits', () => {
  it('returns 0 fetched when no activities found, advances cursor', async () => {
    acts.fetchActivities.mockResolvedValueOnce({
      success: true, result: [], moreResult: false, nextPageToken: 'tok-2',
    });
    const r = await runner.runOnce();
    expect(r.fetched).toBe(0);
    expect(cursor.setCursor).toHaveBeenCalledWith('tok-2');
    expect(setConfig).toHaveBeenCalled();
  });

  it('initialises paging token when no cursor exists', async () => {
    cursor.getCursor.mockResolvedValueOnce(null);
    acts.getPagingToken.mockResolvedValueOnce({ nextPageToken: 'init-tok' });
    acts.fetchActivities.mockResolvedValueOnce({ success: true, result: [], moreResult: false, nextPageToken: null });

    await runner.runOnce();
    expect(acts.getPagingToken).toHaveBeenCalled();
    expect(acts.fetchActivities).toHaveBeenCalledWith(expect.objectContaining({ nextPageToken: 'init-tok' }));
  });

  it('uses lookback hours from config for paging-token init', async () => {
    cursor.getCursor.mockResolvedValueOnce(null);
    getConfig.mockImplementation((k) => k === 'MARKETO_INGEST_LOOKBACK_HOURS' ? '6' : null);
    acts.getPagingToken.mockResolvedValueOnce({ nextPageToken: 'init' });
    acts.fetchActivities.mockResolvedValueOnce({ success: true, result: [], moreResult: false, nextPageToken: null });

    await runner.runOnce();
    expect(acts.getPagingToken).toHaveBeenCalled();
  });

  it('returns early if no supported activity types exist on instance', async () => {
    acts.getActivityTypes.mockResolvedValueOnce([]);
    const r = await runner.runOnce();
    expect(r.fetched).toBe(0);
    expect(acts.fetchActivities).not.toHaveBeenCalled();
  });

  it('logs warning when some types missing', async () => {
    acts.getActivityTypes.mockResolvedValueOnce([{ id: 1 }, { id: 2 }]);
    acts.fetchActivities.mockResolvedValueOnce({ success: true, result: [], moreResult: false, nextPageToken: null });
    await runner.runOnce();
    // expect a warn — runner uses logger.warn on missing types
    const logger = require('../../src/audit/logger');
    expect(logger.warn).toHaveBeenCalled();
  });

  it('throws and persists summary when Marketo auth fails', async () => {
    getMarketoToken.mockRejectedValueOnce(new Error('mkto-down'));
    await expect(runner.runOnce()).rejects.toThrow('mkto-down');
    expect(setConfig).toHaveBeenCalled();
  });

  it('throws when fetchActivities returns success=false', async () => {
    acts.fetchActivities.mockResolvedValueOnce({ success: false, errors: [{ code: 'X' }] });
    await expect(runner.runOnce()).rejects.toThrow(/fetchActivities failed/);
  });
});

describe('runner.runOnce — write paths', () => {
  function activity(id, opts = {}) {
    return {
      id,
      activityTypeId: opts.type || 1,
      leadId: opts.leadId || 100,
      primaryAttributeValue: opts.asset || 'home',
      activityDate: '2026-01-01',
      attributes: opts.attributes || [],
    };
  }

  it('writes a successful activity end-to-end', async () => {
    const a = activity(7001, { type: 9, leadId: 200, attributes: [{ name: 'Link', value: '/x' }] });
    acts.fetchActivities.mockResolvedValueOnce({
      success: true, result: [a], moreResult: false, nextPageToken: 'tok-2',
    });
    acts.fetchLeadEmails.mockResolvedValueOnce([{ id: 200, email: 'a@b.com' }]);
    filter.filterActivities.mockResolvedValueOnce({ toWrite: [a], toSkip: [] });
    resolveAction.mockResolvedValueOnce({ targetId: 'contact-guid' });
    writer.writeEngagementActivity.mockResolvedValueOnce({ activityId: 'eng-1' });

    const r = await runner.runOnce();
    expect(r.written).toBe(1);
    expect(dedupDb.insertDedup).toHaveBeenCalledWith(expect.objectContaining({
      filterDecision: 'written', dynamicsEngagementActivityId: 'eng-1',
    }));
    expect(emitSync).toHaveBeenCalledWith(expect.objectContaining({ status: 'success' }));
  });

  it('counts campaign-response status into filterReason', async () => {
    const a = activity(7002, { type: 14, attributes: [{ name: 'New Status', value: 'opened' }] });
    acts.fetchActivities.mockResolvedValueOnce({ success: true, result: [a], moreResult: false, nextPageToken: 't' });
    acts.fetchLeadEmails.mockResolvedValueOnce([{ id: 100, email: 'c@b.com' }]);
    filter.filterActivities.mockResolvedValueOnce({ toWrite: [a], toSkip: [] });
    resolveAction.mockResolvedValueOnce({ targetId: 'c-1' });
    writer.writeEngagementActivity.mockResolvedValueOnce({ activityId: 'e1' });

    await runner.runOnce();
    expect(dedupDb.insertDedup).toHaveBeenCalledWith(expect.objectContaining({
      filterReason: 'status:opened',
    }));
  });

  it('counts skipped activities and inserts dedup row', async () => {
    const a = activity(7003, { type: 1 });
    acts.fetchActivities.mockResolvedValueOnce({ success: true, result: [a], moreResult: false, nextPageToken: 't' });
    filter.filterActivities.mockResolvedValueOnce({ toWrite: [], toSkip: [{ activity: a, reason: 'cap' }] });

    const r = await runner.runOnce();
    expect(r.skipped).toBe(1);
    expect(dedupDb.insertDedup).toHaveBeenCalledWith(expect.objectContaining({
      filterDecision: 'skipped',
    }));
    expect(emitSync).toHaveBeenCalledWith(expect.objectContaining({ status: 'skipped' }));
  });

  it('handles activities with no email match (unmatched)', async () => {
    const a = activity(7004, { leadId: 999 });
    acts.fetchActivities.mockResolvedValueOnce({ success: true, result: [a], moreResult: false, nextPageToken: 't' });
    acts.fetchLeadEmails.mockResolvedValueOnce([]); // no emails
    filter.filterActivities.mockResolvedValueOnce({ toWrite: [a], toSkip: [] });

    const r = await runner.runOnce();
    expect(r.unmatched).toBe(1);
    expect(dedupDb.insertDedup).toHaveBeenCalledWith(expect.objectContaining({
      filterDecision: 'unmatched',
      filterReason:   'no email returned by Marketo for leadId',
    }));
    expect(getDynamicsToken).toHaveBeenCalled();
  });

  it('handles dynamics resolveAction failure as unmatched', async () => {
    const a = activity(7005);
    acts.fetchActivities.mockResolvedValueOnce({ success: true, result: [a], moreResult: false, nextPageToken: 't' });
    acts.fetchLeadEmails.mockResolvedValueOnce([{ id: 100, email: 'a@b.com' }]);
    filter.filterActivities.mockResolvedValueOnce({ toWrite: [a], toSkip: [] });
    resolveAction.mockRejectedValueOnce(new Error('dyn-down'));

    const r = await runner.runOnce();
    expect(r.unmatched).toBe(1);
    expect(emitSync).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed', error: 'dyn-down',
    }));
  });

  it('handles missing Dynamics contact as unmatched', async () => {
    const a = activity(7006);
    acts.fetchActivities.mockResolvedValueOnce({ success: true, result: [a], moreResult: false, nextPageToken: 't' });
    acts.fetchLeadEmails.mockResolvedValueOnce([{ id: 100, email: 'a@b.com' }]);
    filter.filterActivities.mockResolvedValueOnce({ toWrite: [a], toSkip: [] });
    resolveAction.mockResolvedValueOnce({ targetId: null });

    const r = await runner.runOnce();
    expect(r.unmatched).toBe(1);
  });

  it('handles writer failure (count failed, no dedup row)', async () => {
    const a = activity(7007);
    acts.fetchActivities.mockResolvedValueOnce({ success: true, result: [a], moreResult: false, nextPageToken: 't' });
    acts.fetchLeadEmails.mockResolvedValueOnce([{ id: 100, email: 'a@b.com' }]);
    filter.filterActivities.mockResolvedValueOnce({ toWrite: [a], toSkip: [] });
    resolveAction.mockResolvedValueOnce({ targetId: 'c1' });
    writer.writeEngagementActivity.mockRejectedValueOnce(new Error('write-fail'));

    const r = await runner.runOnce();
    expect(r.failed).toBe(1);
    expect(emitSync).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', error: 'write-fail' }));
    // dedup insert called once for the failed write? No — runner skips dedup for failed writes
    expect(dedupDb.insertDedup).not.toHaveBeenCalledWith(expect.objectContaining({
      filterDecision: 'written',
    }));
  });

  it('throws when fetchLeadEmails fails', async () => {
    const a = activity(7008);
    acts.fetchActivities.mockResolvedValueOnce({ success: true, result: [a], moreResult: false, nextPageToken: 't' });
    acts.fetchLeadEmails.mockRejectedValueOnce(new Error('lead-down'));
    await expect(runner.runOnce()).rejects.toThrow('lead-down');
  });

  it('throws when Dynamics auth fails before write loop', async () => {
    const a = activity(7009);
    acts.fetchActivities.mockResolvedValueOnce({ success: true, result: [a], moreResult: false, nextPageToken: 't' });
    acts.fetchLeadEmails.mockResolvedValueOnce([{ id: 100, email: 'a@b.com' }]);
    filter.filterActivities.mockResolvedValueOnce({ toWrite: [a], toSkip: [] });
    getDynamicsToken.mockRejectedValueOnce(new Error('dyn-auth-fail'));
    await expect(runner.runOnce()).rejects.toThrow('dyn-auth-fail');
  });
});

describe('runner.runOnce — dryRun mode', () => {
  it('does not write or advance cursor; returns samples', async () => {
    const a = {
      id: 8001, activityTypeId: 1, leadId: 100,
      primaryAttributeValue: 'home', activityDate: '2026-01-01',
      attributes: [],
    };
    acts.fetchActivities.mockResolvedValueOnce({ success: true, result: [a], moreResult: false, nextPageToken: 't' });
    acts.fetchLeadEmails.mockResolvedValueOnce([{ id: 100, email: 'a@b.com' }]);
    filter.filterActivities.mockResolvedValueOnce({
      toWrite: [a],
      toSkip:  [{ activity: { ...a, id: 8002 }, reason: 'too-many' }],
    });
    resolveAction.mockResolvedValueOnce({ targetId: 'c1' });

    const r = await runner.runOnce({ dryRun: true });
    expect(r.written).toBe(0);
    expect(r.samples).toBeInstanceOf(Array);
    expect(r.samples.length).toBeGreaterThan(0);
    expect(cursor.setCursor).not.toHaveBeenCalled();
    expect(writer.writeEngagementActivity).not.toHaveBeenCalled();
    expect(dedupDb.insertDedup).not.toHaveBeenCalled();
    expect(emitSync).toHaveBeenCalledWith(expect.objectContaining({ status: 'preview' }));
  });

  it('does not advance cursor when fetched=0', async () => {
    acts.fetchActivities.mockResolvedValueOnce({ success: true, result: [], moreResult: false, nextPageToken: 't' });
    const r = await runner.runOnce({ dryRun: true });
    expect(r.fetched).toBe(0);
    expect(r.samples).toEqual([]);
    expect(cursor.setCursor).not.toHaveBeenCalled();
  });

  it('caps samples at DRY_RUN_SAMPLE_CAP', async () => {
    const many = [];
    for (let i = 0; i < 30; i++) {
      many.push({
        id: 9000 + i, activityTypeId: 1, leadId: 100 + i,
        primaryAttributeValue: 'p', activityDate: '2026-01-01', attributes: [],
      });
    }
    acts.fetchActivities.mockResolvedValueOnce({ success: true, result: many, moreResult: false, nextPageToken: 't' });
    acts.fetchLeadEmails.mockResolvedValueOnce(many.map(m => ({ id: m.leadId, email: `a${m.id}@b.com` })));
    filter.filterActivities.mockResolvedValueOnce({ toWrite: many, toSkip: [] });
    resolveAction.mockResolvedValue({ targetId: 'c' });

    const r = await runner.runOnce({ dryRun: true });
    expect(r.samples.length).toBe(20);
  });
});

describe('runner — _getUrlAttr / _getStatusAttr helpers', () => {
  it('extracts Link attribute', () => {
    const a = { attributes: [{ name: 'Link', value: '/u' }] };
    expect(runner._getUrlAttr(a)).toBe('/u');
  });

  it('falls back to Webpage URL attribute', () => {
    const a = { attributes: [{ name: 'Webpage URL', value: '/p' }] };
    expect(runner._getUrlAttr(a)).toBe('/p');
  });

  it('returns null when no url attrs', () => {
    expect(runner._getUrlAttr({ attributes: [{ name: 'Other' }] })).toBeNull();
    expect(runner._getUrlAttr({})).toBeNull();
  });

  it('extracts New Status / Success / Reason attributes', () => {
    expect(runner._getStatusAttr({ attributes: [{ name: 'New Status', value: 'open' }] })).toBe('open');
    expect(runner._getStatusAttr({ attributes: [{ name: 'Success', value: true }] })).toBe(true);
    expect(runner._getStatusAttr({ attributes: [{ name: 'Reason', value: 'r' }] })).toBe('r');
    expect(runner._getStatusAttr({ attributes: [] })).toBe('');
    expect(runner._getStatusAttr({})).toBe('');
  });
});

describe('runner — paging cap', () => {
  it('stops after MAX_ACTIVITIES_PER_RUN', async () => {
    // Generate exactly MAX activities across multiple pages
    const huge = Array.from({ length: runner.MAX_ACTIVITIES_PER_RUN + 50 }, (_, i) => ({
      id: i + 1, activityTypeId: 1, leadId: 1, primaryAttributeValue: '', activityDate: null, attributes: [],
    }));
    acts.fetchActivities.mockResolvedValueOnce({
      success: true, result: huge, moreResult: true, nextPageToken: 't2',
    });
    filter.filterActivities.mockResolvedValueOnce({ toWrite: [], toSkip: [] });
    acts.fetchLeadEmails.mockResolvedValueOnce([]);

    const r = await runner.runOnce();
    expect(r.fetched).toBe(runner.MAX_ACTIVITIES_PER_RUN);
  });

  it('continues paging while moreResult=true and under cap', async () => {
    acts.fetchActivities
      .mockResolvedValueOnce({ success: true, result: [], moreResult: true,  nextPageToken: 't2' })
      .mockResolvedValueOnce({ success: true, result: [], moreResult: false, nextPageToken: 't3' });
    await runner.runOnce();
    expect(acts.fetchActivities).toHaveBeenCalledTimes(2);
  });
});

describe('runner — emit failure resilience', () => {
  it('does not crash when emitSync throws', async () => {
    emitSync.mockImplementationOnce(() => { throw new Error('bus-fail'); });
    acts.fetchActivities.mockResolvedValueOnce({ success: true, result: [], moreResult: false, nextPageToken: 't' });
    await expect(runner.runOnce()).resolves.toBeDefined();
  });

  it('does not crash when dedupDb.insertDedup throws (skipped path)', async () => {
    dedupDb.insertDedup.mockRejectedValueOnce(new Error('db-fail'));
    const a = { id: 1, activityTypeId: 1, leadId: 100, primaryAttributeValue: '', activityDate: null, attributes: [] };
    acts.fetchActivities.mockResolvedValueOnce({ success: true, result: [a], moreResult: false, nextPageToken: 't' });
    filter.filterActivities.mockResolvedValueOnce({ toWrite: [], toSkip: [{ activity: a, reason: 'r' }] });

    const r = await runner.runOnce();
    expect(r.skipped).toBe(1);
  });
});
