import React, { useEffect, useRef, useState } from 'react';

let mermaidPromise = null;
function loadMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then(m => {
      const mermaid = m.default;
      mermaid.initialize({
        startOnLoad: false,
        theme: 'dark',
        themeVariables: {
          background:     '#111821',
          primaryColor:   '#172231',
          primaryTextColor: '#d7e0ea',
          primaryBorderColor: '#23324a',
          lineColor:      '#6ea8fe',
          secondaryColor: '#1e3a3a',
          tertiaryColor:  '#2a2a52',
          fontFamily:     'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        },
        flowchart: { curve: 'basis', htmlLabels: true },
        securityLevel: 'loose',
      });
      return mermaid;
    });
  }
  return mermaidPromise;
}

function Mermaid({ chart, id }) {
  const ref = useRef(null);
  useEffect(() => {
    let cancelled = false;
    loadMermaid().then(mermaid => mermaid.render(id, chart)).then(({ svg }) => {
      if (!cancelled && ref.current) ref.current.innerHTML = svg;
    }).catch(err => {
      if (ref.current) {
        ref.current.innerHTML =
          `<pre style="color:var(--err);white-space:pre-wrap">Mermaid error: ${err.message}</pre>`;
      }
    });
    return () => { cancelled = true; };
  }, [chart, id]);
  return <div ref={ref} className="mermaid-host">Loading diagram…</div>;
}

// ─── section content ─────────────────────────────────────────────────────
const COMPONENTS = [
  {
    id: 'listeners',
    title: 'Webhook listeners',
    path: 'src/listeners/',
    purpose: 'Accept webhooks from Dynamics and Marketo, validate HMAC signatures, and enqueue jobs.',
    details: [
      'POST /webhook/dynamics and POST /webhook/marketo — both validated with HMAC-SHA256 (timing-safe compare).',
      'Returns 200 immediately; enqueue happens via setImmediate so the webhook SLA is never at risk.',
      'Rate-limited at 60 req/min per IP via express-rate-limit.',
    ],
  },
  {
    id: 'queue',
    title: 'Job queue (pg-boss)',
    path: 'src/queue/',
    purpose: 'Durable FIFO queue backed by the same PostgreSQL as config and audit.',
    details: [
      'pg-boss v9 (CJS) — pinned to v9 because v10+ is ESM-only and breaks Jest.',
      'Concurrency controlled via SYNC_CONCURRENCY (default 5).',
      'Failed jobs retry 3× with exponential backoff, then land in the DLQ.',
    ],
  },
  {
    id: 'worker',
    title: 'Worker pipeline',
    path: 'src/queue/worker.js',
    purpose: 'The core sync brain. Runs for every dequeued job.',
    details: [
      '1. Loop guard — skip if this record originated from the target system (prevents ping-pong).',
      '2. Sync-direction override — honour any one-way override set via Admin.',
      '3. Dedup — decide CREATE vs UPDATE by looking up the record in the target by email/name.',
      '4. Field map — translate schema via src/config/fieldmap.json.',
      '5. Write — call the target writer (Dynamics or Marketo) with 429 Retry-After handling.',
      '6. Emit a sync event onto the in-process EventEmitter for SSE broadcast.',
      '7. Audit to sync_events in PostgreSQL.',
    ],
  },
  {
    id: 'auth',
    title: 'Auth + token cache',
    path: 'src/auth/',
    purpose: 'OAuth2 client_credentials against Azure AD (Dynamics) and Marketo identity.',
    details: [
      'Tokens cached in-process with a 60-second pre-expiry skew so requests never race token expiry.',
      'Falls back to env vars in tests; reads admin_config at runtime.',
    ],
  },
  {
    id: 'config',
    title: 'Admin config loader',
    path: 'src/config/loader.js',
    purpose: 'Hot-reloadable credentials and feature flags stored in the admin_config table.',
    details: [
      '60-second in-process cache — operators rotate creds from the Admin tab without redeploy.',
      'Fieldmap (src/config/fieldmap.json) lives in the repo — edit + deploy to change field translations.',
    ],
  },
  {
    id: 'writers',
    title: 'Writers',
    path: 'src/writers/',
    purpose: 'Thin REST clients for each target system.',
    details: [
      'Dynamics uses Dataverse v9.2 OData (POST /contacts, PATCH /contacts({id})).',
      'Marketo uses /rest/v1/leads/push.json (upsert) and /rest/v1/companies/sync.json.',
      'Both handle 429 Retry-After with up to 3 retries.',
    ],
  },
  {
    id: 'events',
    title: 'Events + SSE',
    path: 'src/events/, src/routes/events.js',
    purpose: 'Real-time push of sync outcomes to the browser.',
    details: [
      'Worker emits onto an in-process EventEmitter (src/events/bus.js).',
      'SSE route (/api/events/stream) subscribes and pushes to all connected browsers.',
      '25-second keepalive ping so proxies never idle-close the connection.',
    ],
  },
  {
    id: 'audit',
    title: 'Audit + logs',
    path: 'src/audit/',
    purpose: 'Immutable record of every sync attempt + structured logs.',
    details: [
      'sync_events table: status, payload, attempt count, error detail, dedup_key.',
      'Winston JSON logs to console (and rolling file in dev).',
    ],
  },
];

