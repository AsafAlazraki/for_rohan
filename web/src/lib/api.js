// Fetch recent Service Bus messages (for Webhook Sync view)
export async function getServiceBusMessages({ page = 1, limit = 50, status, search } = {}) {
  const qs = new URLSearchParams({ page: String(page), limit: String(limit) });
  if (status) qs.set('status', status);
  if (search) qs.set('search', search);
  return handle(await fetch(url(`/api/servicebus/messages?${qs.toString()}`)));
}
// Thin fetch helpers. All routes are relative by default so the Vite dev
// proxy and same-origin production (Express serving web/dist) both work.
//
// When the SPA is deployed to a separate origin (e.g. Azure Static Web Apps)
// the backend URL can be injected at build time via VITE_API_BASE — e.g.
//   VITE_API_BASE=https://sync-api.azurewebsites.net

const API_BASE = (import.meta.env.VITE_API_BASE || '').replace(/\/+$/, '');

function url(path) {
  return API_BASE + path;
}

async function handle(res) {
  const text = await res.text();
  const body = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null;
  if (!res.ok) {
    const msg = (body && body.error) || res.statusText || 'Request failed';
    throw new Error(msg);
  }
  return body;
}

export async function getConfig() {
  return handle(await fetch(url('/api/config')));
}

export async function saveConfig(key, value) {
  return handle(await fetch(url('/api/config'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, value }),
  }));
}

export async function getEvents({ page = 1, limit = 25, status, search, entityType } = {}) {
  const qs = new URLSearchParams({ page: String(page), limit: String(limit) });
  if (status) qs.set('status', status);
  if (search) qs.set('search', search);
  if (entityType) qs.set('entityType', entityType);
  return handle(await fetch(url(`/api/events?${qs.toString()}`)));
}

export async function previewBundleSync({ entity, sourceIds }) {
  return handle(await fetch(url('/api/transfer/with-company/preview'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entity, sourceIds }),
  }));
}

export async function runBundleSync({ entity, sourceIds }) {
  return handle(await fetch(url('/api/transfer/with-company'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entity, sourceIds }),
  }));
}

export async function getMarketoSchemaStatus() {
  return handle(await fetch(url('/api/marketo/schema-status')));
}

export async function setupMarketoCustomFields() {
  return handle(await fetch(url('/api/marketo/setup-custom-fields'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  }));
}

export async function getEventStats(graphPeriod = '24h') {
  return handle(await fetch(url(`/api/events/stats?graphPeriod=${graphPeriod}`)));
}

export async function getEventsBySource({ source, sourceId, limit = 50 } = {}) {
  const qs = new URLSearchParams({
    source:   String(source   || ''),
    sourceId: String(sourceId || ''),
    limit:    String(limit),
  });
  return handle(await fetch(url(`/api/events/by-source?${qs.toString()}`)));
}

export async function getSkippedEvents({ since, limit = 50 } = {}) {
  const qs = new URLSearchParams({ limit: String(limit) });
  if (since) qs.set('since', since);
  return handle(await fetch(url(`/api/events/skipped?${qs.toString()}`)));
}

export async function getWebhookUsage(period = '24h') {
  return handle(await fetch(url(`/api/events/webhook-usage?period=${period}`)));
}

export async function getSyncDirection() {
  return handle(await fetch(url('/api/sync-direction')));
}

export async function setSyncDirection(direction) {
  return handle(await fetch(url('/api/sync-direction'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ direction }),
  }));
}

export async function trigger({ source, entity = 'contact' }) {
  return handle(await fetch(url('/api/trigger'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source, entity }),
  }));
}



export async function getFieldmap() {
  return handle(await fetch(url('/api/fieldmap')));
}


// Real API: Pull records from Dynamics or Marketo
export async function pullRecords({ side, entity, limit = 10, cursor }) {
  const qs = new URLSearchParams({ side, entity, limit: String(limit) });
  if (cursor) qs.set('cursor', cursor);
  return handle(await fetch(url(`/api/pull?${qs.toString()}`)));
}

// Real API: Transfer records
export async function transferRecords({ direction, entity, records }) {
  return handle(await fetch(url('/api/transfer'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ direction, entity, records }),
  }));
}

export async function accountListDryRun({ listName, accounts }) {
  return handle(await fetch(url('/api/account-list/dry-run'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ listName, accounts }),
  }));
}

export async function accountListSync({ listName, description, accounts }) {
  return handle(await fetch(url('/api/account-list/sync'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ listName, description, accounts }),
  }));
}

export async function getEngagementRecent({ limit = 50, type, since } = {}) {
  const qs = new URLSearchParams({ limit: String(limit) });
  if (type != null && type !== '') qs.set('type', String(type));
  if (since)                       qs.set('since', since);
  return handle(await fetch(url(`/api/engagement/recent?${qs.toString()}`)));
}

export async function getEngagementStats() {
  return handle(await fetch(url('/api/engagement/stats')));
}

export async function triggerEngagementRun() {
  return handle(await fetch(url('/api/engagement/trigger'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  }));
}

// SIM-mode counterpart to triggerEngagementRun(). Server reads from Marketo
// for real but never writes to Dynamics, never advances the cursor, and
// returns a `samples` array of activities that WOULD have been written.
// Mirrors triggerEngagementRun()'s call shape so the tab can swap between them.
export async function triggerEngagementDryRun() {
  return handle(await fetch(url('/api/engagement/dry-run'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  }));
}

// ─── Outbound webhooks (this app AS a webhook source) ──────────────────────
export async function listWebhookSinks() {
  return handle(await fetch(url('/api/webhooks/sinks')));
}

export async function createWebhookSink(sink) {
  return handle(await fetch(url('/api/webhooks/sinks'), {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(sink),
  }));
}

export async function updateWebhookSink(id, patch) {
  return handle(await fetch(url(`/api/webhooks/sinks/${encodeURIComponent(id)}`), {
    method:  'PUT',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(patch),
  }));
}

export async function deleteWebhookSink(id) {
  return handle(await fetch(url(`/api/webhooks/sinks/${encodeURIComponent(id)}`), {
    method: 'DELETE',
  }));
}

export async function listWebhookDeliveries({ sinkId, limit = 20 } = {}) {
  const qs = new URLSearchParams({ limit: String(limit) });
  if (sinkId) qs.set('sinkId', sinkId);
  return handle(await fetch(url(`/api/webhooks/deliveries?${qs.toString()}`)));
}

export { API_BASE };
