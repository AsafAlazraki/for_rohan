# Architecture — Technical Reference

Companion to [PRODUCT_OVERVIEW.md](PRODUCT_OVERVIEW.md). This document is for
engineers who need to modify, operate, or extend the system. It assumes
familiarity with Node.js, pg-boss, PostgreSQL, and the Dynamics/Marketo REST
APIs.

---

## Table of contents

- [Module map](#module-map)
- [Data model](#data-model)
- [The sync pipeline, step by step](#the-sync-pipeline-step-by-step)
- [Authentication details](#authentication-details)
- [Dedup algorithm](#dedup-algorithm)
- [Loop guard semantics](#loop-guard-semantics)
- [Retry and DLQ behaviour](#retry-and-dlq-behaviour)
- [Field mapper — types and projections](#field-mapper--types-and-projections)
- [Entity-type signal (Contact vs Lead in Marketo)](#entity-type-signal-contact-vs-lead-in-marketo)
- [Manual bundle sync (Sync with Company)](#manual-bundle-sync-sync-with-company)
- [SSE transport contract](#sse-transport-contract)
- [Configuration layering](#configuration-layering)
- [Testing strategy](#testing-strategy)
- [Performance characteristics](#performance-characteristics)
- [Operational playbook](#operational-playbook)

---

## Tech Stack

<!-- TECH_STACK_START -->
This project dynamically infers its architecture from its dependencies.
- **Database**: The system uses **PostgreSQL** (via `pg` and `pg-boss`) for queueing and audit logs.
- **Message Broker**: The system relies on **Azure Service Bus** to handle incoming webhook events.
- **Web Server**: The API routes and webhook ingestion run on **Express**.
<!-- TECH_STACK_END -->

---

## Module map

<!-- MODULE_MAP_START -->
```
src/
├── audit/
│   ├── .gitkeep
│   ├── db.js
│   └── logger.js
├── auth/
│   ├── .gitkeep
│   ├── dynamics.js
│   ├── marketo.js
│   └── tokenCache.js
├── config/
│   ├── .gitkeep
│   ├── fieldmap.json
│   └── loader.js
├── engagement/
│   ├── activityFilter.js
│   ├── activityWriter.js
│   ├── cursor.js
│   ├── dedupDb.js
│   ├── marketoActivities.js
│   ├── runner.js
│   └── scheduler.js
├── engine/
│   ├── handlers/
│   │   ├── newLead.js
│   │   └── unsubscribe.js
│   ├── .gitkeep
│   ├── accountResolver.js
│   ├── dedup.js
│   ├── derivedFields.js
│   ├── fieldDelta.js
│   ├── fieldMapper.js
│   ├── intent.js
│   ├── leadEligibility.js
│   ├── lookupResolver.js
│   ├── loopGuard.js
│   ├── marketoAuthority.js
│   ├── optionSetResolver.js
│   ├── personClassifier.js
│   ├── personResolver.js
│   ├── relationships.js
│   └── syncDirection.js
├── events/
│   └── bus.js
├── listeners/
│   ├── .gitkeep
│   ├── dynamicsPayload.js
│   ├── server.js
│   └── validate.js
├── monitor/
│   ├── .gitkeep
│   ├── alerts.js
│   ├── authorityAlerts.js
│   └── metrics.js
├── queue/
│   ├── .gitkeep
│   ├── dlq.js
│   ├── producer.js
│   ├── queue.js
│   └── worker.js
├── readers/
│   ├── dynamics.js
│   └── marketo.js
├── routes/
│   ├── accountList.js
│   ├── config.js
│   ├── engagement.js
│   ├── events.js
│   ├── jobQuery.js
│   ├── outboundWebhooks.js
│   ├── pull.js
│   ├── servicebus.js
│   └── simulate.js
├── webhooks/
│   └── outboundDispatcher.js
├── writers/
│   ├── .gitkeep
│   ├── dynamics.js
│   ├── marketo.js
│   └── marketoLists.js
└── index.js

web/
├── e2e/
│   ├── helpers/
│   │   └── mocks.js
│   ├── admin.spec.js
│   ├── app-shell.spec.js
│   ├── architecture.spec.js
│   ├── dashboard.spec.js
│   ├── engagement.spec.js
│   ├── sync-view-account-list.spec.js
│   ├── sync-view-basics.spec.js
│   └── sync-view-real-toggle.spec.js
├── public/
│   └── favicon.svg
├── src/
│   ├── components/
│   │   └── Sidebar.jsx
│   ├── lib/
│   │   ├── api.js
│   │   └── sse.js
│   ├── tabs/
│   │   ├── Admin.jsx
│   │   ├── Architecture.jsx
│   │   ├── Dashboard.jsx
│   │   ├── Engagement.jsx
│   │   ├── Logs.jsx
│   │   ├── Messages.jsx
│   │   ├── Rules.jsx
│   │   ├── SyncRules.jsx
│   │   ├── SyncView.jsx
│   │   └── Webhooks.jsx
│   ├── App.jsx
│   ├── main.jsx
│   └── styles.css
├── test-results/
│   └── .last-run.json
├── .gitignore
├── index.html
├── package-lock.json
├── package.json
├── playwright.config.js
├── staticwebapp.config.json
└── vite.config.js
```
<!-- MODULE_MAP_END -->

---

## Data model

### `sync_events` (audit log)

```sql
CREATE TABLE sync_events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_system   VARCHAR(32) NOT NULL CHECK (source_system IN ('dynamics','marketo')),
    source_id       VARCHAR(255) NOT NULL,
    source_type     VARCHAR(64) NOT NULL,                        -- 'contact' | 'lead' | 'account'
    target_system   VARCHAR(32) NOT NULL,
    target_id       VARCHAR(255),
    payload         JSONB NOT NULL DEFAULT '{}',
    status          VARCHAR(32) NOT NULL
                        CHECK (status IN ('pending','processing','success','failed','skipped')),
    attempt_count   SMALLINT NOT NULL DEFAULT 0,
    error_message   TEXT,
    error_detail    JSONB,
    dedup_key       VARCHAR(64) UNIQUE,
    job_id          VARCHAR(128),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at    TIMESTAMPTZ
);
```

Indexed on `(status)`, `(source_system, source_id)`, `(target_system, target_id)`,
`(created_at DESC)`, `(dedup_key)`.

### `admin_config` (runtime configuration)

```sql
CREATE TABLE admin_config (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    is_secret   BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

Fixed schema enforced by `src/routes/config.js#KNOWN_KEYS`; unknown keys are
rejected at the API layer.

---

## The sync pipeline, step by step

`processJob()` in [`src/queue/worker.js`](../src/queue/worker.js) is the
single source of truth for sync semantics. It runs for every dequeued job.

```
   ┌──────────────────────────────────────────────────────────────────┐
   │ 1. Loop-guard check                                              │
   │    shouldSkip(job.data, targetSystem)                            │
   │    → skip=true  → audit 'skipped', emit bus, return              │
   └──────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │ 2. Token acquisition (for target system)                         │
   │    getDynamicsToken() or getMarketoToken()                       │
   │    Cached; refreshed when within 60s of expiry                   │
   └──────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │ 2b. Associated-data pre-sync (contacts/leads with _assocAccount) │
   │     syncAccount(...)                                              │
   │     On success, capture target-side account id                   │
   │     On failure, log but continue with primary record             │
   └──────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │ 3. Dedup resolution                                              │
   │    resolveAction(email, targetSystem, token)     — contacts/leads│
   │    resolveAccountAction(name, targetSystem, token) — accounts    │
   │    Returns { action: 'create'|'update', targetId: string|null }  │
   └──────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │ 4. Field mapping                                                 │
   │    mapToMarketo(payload, entityType) or mapToDynamics(...)       │
   │    Null/undefined values are dropped                             │
   └──────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │ 5. Write                                                         │
   │    Marketo:  POST /rest/v1/leads/push.json (createOrUpdate)      │
   │    Dynamics: POST/PATCH /contacts  (with optional @odata.bind    │
   │              for parent account)                                 │
   │    429 → Retry-After backoff, up to 3 retries                    │
   └──────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │ 6. Audit + emit                                                  │
   │    INSERT INTO sync_events(...)                                  │
   │    bus.emit('sync', {...})                                       │
   └──────────────────────────────────────────────────────────────────┘
```

On any thrown error, pg-boss retries per the backoff strategy (1s → 2s → 4s
with `retryBackoff: true`). After exhausted attempts, pg-boss moves the job
to `state='failed'`; `attachDLQListener()` listens via `onComplete` and
mirrors the failure into `sync_events` with `status='failed'` and emits a
`failed` event to the dashboard.

---

## Authentication details

### Dynamics (Azure AD)

- Endpoint: `https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/token`
- Grant: `client_credentials`
- Scope: `{resourceUrl}/.default`
- Cached per-process with `TokenCache('dynamics')`

### Marketo

- Endpoint: `{baseUrl}/identity/oauth/token`
- Grant: `client_credentials`
- Cached per-process with `TokenCache('marketo')`

### Cache semantics

`src/auth/tokenCache.js` considers a token expired **60 seconds before** its
actual expiry. This avoids the "token expired mid-flight" race at the boundary
between cache hits. On 401 from the target system, callers should invoke
`cache.clear()` — but in practice, pre-expiry skew makes this rare.

---

## Dedup algorithm

### Contacts / Leads

**Key: email address.** The write target is always `createOrUpdate` semantics:

- **Marketo**: `GET /rest/v1/leads.json?filterType=email&filterValues=<email>`
  → presence ⇒ `update`; absence ⇒ `create`.
- **Dynamics**: `GET /api/data/v9.2/contacts?$filter=emailaddress1 eq '<email>'&$top=1`
  → same interpretation.

### Accounts

**Key: company name** (since accounts don't have canonical emails). Identical
pattern:

- **Marketo**: `/rest/v1/companies.json?filterType=company&filterValues=<name>`
- **Dynamics**: `/api/data/v9.2/accounts?$filter=name eq '<name>'&$top=1`

**Note on OData injection:** all `$filter` values are run through
`oDataEscape()` which doubles single quotes — the standard OData escape. See
[`src/engine/dedup.js`](../src/engine/dedup.js).

---

## Loop guard semantics

The guard exists because **every write the sync makes fires a webhook on the
target side**, which would otherwise trigger an endless ping-pong.

Mechanism: every writer stamps one of these fields on the target record:

- Dynamics → writes `cr_syncsource = '<origin system>'` (custom field)
- Marketo → writes `syncSource = '<origin system>'` (custom field)

When a webhook arrives, `loopGuard.shouldSkip()` checks the incoming payload
for any of:

```js
payload.syncSource ??
payload.cr_syncsource ??
payload.attributes?.syncSource ??
payload.attributes?.cr_syncsource
```

If present and matches the proposed **target** system (case-insensitive), the
job is skipped with status `skipped` and a human-readable reason — visible on
the dashboard. The field mapping ensures the stamp survives across syncs.

---

## Retry and DLQ behaviour

Retry options are set per-publish in `src/queue/queue.js`:

```js
await getBoss().publish(QUEUE_NAME, data, {
  retryLimit:   3,        // overridable via SYNC_JOB_ATTEMPTS
  retryDelay:   1,        // seconds
  retryBackoff: true,     // 1s → 2s → 4s
  expireInHours: 24,
});
```

- attempt 1 fails → wait 1 s
- attempt 2 fails → wait 2 s
- attempt 3 fails → wait 4 s
- attempt 4 fails → pg-boss moves the job to `state='failed'` → DLQ

`attachDLQListener()` subscribes via `boss.onComplete(QUEUE_NAME, …)`. The
handler fires for every completed job with the terminal state embedded in
the payload; we only capture rows where `state === 'failed'`. Successful
jobs are ignored.

`replayDLQ(jobId)` fetches the original by id via `boss.getJobById` and
re-publishes its `data` as a new job with a fresh retry counter. The
original row remains in `pgboss.archive` for forensics.

---

## Field mapper — types and projections

`src/engine/fieldMapper.js` projects between CRM and Marketo using
[`src/config/fieldmap.json`](../src/config/fieldmap.json). Entries are scoped
under `crmToMarketo` or `marketoToCrm` and grouped by entity (`contact`,
`lead`, `account`).

Each entry has shape `{ source, type, entitySet?, optionSet?, derivation?, value? }`.

| Type | Behaviour |
|---|---|
| `text`     | Direct copy of `record[entry.source]`. |
| `boolean`  | Direct copy (no coercion). |
| `guid`     | Direct copy — used for IDs that should pass through unchanged. |
| `choice`   | Async path: `optionSetResolver` translates int → label. Sync path: passthrough. |
| `lookup`   | Async path: `lookupResolver` resolves natural-key → GUID, emits `<field>@odata.bind` for `mapMarketoToCrm`. CRM-side reads the `_<field>_value` column. |
| `derived`  | Skipped by `mapToMarketo`; `enrichDerived` (`derivedFields.js`) computes the value separately (e.g. `parentAccountType`). Source is conventionally `'@derived'`. |
| `literal`  | Emits a fixed `entry.value` regardless of the source record. Source is conventionally `'@literal'`. Used for static signals like `crmEntityType`. |

Adding a new type means one branch in `mapToMarketo` / `mapToMarketoAsync` and
one entry in the schema-invariant test set in
`tests/unit/fieldMapper.scoped.test.js`.

---

## Entity-type signal (Contact vs Lead in Marketo)

Marketo represents both Contacts and Leads as a single Person record.
Operators scrolling the Persons list cannot tell which CRM table a Person
originated from unless we send a deterministic signal. We send three:

| Marketo field | Source | Mechanism |
|---|---|---|
| `crmEntityType` | literal `'contact'` or `'lead'` | `type: 'literal'` in fieldmap |
| `crmContactId` | Dynamics `contactid` (Contact rows only) | `type: 'guid'` in fieldmap |
| `crmLeadId` | Dynamics `leadid` (Lead rows only) | `type: 'guid'` in fieldmap |

Smart Lists in Marketo can filter on `crmEntityType is "contact"` for a clean
human-readable rule, or on `crmContactId is not empty` / `crmLeadId is not
empty` for programmatic ID checks.

Role transitions (Lead → Contact or vice versa) follow the rest of the
system's authority model: last sync wins. Whichever CRM webhook fires most
recently overwrites the Person's `crmEntityType` field.

The signal also surfaces inside the SPA: the **Logs** tab carries an
entity-type filter chip (Contact / Lead / Account / All), and **SyncView**
shows a coloured Type badge on every record card.

---

## Manual bundle sync (Sync with Company)

`src/engine/bundleSync.js` powers an operator-triggered, **CRM → Marketo
only**, multi-row sequential push. It runs outside the queue (no pg-boss
involvement) so that the operator gets immediate per-row feedback from a
modal in the SPA.

```
   ┌──────────────────────────────────────────────────────────────────┐
   │ For each selected Dynamics row:                                  │
   │                                                                  │
   │   1. readDynamicsById({ entity, id })                            │
   │        → null  → audit skip ('source-record-not-found'), continue│
   │                                                                  │
   │   2. resolveAssociatedCompany({ record, entityType, dynToken })  │
   │        Contact → _parentcustomerid_value → readDynamicsById      │
   │        Lead    → accountResolver (accountid → accountnumber →    │
   │                  NetSuite ID → name) → readDynamicsById          │
   │        Result: 'with-company' | 'person-only' | 'skip'           │
   │                                                                  │
   │   3. If skip → audit row, emit SSE skipped, continue             │
   │                                                                  │
   │   4. If with-company: writeMarketoCompany(...)                   │
   │        On failure → audit failed, but PROCEED to person write    │
   │        (Marketo dedups Company on the fly via lead.company)      │
   │                                                                  │
   │   5. writeToMarketo(personBody)                                  │
   │      personBody includes crmEntityType + crmContactId/crmLeadId  │
   │                                                                  │
   │   6. Audit each leg (account + person) with                      │
   │      reason_category='manual', reason_criterion=                 │
   │      'manual:sync-with-company'                                  │
   └──────────────────────────────────────────────────────────────────┘
```

### Skip semantics

| Condition | Outcome |
|---|---|
| Contact has no `_parentcustomerid_value` | `person-only` (graceful — no company info on the record) |
| Contact's parent Account 404s | `skip` (`no-resolvable-account`) |
| Lead has no `companyname` and no `accountnumber` | `person-only` |
| Lead's company info doesn't resolve to a real Account | `skip` (`no-resolvable-account`) |

The distinction matters: **no company info** is graceful (operators see "Person only — no company"), **company info that doesn't resolve** is a data-quality skip (operators see "Skip — no resolvable account").

### Endpoints

| Endpoint | Purpose |
|---|---|
| `POST /api/transfer/with-company/preview` | Read-only resolution + projection. Returns `{ summary, rows }` with the Account+Person bodies that **would** be sent. No writes, no audit rows. |
| `POST /api/transfer/with-company`         | Live sequential push. Returns `{ summary, results }` after the last row completes. Audit rows written per leg. |

Body for both: `{ entity: 'contact'|'lead', sourceIds: [string, ...] }`.
Hard cap of 50 rows per request. Preview is a UX path, not a server gate —
the live endpoint accepts direct calls for scripted use.

### Frontend

A dedicated **Bundle Sync row** sits above the two SyncView tables and is
visible only when the entity is Contact or Lead. The operator sees an
aggregate preview modal first (counts + collapsible per-row Account / Person
bodies), then a confirm step opens a spinner modal showing "Syncing N of
M…", finally a result modal with synced / skipped / failed counts and a
"View failures" deep link to the Logs tab pre-filtered by
`reason_criterion=manual:sync-with-company`.

---

## SSE transport contract

### Request

```
GET /api/events/stream
Accept: text/event-stream
```

### Response

```
HTTP/1.1 200 OK
Content-Type: text/event-stream
Cache-Control: no-cache, no-transform
Connection: keep-alive
X-Accel-Buffering: no

: connected 2025-11-01T12:34:56.789Z

data: {"id":"job-1","source":"dynamics","target":"marketo","status":"success","entityType":"contact","email":"x@y.com","sourceFields":{...},"targetFields":{...},"ts":"..."}

: ping

data: {"id":"job-2",...}
```

- Lines starting with `:` are SSE comments (used as keepalives, ignored by
  clients).
- Keepalive every 25 s prevents proxies from closing idle connections.
- Stream ends only when the client disconnects; the server never closes it.
- `EventSource` in the browser reconnects automatically on disconnect with
  exponential backoff — no wrapper code needed.

### Event shape

```ts
type SyncEvent = {
  id:           string,
  source:       'dynamics' | 'marketo',
  target:       'dynamics' | 'marketo',
  status:       'success' | 'skipped' | 'failed',
  entityType:   'contact' | 'lead' | 'account',
  email:        string | null,
  sourceFields: Record<string, any>,    // raw source payload (minus _associatedAccount)
  targetFields: Record<string, any>,    // result of mapToXxx(payload, entityType)
  error?:       string,
  reason?:      string,                 // set for skipped events
  ts:           string,                 // ISO 8601
}
```

---

## Configuration layering

Resolution order in `getConfig(key)` at [`src/config/loader.js`](../src/config/loader.js):

1. **In-memory cache hit** (< 60 s old) → return cached.
2. **PostgreSQL admin_config bulk refresh** (one query for all keys, cached 60 s)
   → return row value if present.
3. **`process.env[key]` fallback** → return env value.
4. `null`.

This three-layer approach is deliberate:

- **Cache** avoids hammering PostgreSQL on every sync.
- **PostgreSQL** lets the Admin UI change credentials without a restart.
- **Env fallback** keeps `.env`-only deployments working, and keeps tests
  green without a PostgreSQL mock (tests set `process.env` directly).

`setConfig(key, value)` does an upsert and invalidates the cache entry
immediately so the next read sees the new value without waiting for the
60-second refresh.

---

## Testing strategy

```
tests/
├── unit/                       14 suites, ~170 tests
│   ├── auth.test.js
│   ├── tokenCache.test.js
│   ├── configLoader.test.js
│   ├── dedup.test.js
│   ├── dlq.test.js
│   ├── eventBus.test.js
│   ├── fieldMapper.test.js
│   ├── logger.test.js
│   ├── loopGuard.test.js
│   ├── metrics.test.js
│   ├── alerts.test.js
│   ├── queue.test.js
│   ├── server.test.js

│   ├── validate.test.js
│   ├── worker.test.js
│   ├── writers.test.js
│   └── db.test.js
│
├── integration/                1 suite, 5 tests
│   └── pipeline.test.js        End-to-end with all external I/O mocked
│
└── e2e/                        Gated by E2E_RUN=1; skipped in CI
    └── fullSync.test.js        Against real Dynamics + Marketo sandboxes
```

### Principles

| Principle | Where enforced |
|---|---|
| Every external dependency is mockable | `getConfig` has env fallback; `getPostgreSQL` returns null without creds; `db/_setPool` injects a mock pg Pool |
| No test needs a real Postgres or PostgreSQL | Unit + integration tests use jest.mock for `pg-boss`, `pg`, `axios`, and the `postgres/client` module |
| Integration tests exercise the real call chain | `pipeline.test.js` runs `processJob` against the real worker, loopGuard, fieldMapper, dedup, writers, logger — only axios / pg / pg-boss are stubbed |
| E2E tests are safe by default | `E2E_RUN=1` gate means placeholder CI creds never trigger real HTTP calls |
| Tests are fast | Full suite runs in ~7 seconds locally |

---

## Performance characteristics

### Expected latencies (per sync)

| Step | Typical | Notes |
|---|---|---|
| HMAC verify + enqueue | < 10 ms | CPU-bound only |
| pg-boss dequeue + dispatch | 50–150 ms | Postgres `SKIP LOCKED` poll against PostgreSQL |
| Token fetch (cache miss) | 200–500 ms | Azure AD / Marketo identity; cache miss ≈ 1× per hour |
| Token fetch (cache hit) | < 1 ms | |
| Dedup lookup | 100–300 ms | Outbound HTTPS to target system |
| Write | 150–400 ms | Outbound HTTPS to target system |
| Audit INSERT | 10–50 ms | PostgreSQL |
| Bus emit → SSE render | < 100 ms | |
| **Total (typical)** | **~600 ms – 1.5 s** | |

### Throughput

Single worker instance with `SYNC_CONCURRENCY=5` and Marketo's 100 req / 20 s
rate bucket: ~5 syncs/second sustained.

Horizontal scaling: add worker instances. pg-boss uses `FOR UPDATE SKIP
LOCKED` to fan out jobs across every connected worker without coordination
logic.

---

## Operational playbook

### Investigate a failure

```sql
-- Latest 20 failures
SELECT id, source_system, source_id, target_system, error_message, created_at
FROM sync_events
WHERE status = 'failed'
ORDER BY created_at DESC
LIMIT 20;
```

Pair with the structured JSON log lines in `logs/sync.log` or the App Service
log stream — filter by `jobId`.

### Replay a single failed job

```js
const { replayDLQ } = require('./src/queue/dlq');
await replayDLQ('<pg-boss-job-uuid>');
```

Creates a fresh job with a new attempt counter; the original row stays in
the audit log for forensics.

### Rotate credentials without downtime

1. Admin UI → Edit → Save (for each changed key).
2. Within 60 seconds, new syncs use the new values. In-flight jobs complete
   against the old values.
3. No process restart required.

### Pause all syncs (maintenance window)

Either:

- Pause pg-boss from a Node REPL: `(await getBoss()).stop({ graceful: true })`, and scale the App Service down to 0.
- Or scale the App Service to 0 instances; webhooks will queue in the source
  systems (both Dynamics and Marketo retry failed webhook deliveries).

### Add a new alert threshold

Edit [`src/monitor/alerts.js`](../src/monitor/alerts.js) — two lines for
the new condition in `checkAndAlert()`. The heartbeat loop picks it up on
next tick.

---

## Further reading

| Doc | Audience |
|---|---|
| [PRODUCT_OVERVIEW.md](PRODUCT_OVERVIEW.md) | Product / client-facing |
| [AZURE_DEPLOY.md](AZURE_DEPLOY.md) | DevOps / platform |
| [CREDENTIALS_SETUP.md](CREDENTIALS_SETUP.md) | Integration setup |
| [runbook.md](runbook.md) | On-call |
| [README](../README.md) | Local development |