const FLOW_STEPS = [
  { n: 1, title: 'Source system fires webhook',   body: 'Dynamics/Marketo POSTs to /webhook/{source} with the record payload and an HMAC signature.' },
  { n: 2, title: 'Listener validates + enqueues', body: 'Signature verified (timing-safe). Server returns 200 immediately; job enqueued into pg-boss via setImmediate.' },
  { n: 3, title: 'Worker dequeues',               body: 'One of SYNC_CONCURRENCY worker slots picks up the job from Postgres.' },
  { n: 4, title: 'Loop guard + direction check',  body: 'Skip if the record originated from the target (prevents ping-pong). Honour any one-way override.' },
  { n: 5, title: 'Dedup decides CREATE vs UPDATE', body: 'Looks up the record in the target by email (contact/lead) or name (account).' },
  { n: 6, title: 'Field map + write',             body: 'Schema is translated via fieldmap.json; the writer hits the target REST API with 429 retry.' },
  { n: 7, title: 'Audit + emit',                  body: 'sync_events row inserted; a sync event is emitted on the bus.' },
  { n: 8, title: 'Browsers receive SSE',          body: 'The Dashboard and Sync View tabs see the event live. No polling.' },
];

const DESIGN_DECISIONS = [
  { title: 'One Postgres for everything',     body: 'Queue, config, and audit all live in PostgreSQL. No Redis, no separate message broker — lowest operational surface for a POC.' },
  { title: 'Credentials in the database',     body: 'Secrets live in admin_config (hot-reloaded) rather than env vars. Ops rotate via the UI; no redeploy needed.' },
  { title: 'Declarative field mapping',       body: 'src/config/fieldmap.json is the single source of truth for bidirectional field translation. Add fields without touching code.' },
  { title: 'SSE over WebSockets',             body: 'One-way server→browser push is all the UI needs; SSE works through every proxy, auto-reconnects, and is trivial to operate.' },
  { title: 'Webhook 200 then async process',  body: 'We accept+ack immediately and process in the background. Source systems never see latency from downstream API issues.' },
  { title: 'Loop guard via syncSource marker', body: 'Every write stamps the record with where it came from. The worker skips records originating from the target — no ping-pong.' },
];

const TECH_STACK = [
  { label: 'Node 18',             kind: 'backend' },
  { label: 'Express 4',           kind: 'backend' },
  { label: 'pg-boss v9',          kind: 'backend' },
  { label: 'PostgreSQL',   kind: 'data' },
  { label: 'axios',               kind: 'backend' },
  { label: 'winston',             kind: 'backend' },
  { label: 'helmet + rate-limit', kind: 'backend' },
  { label: 'React 18',            kind: 'frontend' },
  { label: 'Vite 5',              kind: 'frontend' },
  { label: 'SSE (EventSource)',   kind: 'frontend' },
  { label: 'Docker',              kind: 'ops' },
  { label: 'Azure App Service',   kind: 'ops' },
  { label: 'Azure Static Web Apps', kind: 'ops' },
];

// ─── diagrams (Mermaid) ──────────────────────────────────────────────────
const SYSTEM_DIAGRAM = `
flowchart LR
    classDef src      fill:#1a2438,stroke:#3a4a6a,color:#d7e0ea
    classDef ingress  fill:#1c2e44,stroke:#3a4a6a,color:#d7e0ea
    classDef queue    fill:#1e3a3a,stroke:#2e5a5a,color:#d7e0ea
    classDef worker   fill:#2a2a52,stroke:#4a4a72,color:#d7e0ea
    classDef tgt      fill:#3a2238,stroke:#5a3a5a,color:#d7e0ea
    classDef browser  fill:#1e3a2c,stroke:#2e5a4a,color:#d7e0ea
    classDef store    fill:#2a2230,stroke:#4a3a50,color:#d7e0ea

    subgraph Sources
      D[Dynamics CRM]:::src
      M[Marketo]:::src
    end

    L[Listener<br/>HMAC + 200]:::ingress
    Q[(pg-boss queue)]:::queue
    W[Worker pipeline<br/>guard → dedup → map → write]:::worker

    subgraph Targets
      DA[Dynamics API<br/>/contacts /accounts]:::tgt
      MA[Marketo API<br/>/leads /companies]:::tgt
    end

    B[Browser React UI<br/>SSE live feed]:::browser
    S[(PostgreSQL<br/>queue · config · audit)]:::store

    D -->|webhook| L
    M -->|webhook| L
    L -->|enqueue| Q
    Q -->|dequeue| W
    W -->|write| DA
    W -->|write| MA
    W -.->|emit sync event| B
    Q -.-> S
    W -.->|audit| S
`.trim();

