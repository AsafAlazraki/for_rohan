'use strict';

/**
 * Unit tests for src/engagement/activityFilter.js — covers all 6 type rules
 * + Web Visit allowlist edge cases + per-batch dedup.
 *
 * The filter accepts an injectable db helper, so no mocking is needed beyond
 * a plain object with the relevant query stubs.
 */

const { filterActivities } = require('../../src/engagement/activityFilter');

function makeDb({
  hasEmailOpen = false, hasEmailClick = false, hasCampaignResponse = false,
  recentWebVisits = 0,
} = {}) {
  return {
    hasEmailOpen:        jest.fn(async () => hasEmailOpen),
    hasEmailClick:       jest.fn(async () => hasEmailClick),
    hasCampaignResponse: jest.fn(async () => hasCampaignResponse),
    countRecentWebVisits: jest.fn(async () => recentWebVisits),
  };
}

function activity(over) {
  return {
    id: 1, leadId: 100, activityTypeId: 7,
    primaryAttributeValue: 'Some Email',
    activityDate: '2026-04-18T10:00:00Z',
    attributes: [],
    ...over,
  };
}

describe('Email Delivered (7)', () => {
  test('allows all', async () => {
    const acts = [activity({ id: 1, activityTypeId: 7 }), activity({ id: 2, activityTypeId: 7 })];
    const out  = await filterActivities(acts, { db: makeDb() });
    expect(out.toWrite).toHaveLength(2);
    expect(out.toSkip).toHaveLength(0);
  });
});

describe('Form Submit (2)', () => {
  test('allows all', async () => {
    const acts = [activity({ id: 1, activityTypeId: 2 })];
    const out  = await filterActivities(acts, { db: makeDb() });
    expect(out.toWrite).toHaveLength(1);
  });
});

describe('Email Open (10)', () => {
  test('writes a single open per (leadId, asset)', async () => {
    const acts = [activity({ id: 1, activityTypeId: 10 })];
    const db   = makeDb({ hasEmailOpen: false });
    const out  = await filterActivities(acts, { db });
    expect(out.toWrite).toHaveLength(1);
    expect(db.hasEmailOpen).toHaveBeenCalledWith(100, 'Some Email');
  });

  test('skips when one already exists for the (leadId, asset)', async () => {
    const acts = [activity({ id: 1, activityTypeId: 10 })];
    const db   = makeDb({ hasEmailOpen: true });
    const out  = await filterActivities(acts, { db });
    expect(out.toWrite).toHaveLength(0);
    expect(out.toSkip[0].reason).toMatch(/duplicate Email Open/);
  });

  test('dedups within a single batch', async () => {
    const acts = [
      activity({ id: 1, activityTypeId: 10 }),
      activity({ id: 2, activityTypeId: 10 }),
    ];
    const db   = makeDb({ hasEmailOpen: false });
    const out  = await filterActivities(acts, { db });
    expect(out.toWrite).toHaveLength(1);
    expect(out.toSkip).toHaveLength(1);
  });
});

describe('Email Click (9)', () => {
  test('one per (leadId, asset, link) — different links pass', async () => {
    const acts = [
      activity({ id: 1, activityTypeId: 9, attributes: [{ name: 'Link', value: 'https://a' }] }),
      activity({ id: 2, activityTypeId: 9, attributes: [{ name: 'Link', value: 'https://b' }] }),
    ];
    const out = await filterActivities(acts, { db: makeDb() });
    expect(out.toWrite).toHaveLength(2);
  });

  test('skips when same (leadId, asset, link) already recorded', async () => {
    const acts = [activity({ id: 1, activityTypeId: 9, attributes: [{ name: 'Link', value: 'https://a' }] })];
    const out = await filterActivities(acts, { db: makeDb({ hasEmailClick: true }) });
    expect(out.toWrite).toHaveLength(0);
    expect(out.toSkip[0].reason).toMatch(/duplicate Email Click/);
  });
});

describe('Web Visit (1) — allow-list', () => {
  test('empty allowlist allows everything (still subject to 5/day cap)', async () => {
    const acts = [activity({
      id: 1, activityTypeId: 1, primaryAttributeValue: '/some-page',
      attributes: [{ name: 'Webpage URL', value: 'https://example.com/random' }],
    })];
    const out = await filterActivities(acts, {
      db: makeDb({ recentWebVisits: 0 }),
      webVisitKeyUrls: '',
    });
    expect(out.toWrite).toHaveLength(1);
  });

  test('populated allowlist filters non-matching urls', async () => {
    const acts = [
      activity({ id: 1, activityTypeId: 1, attributes: [{ name: 'Webpage URL', value: 'https://example.com/pricing' }] }),
      activity({ id: 2, activityTypeId: 1, attributes: [{ name: 'Webpage URL', value: 'https://example.com/blog' }] }),
    ];
    const out = await filterActivities(acts, {
      db: makeDb({ recentWebVisits: 0 }),
      webVisitKeyUrls: 'pricing,demo',
    });
    expect(out.toWrite).toHaveLength(1);
    expect(out.toSkip[0].reason).toMatch(/allow-list/);
  });
});

describe('Web Visit (1) — 5/day cap', () => {
  test('blocks once historical+batch >= 5', async () => {
    const acts = [
      activity({ id: 10, activityTypeId: 1, attributes: [{ name: 'Webpage URL', value: 'https://x/a' }] }),
      activity({ id: 11, activityTypeId: 1, attributes: [{ name: 'Webpage URL', value: 'https://x/b' }] }),
    ];
    const out = await filterActivities(acts, {
      db: makeDb({ recentWebVisits: 4 }),
      webVisitKeyUrls: '',
    });
    expect(out.toWrite).toHaveLength(1);    // 4 + 1 = 5 OK; the 2nd hits cap
    expect(out.toSkip).toHaveLength(1);
    expect(out.toSkip[0].reason).toMatch(/web visit cap/);
  });
});

describe('Campaign Response (14)', () => {
  test('allows distinct (leadId, program, status) combos', async () => {
    const acts = [
      activity({
        id: 30, activityTypeId: 14, primaryAttributeValue: 'Spring Webinar',
        attributes: [{ name: 'New Status', value: 'Registered' }],
      }),
      activity({
        id: 31, activityTypeId: 14, primaryAttributeValue: 'Spring Webinar',
        attributes: [{ name: 'New Status', value: 'Attended' }],
      }),
    ];
    const out = await filterActivities(acts, { db: makeDb() });
    expect(out.toWrite).toHaveLength(2);
  });

  test('dedups identical (leadId, program, status)', async () => {
    const acts = [
      activity({
        id: 30, activityTypeId: 14, primaryAttributeValue: 'Spring Webinar',
        attributes: [{ name: 'New Status', value: 'Attended' }],
      }),
      activity({
        id: 31, activityTypeId: 14, primaryAttributeValue: 'Spring Webinar',
        attributes: [{ name: 'New Status', value: 'Attended' }],
      }),
    ];
    const out = await filterActivities(acts, { db: makeDb() });
    expect(out.toWrite).toHaveLength(1);
    expect(out.toSkip).toHaveLength(1);
  });

  test('checks the dedup table when nothing matched in-batch', async () => {
    const acts = [activity({
      id: 30, activityTypeId: 14, primaryAttributeValue: 'P',
      attributes: [{ name: 'New Status', value: 'Won' }],
    })];
    const db = makeDb({ hasCampaignResponse: true });
    const out = await filterActivities(acts, { db });
    expect(out.toWrite).toHaveLength(0);
    expect(db.hasCampaignResponse).toHaveBeenCalledWith(100, 'P', 'Won');
  });
});
