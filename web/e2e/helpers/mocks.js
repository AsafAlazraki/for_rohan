// Shared API mock factory. Each spec calls setupApiMocks(page, overrides)
// before page.goto so every endpoint the React app touches has a deterministic,
// no-network response. Overrides shallow-merge into defaults so individual
// specs only declare what they actually care about.
//
// Convention: every override value is a function that receives the Playwright
// `route` and `request` so specs can both inspect what the UI sent AND choose
// the response. If a value is a plain object, it's auto-wrapped as JSON 200.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIELDMAP_PATH = path.resolve(__dirname, '../../../src/config/fieldmap.json');

let cachedFieldmap = null;
function readFieldmap() {
  if (cachedFieldmap) return cachedFieldmap;
  cachedFieldmap = JSON.parse(fs.readFileSync(FIELDMAP_PATH, 'utf8'));
  return cachedFieldmap;
}

// ── default fixture data ──────────────────────────────────────────────────
const DEFAULT_CONFIG = [
  { key: 'DYN_TENANT_ID',    group: 'Dynamics', is_secret: false, value: 'tenant-abc',          set: true,  source: 'env', updated_at: '2026-04-17T10:00:00Z' },
  { key: 'DYN_CLIENT_SECRET',group: 'Dynamics', is_secret: true,  value: '••••••••1234',         set: true,  source: 'db',  updated_at: '2026-04-17T10:05:00Z' },
  { key: 'MKT_CLIENT_ID',    group: 'Marketo',  is_secret: false, value: 'mkt-client-xyz',       set: true,  source: 'db',  updated_at: '2026-04-17T10:10:00Z' },
  { key: 'MKT_CLIENT_SECRET',group: 'Marketo',  is_secret: true,  value: '',                     set: false, source: 'db',  updated_at: null },
  { key: 'SYNC_CONCURRENCY', group: 'Runtime',  is_secret: false, value: '5',                    set: true,  source: 'env', updated_at: '2026-04-17T09:00:00Z' },
];

const DEFAULT_EVENTS = { rows: [], total: 0, page: 1 };


const DEFAULT_PULL = {
  dynamics: { rows: [], nextCursor: null },
  marketo:  { rows: [], nextCursor: null },
};

const DEFAULT_TRANSFER = {
  enqueued: { dynamics: 0, marketo: 0 },
  jobs: [],
  errors: [],
};

const DEFAULT_DRY_RUN = {
  dryRun: true,
  listName: 'Default List',
  members: [],
  droppedNoName: 0,
  note: null,
};

const DEFAULT_LIST_SYNC = {
  listName: 'Default List',
  listId: null,
  upserted: [],
  addedToList: [],
};

const DEFAULT_TRIGGER = { source: 'dynamics', entity: 'contact', created: [] };

const DEFAULT_ENGAGEMENT_RECENT = { rows: [] };
const DEFAULT_ENGAGEMENT_STATS = {
  totalIngested: 0,
  byType: {},
  byStatus: {},
  lastRun: null,
};
const DEFAULT_ENGAGEMENT_TRIGGER = {
  ok: true,
  summary: { fetched: 0, written: 0, skipped: 0, unmatched: 0, durationMs: 0 },
};

// Wrap a plain-object response into a function with sensible JSON 200 defaults.
function asHandler(resp) {
  if (typeof resp === 'function') return resp;
  return async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(resp),
    });
  };
}

/**
 * Install network mocks for every endpoint the SPA touches.
 *
 * @param {import('@playwright/test').Page} page
 * @param {Object} overrides — keyed by endpoint shorthand
 *   - config:               GET  /api/config
 *   - configSave:           POST /api/config
 *   - events:               GET  /api/events

 *   - fieldmap:             GET  /api/fieldmap (defaults to live fieldmap.json)
 *   - simulatePull:         GET  /api/simulate/pull
 *   - simulateTransfer:     POST /api/simulate/transfer
 *   - accountListDryRun:    POST /api/account-list/dry-run
 *   - accountListSync:      POST /api/account-list/sync
 *   - trigger:              POST /api/trigger
 *   - engagementRecent:     GET  /api/engagement/recent
 *   - engagementStats:      GET  /api/engagement/stats
 *   - engagementTrigger:    POST /api/engagement/trigger
 *   - engagementDryRun:     POST /api/engagement/dry-run (404 by default)
 *   - eventsStream:         GET  /api/events/stream (empty SSE by default)
 */