const SEQUENCE_DIAGRAM = `
sequenceDiagram
    autonumber
    participant Src as Source system<br/>(Dynamics / Marketo)
    participant L   as Listener
    participant Q   as pg-boss queue
    participant W   as Worker
    participant T   as Target API
    participant DB  as PostgreSQL<br/>(audit)
    participant UI  as Browser (SSE)

    Src->>L: POST /webhook/{source}<br/>(HMAC-signed)
    L->>L: validateHmac()
    L-->>Src: 200 OK
    L->>Q: enqueue(job)
    Q->>W: dequeue
    W->>W: loopGuard + direction check
    W->>T: dedup lookup (by email/name)
    T-->>W: existing record or none
    W->>W: fieldMap(source → target shape)
    W->>T: POST/PATCH (create or update)
    T-->>W: {targetId}
    W->>DB: insert sync_events row
    W->>UI: emit sync event (SSE)
`.trim();

const PIPELINE_DIAGRAM = `
flowchart TD
    A[Job dequeued] --> B{Loop guard<br/>or one-way skip?}
    B -- skip --> S[Status: skipped<br/>audit + emit]
    B -- proceed --> C[Acquire target OAuth token]
    C --> D{Has associated<br/>account?}
    D -- yes --> E[Sync account first]
    D -- no  --> F[Resolve action:<br/>CREATE vs UPDATE]
    E --> F
    F --> G[Field-map source → target]
    G --> H{Target system?}
    H -- Marketo  --> M[POST /leads/push or /companies/sync]
    H -- Dynamics --> N[POST or PATCH /contacts · /accounts]
    M --> R[Audit + emit success]
    N --> R
    R --> X([Done])
    F -. on error .-> Y[Retry up to 3x]
    Y -. exhausted .-> Z[Dead letter queue]
`.trim();

// ─── main tab component ──────────────────────────────────────────────────
export default function Architecture() {
  const [open, setOpen] = useState(new Set(['worker']));

  function toggle(id) {
    setOpen(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  return (
    <>
      <div className="panel">
        <h2>Architecture overview</h2>
        <p style={{margin: '0 0 12px', color: 'var(--muted)'}}>
          A bidirectional, real-time sync service between Microsoft Dynamics CRM and Marketo.
          Webhooks land in an Express listener, get enqueued into a Postgres-backed job queue,
          and are processed by a worker that handles loop-guarding, field mapping, retries,
          and an audit log. The browser subscribes via SSE so every sync is visible the moment
          it finishes — no polling.
        </p>
        <Mermaid id="arch-system" chart={SYSTEM_DIAGRAM} />
      </div>

      {/* Sequence diagram */}
      <div className="panel">
        <h2>Sequence — one webhook, end to end</h2>
        <p style={{margin: '0 0 12px', color: 'var(--muted)'}}>
          What actually happens on the wire between each participant when a record
          arrives. Note that the listener acks the webhook before any processing.
        </p>
        <Mermaid id="arch-sequence" chart={SEQUENCE_DIAGRAM} />
      </div>

      {/* Worker pipeline */}
      <div className="panel">
        <h2>Worker pipeline — decision flow</h2>
        <p style={{margin: '0 0 12px', color: 'var(--muted)'}}>
          Every dequeued job runs through this decision tree. Skips, retries, and
          the dead-letter path are all part of the same graph.
        </p>
        <Mermaid id="arch-pipeline" chart={PIPELINE_DIAGRAM} />
      </div>

      {/* Components */}
      <div className="panel">
        <h2>Components</h2>
        <p style={{margin: '0 0 12px', color: 'var(--muted)'}}>
          Click any card to expand. Paths are relative to the repo root.
        </p>
        <div className="arch-grid">
          {COMPONENTS.map(c => {
            const isOpen = open.has(c.id);
            return (
              <div key={c.id} className={'arch-card' + (isOpen ? ' open' : '')} onClick={() => toggle(c.id)}>
                <div className="arch-card-head">
                  <h3>{c.title}</h3>
                  <code>{c.path}</code>
                  <span className="arch-chev">{isOpen ? '−' : '+'}</span>
                </div>
                <p className="arch-card-purpose">{c.purpose}</p>
                {isOpen && (
                  <ul className="arch-card-details">
                    {c.details.map((d, i) => <li key={i}>{d}</li>)}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Data flow */}
      <div className="panel">
        <h2>Data flow — one record end-to-end</h2>
        <ol className="arch-flow">
          {FLOW_STEPS.map(s => (
            <li key={s.n}>
              <span className="arch-flow-n">{s.n}</span>
              <div>
                <h4>{s.title}</h4>
                <p>{s.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>

      {/* Design decisions */}
      <div className="panel">
        <h2>Why it's built this way</h2>
        <div className="arch-decisions">
          {DESIGN_DECISIONS.map((d, i) => (
            <div key={i} className="arch-decision">
              <h4>{d.title}</h4>
              <p>{d.body}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Tech stack */}
      <div className="panel">
        <h2>Tech stack</h2>
        <div className="arch-badges">
          {TECH_STACK.map((t, i) => (
            <span key={i} className={'arch-badge ' + t.kind}>{t.label}</span>
          ))}
        </div>
      </div>
    </>
  );
}