export async function setupApiMocks(page, overrides = {}) {
  const cfg = {
    config:             overrides.config             ?? DEFAULT_CONFIG,
    configSave:         overrides.configSave         ?? { ok: true },
    events:             overrides.events             ?? DEFAULT_EVENTS,

    fieldmap:           overrides.fieldmap           ?? readFieldmap(),
    simulatePull:       overrides.simulatePull       ?? DEFAULT_PULL,
    simulateTransfer:   overrides.simulateTransfer   ?? DEFAULT_TRANSFER,
    accountListDryRun:  overrides.accountListDryRun  ?? DEFAULT_DRY_RUN,
    accountListSync:    overrides.accountListSync    ?? DEFAULT_LIST_SYNC,
    trigger:            overrides.trigger            ?? DEFAULT_TRIGGER,
    engagementRecent:   overrides.engagementRecent   ?? DEFAULT_ENGAGEMENT_RECENT,
    engagementStats:    overrides.engagementStats    ?? DEFAULT_ENGAGEMENT_STATS,
    engagementTrigger:  overrides.engagementTrigger  ?? DEFAULT_ENGAGEMENT_TRIGGER,
    engagementDryRun:   overrides.engagementDryRun   ?? null, // null → 404
    eventsStream:       overrides.eventsStream       ?? null,
  };

  // Normalize all to handler functions for uniform routing.
  const handlers = {
    config:             asHandler(cfg.config),
    configSave:         asHandler(cfg.configSave),
    events:             asHandler(cfg.events),

    fieldmap:           asHandler(cfg.fieldmap),
    simulatePull:       asHandler(cfg.simulatePull),
    simulateTransfer:   asHandler(cfg.simulateTransfer),
    accountListDryRun:  asHandler(cfg.accountListDryRun),
    accountListSync:    asHandler(cfg.accountListSync),
    trigger:            asHandler(cfg.trigger),
    engagementRecent:   asHandler(cfg.engagementRecent),
    engagementStats:    asHandler(cfg.engagementStats),
    engagementTrigger:  asHandler(cfg.engagementTrigger),
  };

  // Playwright runs routes in REVERSE registration order (most-recently
  // registered first). Register the broad safety nets FIRST so the specific
  // handlers (registered later) win when both match.

  // ── webhook safety net (registered first, lowest priority) ────────────
  await page.route('**/webhook/**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });

  // ── /api/** safety net: any unmocked endpoint gets a benign 200 [].
  await page.route('**/api/**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });

  // ── specific handlers (registered last, highest priority) ─────────────

  // SSE stream: return an immediately-closed event-stream so the EventSource
  // opens, gets a comment, and stays quiet for the rest of the test.
  await page.route('**/api/events/stream', async (route) => {
    if (typeof cfg.eventsStream === 'function') return cfg.eventsStream(route);
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      headers: { 'Cache-Control': 'no-cache' },
      body: ': stream-mock\n\n',
    });
  });

  // /api/engagement/dry-run (404 if no override)
  await page.route('**/api/engagement/dry-run', async (route) => {
    if (cfg.engagementDryRun) return asHandler(cfg.engagementDryRun)(route);
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });

  await page.route('**/api/engagement/trigger',  handlers.engagementTrigger);
  await page.route('**/api/engagement/stats',    handlers.engagementStats);
  await page.route('**/api/engagement/recent**', handlers.engagementRecent);

  await page.route('**/api/trigger', handlers.trigger);

  await page.route('**/api/account-list/sync',    handlers.accountListSync);
  await page.route('**/api/account-list/dry-run', handlers.accountListDryRun);

  await page.route('**/api/simulate/transfer', handlers.simulateTransfer);
  // Match both with-query (?side=...) and without.
  await page.route(/.*\/api\/simulate\/pull(\?.*)?$/, handlers.simulatePull);

  await page.route('**/api/fieldmap', handlers.fieldmap);



  // /api/events with optional query string
  await page.route(/.*\/api\/events(\?.*)?$/, handlers.events);

  // /api/config (GET + POST share the same path)
  await page.route('**/api/config', async (route) => {
    const m = route.request().method();
    if (m === 'POST') return handlers.configSave(route);
    return handlers.config(route);
  });
}

// ── small data builders for spec readability ──────────────────────────────
export function makeContacts(n = 3) {
  return Array.from({ length: n }, (_, i) => ({
    contactid:    `c-${i + 1}`,
    emailaddress1:`alice${i + 1}@example.com`,
    firstname:    `Alice${i + 1}`,
    lastname:     `Anderson${i + 1}`,
    telephone1:   `555-010${i + 1}`,
    jobtitle:     'Director',
  }));
}

export function makeAccounts(n = 2) {
  return Array.from({ length: n }, (_, i) => ({
    accountid:        `a-${i + 1}`,
    name:             i === 0 ? 'Acme Corporation' : `Account ${i + 1}`,
    websiteurl:       'https://acme.example.com',
    telephone1:       '555-9000',
    industrycode:     'Software',
    address1_city:    'Boston',
  }));
}

export function makeEngagementRow({ id, type = 10, typeName = 'Email Open', status = 'written', email = 'lead@example.com', occurredAt }) {
  return {
    id,
    marketoActivityId: `act-${id}`,
    type,
    typeName,
    contactEmail:      email,
    dynamicsContactId:  `dc-${id}`,
    dynamicsActivityId: `dea-${id}`,
    assetName:         'April Newsletter',
    occurredAt:        occurredAt || new Date(Date.now() - id * 60_000).toISOString(),
    status,
    reason:            status === 'unmatched' ? 'no contact for email' : null,
  };
}
