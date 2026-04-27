import React, { useEffect, useMemo, useState } from 'react';
import {
  User,
  Users,
  Briefcase,
  ArrowRight,
  ArrowLeft,
  ArrowLeftRight,
  Search,
  RefreshCw,
  X,
  Layers,
  List as ListIcon,
  Info,
  Building2,
  CheckCircle2,
  AlertCircle,
  ChevronDown,
  ChevronRight as ChevronRightIcon,
} from 'lucide-react';
import {
  accountListSync,
  getEventsBySource, getServiceBusMessages,
  pullRecords, transferRecords,
  previewBundleSync, runBundleSync,
  getMarketoSchemaStatus, setupMarketoCustomFields,
} from '../lib/api.js';
import { openSyncStream } from '../lib/sse.js';

// ─── time helpers ────────────────────────────────────────────────────────
function relativeTime(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return String(iso);
  const diff = Math.max(0, Date.now() - then);
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function defaultListName() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `D365 Account Sync — ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ─── constants ───────────────────────────────────────────────────────────
const ENTITIES = [
  { value: 'contact', label: 'Contact', icon: <User size={16} /> },
  { value: 'lead',    label: 'Lead',    icon: <Users size={16} /> },
  { value: 'account', label: 'Account', icon: <Briefcase size={16} /> },
];

const DIRECTIONS = [
  { value: 'd2m', glyph: <ArrowRight size={20} />, label: 'Dynamics → Marketo' },
  { value: 'both', glyph: <ArrowLeftRight size={20} />, label: 'Dynamics ↔ Marketo' },
  { value: 'm2d', glyph: <ArrowLeft size={20} />, label: 'Dynamics ← Marketo' },
];

// Authority matrix: what the Marketo→CRM engine actually permits per the spec's
// Operational Behaviour model. 'full' = all mapped fields sync. 'conditional' =
// sync runs but most rows skip at the authority guard. 'forbidden' = every row
// rejects, so don't let the user even try.
const SYNC_RULES = {
  contact: {
    d2m:  { kind: 'full' },
    m2d:  { kind: 'conditional', note: 'Marketo → Dynamics for Contacts only syncs the global unsubscribe flag. All other fields will skip.' },
    both: { kind: 'conditional', note: 'The Marketo → Dynamics leg only syncs the unsubscribe flag; other fields will skip. The Dynamics → Marketo leg syncs the full field set.' },
  },
  lead: {
    d2m:  { kind: 'full' },
    m2d:  { kind: 'conditional', note: 'Marketo → Dynamics for Leads only creates new Leads. Existing Leads (with a CRM ID) will skip.' },
    both: { kind: 'conditional', note: 'The Marketo → Dynamics leg only creates new Leads; updates will skip. The Dynamics → Marketo leg syncs the full field set.' },
  },
  account: {
    d2m:  { kind: 'full' },
    m2d:  { kind: 'forbidden', note: 'Marketo cannot write Accounts to Dynamics — Accounts are CRM-authoritative.' },
    both: { kind: 'forbidden', note: 'Marketo cannot write Accounts, so bidirectional sync is unavailable. Use Dynamics → Marketo.' },
  },
};

function getSyncRule(entity, direction) {
  return SYNC_RULES[entity]?.[direction] || { kind: 'full' };
}

// ─── helpers ─────────────────────────────────────────────────────────────
function identifierOf(row, entity) {
  if (entity === 'account') return row.name || row.company || row.accountid || row.id || '—';
  return row.emailaddress1 || row.email || row.firstname || row.firstName ||
    row.contactid || row.leadid || row.id || '—';
}

function sourceIdOf(row) {
  return row.contactid || row.leadid || row.accountid || row.id || null;
}

function prettyHighlightJson(val) {
  if (!val) return '(empty)';
  let str = val;
  if (typeof val !== 'string') {
    str = JSON.stringify(val, null, 2);
  } else {
    try {
      const obj = JSON.parse(val);
      str = JSON.stringify(obj, null, 2);
    } catch (e) {
      // Keep as is if not valid JSON
    }
  }

  // Basic syntax highlighting via regex
  return str
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, (match) => {
      let cls = 'json-number';
      if (/^"/.test(match)) {
        if (/:$/.test(match)) cls = 'json-key';
        else cls = 'json-string';
      } else if (/true|false/.test(match)) cls = 'json-boolean';
      else if (/null/.test(match)) cls = 'json-null';
      return `<span class="${cls}">${match}</span>`;
    });
}

function formatEventReason(evt) {
  if (evt.error_message) return evt.error_message;
  
  const cat = (evt.reason_category || '').toLowerCase();
  const crit = (evt.reason_criterion || '').toLowerCase();

  if (cat === 'no-change' || crit === 'snapshot') {
    return 'Checked snapshots and determined no change to record. Skipped sync.';
  }
  if (cat === 'eligibility' || cat === 'not-eligible') {
    return 'Record does not meet the sync criteria. Skipped.';
  }
  if (cat === 'authority') {
    return 'Source record is older than the target record. Skipped to prevent data regression.';
  }

  if (evt.reason_category) {
    return `Reason: ${evt.reason_category}${evt.reason_criterion ? ` · ${evt.reason_criterion}` : ''}`;
  }

  return null;
}



// ─── small subcomponents ─────────────────────────────────────────────────
const TYPE_BADGE_STYLE = {
  contact: { bg: 'rgba(56, 189, 248, 0.12)', fg: '#7dd3fc', border: 'rgba(56, 189, 248, 0.25)' },
  lead:    { bg: 'rgba(168, 85, 247, 0.12)', fg: '#c4b5fd', border: 'rgba(168, 85, 247, 0.25)' },
  account: { bg: 'rgba(34, 197, 94, 0.12)',  fg: '#86efac', border: 'rgba(34, 197, 94, 0.25)' },
};

function TypeBadge({ entity }) {
  const palette = TYPE_BADGE_STYLE[entity] || TYPE_BADGE_STYLE.contact;
  const label = entity ? entity.charAt(0).toUpperCase() + entity.slice(1) : '';
  return (
    <span
      className="sv-type-badge"
      style={{
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: '0.6px',
        textTransform: 'uppercase',
        padding: '2px 8px',
        borderRadius: 999,
        background: palette.bg,
        color: palette.fg,
        border: `1px solid ${palette.border}`,
        whiteSpace: 'nowrap',
      }}
      title={`Entity type: ${label}`}
    >
      {label}
    </span>
  );
}

function RecordCard({ row, entity, side, selected, onToggle, onShowDetails, flying }) {
  const displayLabel = entity === 'account'
    ? (row.name || row.company || 'Unnamed Account')
    : `${row.firstname || row.firstName || ''} ${row.lastname || row.lastName || ''}`.trim()
      || row.emailaddress1 || row.email || 'Unnamed Record';

  return (
    <div
      className={
        'sv-card' +
        (selected ? ' selected' : '') +
        (flying ? ` flying flying-${side}` : '')
      }
      onClick={onToggle}
    >
      <div className="sv-card-head">
        <label className="sv-checkbox" onClick={e => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggle}
          />
          <span className="sv-checkmark"></span>
        </label>
        <span className="sv-card-title">{displayLabel}</span>
        <TypeBadge entity={entity} />
      </div>

      <div className="sv-card-actions">
        <button
          type="button"
          className="ghost"
          onClick={e => { e.stopPropagation(); onShowDetails(); }}
          style={{ fontSize: 12, padding: '6px 16px', borderRadius: 20, background: 'rgba(255,255,255,0.03)' }}
        >
          View Details
        </button>
      </div>
    </div>
  );
}
function Column({
  title, side, entity, rows, selected, onToggleRow, onClearSelection, onShowDetails,
  onPull, loading, note, error, flying, transferred,
}) {
  const [query, setQuery] = useState('');
  const [sortOrder, setSortOrder] = useState('none'); // 'none' | 'asc' | 'desc'

  // Clear selections whenever the search query changes (as requested)
  useEffect(() => {
    onClearSelection();
  }, [query, sortOrder]); // eslint-disable-line react-hooks/exhaustive-deps

  const filteredRows = useMemo(() => {
    let result = rows;
    if (query) {
      const q = query.toLowerCase();
      result = result.filter(r => {
        const label = (entity === 'account'
          ? (r.name || r.company)
          : `${r.firstname || ''} ${r.lastname || ''}`
        ) || '';
        return label.toLowerCase().includes(q) || 
               (r.emailaddress1 || r.email || '').toLowerCase().includes(q);
      });
    }

    // Optionally sort client-side by display label
    if (sortOrder === 'asc' || sortOrder === 'desc') {
      const dir = sortOrder === 'asc' ? 1 : -1;
      result = [...result].sort((a, b) => {
        const labelA = (entity === 'account'
          ? (a.name || a.company || '')
          : `${a.firstname || a.firstName || ''} ${a.lastname || a.lastName || ''}`.trim() || a.emailaddress1 || a.email || '') || '';
        const labelB = (entity === 'account'
          ? (b.name || b.company || '')
          : `${b.firstname || b.firstName || ''} ${b.lastname || b.lastName || ''}`.trim() || b.emailaddress1 || b.email || '') || '';
        return labelA.localeCompare(labelB, undefined, { sensitivity: 'base' }) * dir;
      });
    }
    return result;
  }, [rows, query, entity, sortOrder]);

  return (
    <div className="sv-col">
      <div className="sv-col-head" style={{ flexDirection: 'column', gap: 16, marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', position: 'relative' }}>
          <h3 style={{ margin: 0, fontSize: 15, letterSpacing: '0.5px', textTransform: 'uppercase', opacity: 0.9 }}>{title}</h3>
          <button 
            className="primary" 
            disabled={loading} 
            onClick={onPull}
            style={{ 
              position: 'absolute', right: 0, top: '50%', transform: 'translateY(-50%)',
              height: 32, padding: '0 16px', fontSize: 12, borderRadius: 16,
              background: 'var(--accent)',
              color: '#050b14',
              display: 'flex', alignItems: 'center', gap: 6,
              border: 'none'
            }}
          >
            <RefreshCw size={14} className={loading ? 'spin' : ''} />
            {loading ? 'Pulling' : rows.length > 0 ? 'Re-pull' : 'Pull'}
          </button>
        </div>

        <div style={{ display: 'flex', gap: 8, width: '100%' }}>
          <div style={{ position: 'relative', flex: 1 }}>
            <Search size={14} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)' }} />
            <input 
              type="text" 
              placeholder={`Search ${entity}s...`}
              value={query}
              onChange={e => setQuery(e.target.value)}
              style={{ 
                width: '100%', padding: '10px 36px 10px 36px', 
                background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border)', 
                borderRadius: 8, color: 'var(--text)', fontSize: 13,
                outline: 'none', transition: 'border-color 0.2s'
              }}
              onFocus={e => e.target.style.borderColor = 'var(--accent)'}
              onBlur={e => e.target.style.borderColor = 'var(--border)'}
            />
            {query && (
              <button
                onClick={() => setQuery('')}
                style={{
                  position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
                  background: 'transparent', border: 'none', color: 'var(--muted)',
                  cursor: 'pointer', padding: 4, display: 'flex', alignItems: 'center'
                }}
                title="Clear search"
              >
                <X size={14} />
              </button>
            )}
          </div>
          
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <label style={{ fontSize: 12, color: 'var(--muted)', display: 'inline-block', minWidth: 44 }}>Order</label>
            <button
              type="button"
              className={'ghost' + (sortOrder === 'none' ? ' active' : '')}
              onClick={() => setSortOrder('none')}
              style={{ padding: '6px 10px', borderRadius: 8, border: 'none', background: sortOrder === 'none' ? 'rgba(255,255,255,0.03)' : 'transparent', color: 'var(--muted)', cursor: 'pointer' }}
              title="Server order"
            >
              Server
            </button>
            <button
              type="button"
              className={'ghost' + (sortOrder === 'asc' ? ' active' : '')}
              onClick={() => setSortOrder(sortOrder === 'asc' ? 'none' : 'asc')}
              style={{ padding: '6px 10px', borderRadius: 8, border: 'none', background: sortOrder === 'asc' ? 'var(--accent)' : 'transparent', color: sortOrder === 'asc' ? '#050b14' : 'var(--muted)', cursor: 'pointer' }}
              title="Sort A → Z"
            >
              A → Z
            </button>
            <button
              type="button"
              className={'ghost' + (sortOrder === 'desc' ? ' active' : '')}
              onClick={() => setSortOrder(sortOrder === 'desc' ? 'none' : 'desc')}
              style={{ padding: '6px 10px', borderRadius: 8, border: 'none', background: sortOrder === 'desc' ? 'var(--accent)' : 'transparent', color: sortOrder === 'desc' ? '#050b14' : 'var(--muted)', cursor: 'pointer' }}
              title="Sort Z → A"
            >
              Z → A
            </button>
          </div>
        </div>
      </div>

      {error && <div className="sv-note err">{error}</div>}
      {note && <div className="sv-note warn">{note}</div>}

      <div className="sv-col-list" style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        {filteredRows.length === 0 && !loading && (
          <div className="empty" style={{ padding: 16 }}>
            {query ? 'No matching records found.' : `Click Pull to read live ${entity}s from ${title}.`}
          </div>
        )}
        {filteredRows.map(r => {
          const id = sourceIdOf(r);
          return (
            <RecordCard
              key={id || JSON.stringify(r)}
              row={r}
              entity={entity}
              side={side}
              selected={selected.has(id)}
              onToggle={() => onToggleRow(id)}
              onShowDetails={() => onShowDetails(r)}
              flying={flying}
            />
          );
        })}
        {transferred.length > 0 && (
          <>
            <div className="sv-divider">↓ transferred in</div>
            {transferred.map((r, i) => {
              const displayLabel = entity === 'account'
                ? (r.name || r.company || 'Unnamed Account')
                : `${r.firstname || r.firstName || ''} ${r.lastname || r.lastName || ''}`.trim() || r.emailaddress1 || 'Unnamed Record';
              return (
                <div key={'t' + i} className="sv-card transferred" style={{ alignItems: 'center' }}>
                  <span className="sv-card-title">{displayLabel}</span>
                  <span className="chip success">arrived</span>
                </div>
              );
            })}
          </>
        )}

      </div>
    </div>
  );
}

// ─── main component ──────────────────────────────────────────────────────
export default function SyncView({ flash }) {
  const [entity, setEntity] = useState('contact');
  const [direction, setDirection] = useState('d2m');

  const [confirmTransfer, setConfirmTransfer] = useState(false);



  const [dyn, setDyn] = useState({ rows: [], loading: false, error: null, note: null, transferred: [] });
  const [mkt, setMkt] = useState({ rows: [], loading: false, error: null, note: null, transferred: [] });

  const [selDyn, setSelDyn] = useState(new Set());
  const [selMkt, setSelMkt] = useState(new Set());

  const [log, setLog] = useState([]); // { jobId?, side, target, ident, status, reason?, error? }
  const [flying, setFlying] = useState(false);
  const [transferring, setTransferring] = useState(false);

  // Per-record events drawer (drill-down into sync_events history)
  const [drawer, setDrawer] = useState(null); // { source, sourceId, ident, events, loading, error }
  async function openEventsDrawer({ source, sourceId, ident }) {
    // Translate column side to source system name (matches sync_events.source_system).
    const srcSys = source === 'marketo' ? 'marketo' : 'dynamics';
    setDrawer({ source: srcSys, sourceId, ident, events: [], loading: true, error: null });
    try {
      const res = await getEventsBySource({ source: srcSys, sourceId, limit: 50 });
      setDrawer(d => d && d.sourceId === sourceId
        ? { ...d, events: res.events || [], loading: false }
        : d);
    } catch (e) {
      setDrawer(d => d && d.sourceId === sourceId
        ? { ...d, loading: false, error: e.message }
        : d);
    }
  }
  function closeEventsDrawer() { setDrawer(null); }

  // Per-record details drawer
  const [detailsDrawer, setDetailsDrawer] = useState(null); // { row, side, ident }
  function openDetailsDrawer(row, side) {
    setDetailsDrawer({ row, side, ident: identifierOf(row, entity) });
  }
  function closeDetailsDrawer() { setDetailsDrawer(null); }

  // ── Account-list mode (Doc 1: push selected accounts as a Marketo Named Account List)
  const [acctMode, setAcctMode] = useState('per-record'); // 'per-record' | 'list'
  const [askListName, setAskListName] = useState(false);        // modal open
  const [listNameInput, setListNameInput] = useState('');
  const [listResult, setListResult] = useState(null);         // { listName, listId, upserted, addedToList, error?, hint? }
  const inListMode = entity === 'account' && acctMode === 'list';

  // Force direction → when entering list mode (Marketo is the destination)
  useEffect(() => {
    if (inListMode && direction !== 'd2m') setDirection('d2m');
  }, [inListMode]); // eslint-disable-line react-hooks/exhaustive-deps

  const currentRule = getSyncRule(entity, direction);

  // Reset acct mode and clear results when changing the entity
  useEffect(() => {
    if (entity !== 'account' && acctMode !== 'per-record') setAcctMode('per-record');
    
    // Clear all pulled results and selections
    setDyn({ rows: [], loading: false, error: null, note: null, transferred: [] });
    setMkt({ rows: [], loading: false, error: null, note: null, transferred: [] });
    setSelDyn(new Set());
    setSelMkt(new Set());
    setLog([]);
  }, [entity]); // eslint-disable-line react-hooks/exhaustive-deps



  // Subscribe to SSE so real-mode transfer outcomes appear here without
  // tabbing away to the Dashboard. We correlate by jobId: enqueued log rows
  // carry their pg-boss jobId, and worker/DLQ events emit the same id.
  useEffect(() => {
    const close = openSyncStream(
      (evt) => {
        const id = evt.id != null ? String(evt.id) : null;
        if (!id) return;
        setLog(prev => {
          const idx = prev.findIndex(l => l.jobId === id);
          if (idx === -1) return prev;
          const next = prev.slice();
          next[idx] = {
            ...next[idx],
            status: evt.status || next[idx].status,
            error: evt.error || next[idx].error,
            reason: evt.reason || next[idx].reason,
          };
          return next;
        });
      },
      () => {/* EventSource auto-reconnects */ },
    );
    return close;
  }, []);

  // ── Pull (auto-paginate to fetch all records) ─────────────────────────
  async function pullSide(side) {
    const setState = side === 'dynamics' ? setDyn : setMkt;
    setState(s => ({ ...s, loading: true, error: null, note: null }));

    (side === 'dynamics' ? setSelDyn : setSelMkt)(new Set());

    let allRows = [];
    let cursor = null;
    let lastError = null;
    let lastNote = null;

    try {
      // Continue paging until the server returns no nextCursor.
      while (true) {
        const res = await pullRecords({ side, entity, limit: 500, cursor });
        const slice = res || { rows: [], nextCursor: null };
        allRows = [...allRows, ...slice.rows];
        lastError = slice.error || null;
        lastNote = slice.note || null;

        setState({
          rows: allRows,
          loading: !!slice.nextCursor,
          error: lastError,
          note: lastNote,
          transferred: [],
        });

        cursor = slice.nextCursor || null;
        if (!cursor) break;
        // No client-side caps — keep requesting until server indicates completion.
      }
    } catch (e) {
      setState(s => ({ ...s, loading: false, error: e.message }));
      flash('err', `Pull ${side} failed: ${e.message}`);
    }
  }



  function toggleSel(side, id) {
    if (id == null) return;
    const [sel, setSel] = side === 'dynamics' ? [selDyn, setSelDyn] : [selMkt, setSelMkt];
    const next = new Set(sel);
    next.has(id) ? next.delete(id) : next.add(id);
    setSel(next);
  }

  const selectedDyn = useMemo(() => dyn.rows.filter(r => selDyn.has(sourceIdOf(r))), [dyn.rows, selDyn]);
  const selectedMkt = useMemo(() => mkt.rows.filter(r => selMkt.has(sourceIdOf(r))), [mkt.rows, selMkt]);

  // ── Transfer ──────────────────────────────────────────────────────────

  async function runSync(targetRecords) {
    setTransferring(true);
    setFlying(true);
    try {
      const res = await transferRecords({
        direction,
        entity,
        records: targetRecords,
      });
      const count = (res.enqueued?.dynamics || 0) + (res.enqueued?.marketo || 0);
      flash('ok', `Enqueued ${count} record(s). Live outcomes will appear below.`);
      setLog((res.jobs || []).map(j => ({
        jobId: j.jobId,
        side: j.side,
        target: j.side === 'dynamics' ? 'marketo' : 'dynamics',
        ident: j.ident,
        status: 'enqueued',
      })));
      if (res.errors && res.errors.length) {
        const first = res.errors[0];
        flash('err', `Enqueue failed (${first.side}): ${first.error}${res.errors.length > 1 ? ` (+${res.errors.length - 1} more)` : ''}`);
      }
    } catch (e) {
      flash('err', `Sync failed: ${e.message}`);
    } finally {
      setTransferring(false);
      setTimeout(() => setFlying(false), 1100);
    }
  }

  async function onSyncClick() {
    if (inListMode) return openListNamePrompt();
    const total = selectedDyn.length + selectedMkt.length;
    if (total === 0) return flash('err', 'Select at least one record first.');
    
    const targets = {
      dynamics: (direction === 'd2m' || direction === 'both') ? selectedDyn : [],
      marketo: (direction === 'm2d' || direction === 'both') ? selectedMkt : [],
    };
    runSync(targets);
  }

  async function onSyncAllClick() {
    if (inListMode) return flash('err', 'Sync All is not supported for Named Lists. Please select records manually.');
    const total = dyn.rows.length + mkt.rows.length;
    if (total === 0) return flash('err', 'No records loaded to sync.');

    const targets = {
      dynamics: (direction === 'd2m' || direction === 'both') ? dyn.rows : [],
      marketo: (direction === 'm2d' || direction === 'both') ? mkt.rows : [],
    };
    runSync(targets);
  }

  // ── Marketo schema status (banner + setup button) ─────────────────────
  // Surfaces "you haven't created the custom fields yet" up-front instead
  // of letting the operator hit a silent drop in the writer's auto-filter.
  const [schemaStatus, setSchemaStatus] = useState(null);   // { ready, missing, schemaAccessible, requiredFields } | null
  const [schemaSettingUp, setSchemaSettingUp] = useState(false);
  const [schemaBannerDismissed, setSchemaBannerDismissed] = useState(false);
  // When setup hits 603 / 401 / 403, the route returns a `manualSetup` blob
  // we surface inline so the operator can either fix permissions or create
  // the fields themselves in Marketo Admin.
  const [schemaSetupError, setSchemaSetupError] = useState(null); // { error, hint, manualSetup } | null

  async function refreshSchemaStatus() {
    try {
      const status = await getMarketoSchemaStatus();
      setSchemaStatus(status);
      return status;
    } catch {
      return null;
    }
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const status = await refreshSchemaStatus();
      if (cancelled) return; // eslint-disable-line no-unused-expressions
      if (!status) return;
    })();
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function onMarketoSetupClick() {
    setSchemaSettingUp(true);
    setSchemaSetupError(null);
    try {
      const r = await setupMarketoCustomFields();
      if (r.failed > 0) {
        // Permission denied or partial failure — keep the inline error so
        // the banner expands with manual-setup guidance.
        setSchemaSetupError(r);
        if (r.accessDenied) {
          flash('err', 'Marketo access denied — see the banner for next steps.');
        } else {
          flash('err', r.error || `Setup failed: ${r.results.map(x => x.name + (x.error ? ` (${x.error})` : '')).join('; ')}`);
        }
      } else {
        flash('ok', `Marketo fields ready — ${r.created} created, ${r.alreadyExisted} already existed.`);
        await refreshSchemaStatus();
      }
    } catch (e) {
      flash('err', `Setup failed: ${e.message}`);
      setSchemaSetupError({ error: e.message });
    } finally {
      setSchemaSettingUp(false);
    }
  }

  async function onMarketoSetupRetry() {
    setSchemaSetupError(null);
    await onMarketoSetupClick();
  }

  const schemaBannerVisible =
    schemaStatus
    && !schemaStatus.ready
    && !schemaBannerDismissed;

  // ── Bundle sync (Sync with Company) ───────────────────────────────────
  // Two-phase flow: preview (read-only) → confirm → live sequential push.
  // Only available D→M, only for Contact / Lead, only with selections on the
  // Dynamics side. Account writes that fail mid-row do NOT block the Person
  // write — Marketo will create the Company on the fly via lead.company.
  const [bundlePreview, setBundlePreview] = useState(null);  // { summary, rows } | null
  const [bundleProgress, setBundleProgress] = useState(null); // { current, total } | null
  const [bundleResult, setBundleResult] = useState(null);    // { summary, results } | null

  const bundleEligible =
    (entity === 'contact' || entity === 'lead')
    && !inListMode
    && (direction === 'd2m' || direction === 'both')
    && selectedDyn.length > 0;

  async function onBundleSyncClick() {
    if (!bundleEligible) {
      return flash('err', 'Sync with Company needs ≥1 selected Contact or Lead on the Dynamics side, in d2m mode.');
    }
    setTransferring(true);
    try {
      const sourceIds = selectedDyn.map(sourceIdOf).filter(Boolean);
      const preview = await previewBundleSync({ entity, sourceIds });
      setBundlePreview(preview);
    } catch (e) {
      flash('err', `Preview failed: ${e.message}`);
    } finally {
      setTransferring(false);
    }
  }

  async function onBundleConfirm() {
    if (!bundlePreview) return;
    const sourceIds = bundlePreview.rows.map(r => r.sourceId);
    setBundleProgress({ current: 0, total: sourceIds.length });
    setTransferring(true);
    setFlying(true);
    try {
      const result = await runBundleSync({ entity, sourceIds });
      setBundleResult(result);
      setBundlePreview(null);
      const { personsSynced, accountsSynced, skipped, failed } = result.summary;
      const tone = failed > 0 ? 'err' : 'ok';
      flash(tone, `Synced ${personsSynced} person(s) + ${accountsSynced} company/companies, ${skipped} skipped, ${failed} failed.`);
    } catch (e) {
      flash('err', `Bundle sync failed: ${e.message}`);
    } finally {
      setBundleProgress(null);
      setTransferring(false);
      setTimeout(() => setFlying(false), 1100);
    }
  }

  function onBundleCancel() {
    setBundlePreview(null);
  }

  // ── Account-list submit flow ──────────────────────────────────────────
  function openListNamePrompt() {
    if (selectedDyn.length === 0) return flash('err', 'Select at least one account first.');
    setListNameInput(defaultListName());
    setListResult(null);
    setAskListName(true);
  }

  async function submitAccountList() {
    setAskListName(false);
    const listName = (listNameInput || '').trim() || defaultListName();
    setTransferring(true);
    setFlying(true);
    try {
      const res = await accountListSync({ listName, accounts: selectedDyn });
      setListResult(res);
      if (res.error) {
        flash('err', `${res.error}${res.hint ? ' — ' + res.hint : ''}`);
      } else {
        flash('ok', `List "${res.listName}" created (id ${res.listId}). ${res.addedToList.length} member(s) added.`);
      }
    } catch (e) {
      flash('err', `Account-list submit failed: ${e.message}`);
      setListResult({ error: e.message });
    } finally {
      setTransferring(false);
      setTimeout(() => setFlying(false), 1100);
    }
  }



  const directionGlyph = DIRECTIONS.find(d => d.value === direction)?.glyph || '→';

  // Modern banner/button for Sync Rules
  const handleRulesClick = e => {
    e.preventDefault();
    if (window.setTab) window.setTab('syncrules');
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: 54,
          background: 'none',
          border: 'none',
          boxShadow: 'none',
        }}
      >
        <button
          onClick={handleRulesClick}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            background: 'rgba(56,189,248,0.18)',
            border: '1.5px solid var(--accent)',
            color: 'var(--accent)',
            fontWeight: 700,
            fontSize: 16,
            borderRadius: 24,
            padding: '8px 28px',
            margin: '18px 0 24px 0',
            boxShadow: '0 2px 12px 0 rgba(56,189,248,0.08)',
            cursor: 'pointer',
            letterSpacing: '0.2px',
            transition: 'background 0.18s, border 0.18s',
            outline: 'none',
          }}
          onMouseOver={e => e.currentTarget.style.background = 'rgba(56,189,248,0.28)'}
          onMouseOut={e => e.currentTarget.style.background = 'rgba(56,189,248,0.18)'}
        >
          <Info size={20} style={{ marginRight: 2, color: 'var(--accent)' }} />
          <span>View Integration Sync Rules</span>
        </button>
      </div>
      {/* Controls bar (centered configuration) */}
      <div className="panel sv-controls" style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 48, padding: '24px' }}>

        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 64 }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <label className="sv-lbl" style={{ marginBottom: 14, fontSize: 11, fontWeight: 700, letterSpacing: '1.5px', color: 'var(--accent)', opacity: 0.8 }}>ENTITY</label>
            <div style={{ display: 'flex', gap: 8, background: 'rgba(255,255,255,0.03)', padding: 4, borderRadius: 12, border: '1px solid var(--border)' }}>
              {ENTITIES.map(o => {
                const isActive = entity === o.value;
                return (
                  <button
                    key={o.value}
                    onClick={() => setEntity(o.value)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '8px 16px',
                      height: 40,
                      borderRadius: 8,
                      border: 'none',
                      background: isActive ? 'var(--accent)' : 'transparent',
                      color: isActive ? '#050b14' : 'var(--muted)',
                      fontSize: 13,
                      fontWeight: 600,
                      cursor: 'pointer',
                      transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
                    }}
                  >
                    {o.icon}
                    {o.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <label className="sv-lbl" style={{ marginBottom: 14, fontSize: 11, fontWeight: 700, letterSpacing: '1.5px', color: 'var(--accent)', opacity: 0.8 }}>DIRECTION</label>
            <div className="sv-dir" style={{ display: 'flex', gap: 8, background: 'rgba(255,255,255,0.03)', padding: 4, borderRadius: 12, border: '1px solid var(--border)' }}>
              {DIRECTIONS.map(d => {
                const isActive = direction === d.value;
                return (
                  <button
                    key={d.value}
                    className={'sv-dir-btn' + (isActive ? ' active' : '')}
                    onClick={() => setDirection(d.value)}
                    title={d.label}
                    style={{
                      width: 48,
                      height: 40,
                      borderRadius: 8,
                      border: 'none',
                      background: isActive ? 'var(--accent)' : 'transparent',
                      color: isActive ? '#050b14' : 'var(--muted)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      cursor: 'pointer',
                      transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
                    }}
                  >
                    {d.glyph}
                  </button>
                );
              })}
            </div>
          </div>

          {entity === 'account' && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              <label className="sv-lbl" style={{ marginBottom: 14, fontSize: 11, fontWeight: 700, letterSpacing: '1.5px', color: 'var(--accent)', opacity: 0.8 }}>ACCOUNT MODE</label>
              <div style={{ display: 'flex', gap: 8, background: 'rgba(255,255,255,0.03)', padding: 4, borderRadius: 12, border: '1px solid var(--border)' }}>
                {[
                  { value: 'per-record', label: 'Per-Record', icon: <Layers size={16} /> },
                  { value: 'list', label: 'Named List', icon: <ListIcon size={16} /> }
                ].map(m => {
                  const isActive = acctMode === m.value;
                  return (
                    <button
                      key={m.value}
                      onClick={() => setAcctMode(m.value)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: '8px 18px',
                        height: 40,
                        borderRadius: 8,
                        border: 'none',
                        background: isActive ? 'var(--accent)' : 'transparent',
                        color: isActive ? '#050b14' : 'var(--muted)',
                        fontSize: 13,
                        fontWeight: 700,
                        cursor: 'pointer',
                        transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
                        boxShadow: isActive ? '0 0 15px rgba(56, 189, 248, 0.4)' : 'none'
                      }}
                    >
                      {m.icon}
                      {m.label}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>





      {/* Marketo schema banner — shown when crmEntityType / crmContactId / crmLeadId aren't yet defined in Marketo */}
      {schemaBannerVisible && (
        <div
          style={{
            margin: '0 24px 12px',
            padding: schemaSetupError ? '14px 18px' : '12px 16px',
            borderRadius: 10,
            background: schemaSetupError
              ? 'linear-gradient(135deg, rgba(234, 179, 8, 0.10), rgba(234, 179, 8, 0.02))'
              : 'linear-gradient(135deg, rgba(168, 85, 247, 0.10), rgba(168, 85, 247, 0.02))',
            border: schemaSetupError
              ? '1px solid rgba(234, 179, 8, 0.35)'
              : '1px solid rgba(168, 85, 247, 0.3)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <Building2
              size={18}
              style={{ color: schemaSetupError ? '#facc15' : '#c4b5fd', flexShrink: 0 }}
            />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>
                {schemaSetupError
                  ? (schemaSetupError.accessDenied
                      ? 'Automatic setup blocked — Marketo access denied'
                      : 'Marketo setup did not finish')
                  : 'Marketo schema not yet set up for Contact-vs-Lead filtering'}
              </div>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
                {schemaSetupError
                  ? (schemaSetupError.hint
                      || schemaSetupError.error
                      || 'See instructions below.')
                  : `The custom fields ${(schemaStatus.missing || []).join(', ')} are missing from your Marketo Lead schema. Until they exist, those values are silently dropped from every sync.`}
              </div>
            </div>
            {!schemaSetupError && (
              <button
                type="button"
                disabled={schemaSettingUp}
                onClick={onMarketoSetupClick}
                style={{
                  height: 34, padding: '0 16px', borderRadius: 17, border: 'none',
                  background: schemaSettingUp ? 'rgba(168, 85, 247, 0.18)' : 'linear-gradient(135deg, #a855f7, #9333ea)',
                  color: '#fff', fontSize: 12, fontWeight: 700,
                  cursor: schemaSettingUp ? 'wait' : 'pointer',
                  boxShadow: schemaSettingUp ? 'none' : '0 4px 12px rgba(168, 85, 247, 0.3)',
                  flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6,
                }}
              >
                {schemaSettingUp && <RefreshCw size={12} className="spin" />}
                {schemaSettingUp ? 'Setting up…' : 'Set up Marketo fields'}
              </button>
            )}
            {schemaSetupError && (
              <button
                type="button"
                disabled={schemaSettingUp}
                onClick={onMarketoSetupRetry}
                title="Re-run after fixing permissions"
                style={{
                  height: 34, padding: '0 16px', borderRadius: 17,
                  border: '1px solid rgba(234, 179, 8, 0.5)',
                  background: 'transparent', color: '#facc15',
                  fontSize: 12, fontWeight: 700,
                  cursor: schemaSettingUp ? 'wait' : 'pointer',
                  flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6,
                }}
              >
                {schemaSettingUp && <RefreshCw size={12} className="spin" />}
                {schemaSettingUp ? 'Retrying…' : 'Try again'}
              </button>
            )}
            <button
              type="button"
              onClick={() => { setSchemaBannerDismissed(true); setSchemaSetupError(null); }}
              aria-label="Dismiss"
              title="Dismiss"
              style={{
                width: 28, height: 28, borderRadius: 6,
                border: 'none', background: 'transparent', color: 'var(--muted)',
                cursor: 'pointer', flexShrink: 0,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}
            >
              <X size={14} />
            </button>
          </div>

          {/* Inline manual-setup guidance when the API path is blocked */}
          {schemaSetupError?.manualSetup && (
            <div
              style={{
                marginTop: 14,
                padding: 14,
                borderRadius: 8,
                background: 'rgba(255,255,255,0.02)',
                border: '1px solid var(--border)',
              }}
            >
              <div style={{ fontSize: 11, color: '#facc15', textTransform: 'uppercase', letterSpacing: '0.6px', fontWeight: 700, marginBottom: 8 }}>
                Manual setup — Marketo Admin → Field Management
              </div>
              <ol style={{ margin: '0 0 12px 18px', padding: 0, fontSize: 12, color: 'var(--muted)', lineHeight: 1.6 }}>
                {(schemaSetupError.manualSetup.steps || []).map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ol>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {(schemaSetupError.manualSetup.fields || []).map(f => (
                  <div
                    key={f.name}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '180px 160px 1fr',
                      gap: 12,
                      padding: '8px 10px',
                      borderRadius: 6,
                      background: 'rgba(255,255,255,0.025)',
                      border: '1px solid var(--border)',
                      fontSize: 12,
                    }}
                  >
                    <code style={{ fontFamily: 'var(--mono)', fontSize: 12, color: '#7dd3fc' }}>{f.name}</code>
                    <span style={{ color: 'var(--text)' }}>{f.displayName}</span>
                    <span style={{ color: 'var(--muted)' }}>
                      <span
                        style={{
                          fontSize: 10, padding: '1px 6px', borderRadius: 4,
                          background: 'rgba(255,255,255,0.05)',
                          border: '1px solid var(--border)', marginRight: 6,
                          textTransform: 'uppercase', letterSpacing: '0.4px', fontWeight: 700,
                        }}
                      >
                        {f.dataType}
                      </span>
                      {f.description}
                    </span>
                  </div>
                ))}
              </div>
              {schemaSetupError.manualSetup.permissionFix && (
                <div style={{ marginTop: 12, fontSize: 11, color: 'var(--muted)', lineHeight: 1.5, fontStyle: 'italic' }}>
                  {schemaSetupError.manualSetup.permissionFix}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {(currentRule.kind === 'conditional' || currentRule.kind === 'forbidden') && (() => {
        const isForbidden = currentRule.kind === 'forbidden';
        const accentRgb = isForbidden ? '239, 68, 68' : '234, 179, 8';
        return (
          <div
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 10,
              margin: '0 24px 12px',
              padding: '10px 14px',
              borderRadius: 8,
              background: `rgba(${accentRgb}, 0.08)`,
              border: `1px solid rgba(${accentRgb}, 0.25)`,
              color: 'var(--text)',
              fontSize: 13,
              lineHeight: 1.45,
            }}
          >
            <Info size={16} style={{ color: `rgb(${accentRgb})`, flexShrink: 0, marginTop: 2 }} />
            <span>{currentRule.note}</span>
          </div>
        );
      })()}

      {/* Two columns + arrow */}
      <div className="sv-stage">
        <Column
          title="Dynamics CRM"
          side="dynamics"
          entity={entity}
          rows={dyn.rows}
          selected={selDyn}
          onToggleRow={(id) => toggleSel('dynamics', id)}
          onClearSelection={() => setSelDyn(new Set())}
          onShowDetails={(row) => openDetailsDrawer(row, 'dynamics')}
          onPull={() => pullSide('dynamics')}
          loading={dyn.loading}
          note={dyn.note}
          error={dyn.error}
          flying={flying && (direction === 'd2m' || direction === 'both')}
          transferred={dyn.transferred}
        />

        <div className={'sv-arrow dir-' + direction + (flying ? ' flying' : '')} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
          <div className="sv-arrow-track">
            <span className="sv-arrow-glyph">{directionGlyph}</span>
          </div>

          {(() => {
            // Uniform sizing across the three action buttons. Same shape;
            // colour communicates the action.
            const baseStyle = {
              width: 200,
              height: 38,
              padding: '0 16px',
              fontSize: 13,
              fontWeight: 700,
              borderRadius: 20,
              border: 'none',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              transition: 'all 0.2s ease',
              cursor: 'pointer',
              letterSpacing: '0.2px',
            };
            const forbidden = currentRule.kind === 'forbidden';

            const syncSelectedDisabled = transferring || forbidden;
            const syncSelectedLabel = transferring
              ? (inListMode ? 'Working…' : 'Syncing…')
              : inListMode ? 'Push as Named List' : 'Sync Selected';
            const syncSelectedStyle = {
              ...baseStyle,
              background: syncSelectedDisabled ? 'rgba(239, 68, 68, 0.18)' : '#ef4444',
              color:      syncSelectedDisabled ? 'rgba(252, 165, 165, 0.6)' : '#fff',
              boxShadow:  syncSelectedDisabled ? 'none' : '0 4px 12px rgba(239, 68, 68, 0.3)',
              cursor:     syncSelectedDisabled ? 'not-allowed' : 'pointer',
              opacity:    forbidden ? 0.4 : 1,
            };

            const syncAllDisabled = transferring || forbidden || inListMode;
            const syncAllStyle = {
              ...baseStyle,
              background: syncAllDisabled ? 'rgba(56, 189, 248, 0.06)' : 'rgba(56, 189, 248, 0.08)',
              color:      syncAllDisabled ? 'rgba(125, 211, 252, 0.5)' : 'var(--accent)',
              border:     '1px solid rgba(56, 189, 248, 0.25)',
              cursor:     syncAllDisabled ? 'not-allowed' : 'pointer',
              opacity:    syncAllDisabled ? 0.6 : 1,
            };

            const bundleDisabled = transferring || !bundleEligible;
            const bundleTitle = !bundleEligible
              ? (selectedDyn.length === 0
                  ? 'Select ≥1 Dynamics-side row first'
                  : direction === 'm2d'
                    ? 'Bundle sync only runs Dynamics → Marketo'
                    : 'Bundle sync is only for Contact / Lead')
              : `Preview ${selectedDyn.length} row${selectedDyn.length === 1 ? '' : 's'} before pushing`;
            const bundleStyle = {
              ...baseStyle,
              background: bundleDisabled ? 'rgba(168, 85, 247, 0.18)' : '#a855f7',
              color:      bundleDisabled ? 'rgba(196, 181, 253, 0.6)' : '#fff',
              boxShadow:  bundleDisabled ? 'none' : '0 4px 12px rgba(168, 85, 247, 0.3)',
              cursor:     bundleDisabled ? 'not-allowed' : 'pointer',
            };

            return (
              <>
                <button
                  type="button"
                  disabled={syncSelectedDisabled}
                  onClick={onSyncClick}
                  title={forbidden ? currentRule.note : undefined}
                  style={syncSelectedStyle}
                >
                  {syncSelectedLabel}
                </button>

                {!inListMode && (
                  <button
                    type="button"
                    disabled={syncAllDisabled}
                    onClick={onSyncAllClick}
                    title={forbidden ? currentRule.note : undefined}
                    style={syncAllStyle}
                  >
                    Sync All Records
                  </button>
                )}

                {(entity === 'contact' || entity === 'lead') && !inListMode && (
                  <button
                    type="button"
                    disabled={bundleDisabled}
                    onClick={onBundleSyncClick}
                    title={bundleTitle}
                    style={bundleStyle}
                  >
                    <Building2 size={14} />
                    Sync with Company{selectedDyn.length > 0 ? ` (${selectedDyn.length})` : ''}
                  </button>
                )}
              </>
            );
          })()}

          <div className="sv-arrow-label" style={{ fontSize: 12, opacity: 0.6, marginTop: 4 }}>
            {DIRECTIONS.find(d => d.value === direction)?.label}
          </div>
        </div>

        <Column
          title="Marketo"
          side="marketo"
          entity={entity}
          rows={mkt.rows}
          selected={selMkt}
          onToggleRow={(id) => toggleSel('marketo', id)}
          onClearSelection={() => setSelMkt(new Set())}
          onShowDetails={(row) => openDetailsDrawer(row, 'marketo')}
          onPull={() => pullSide('marketo')}
          loading={mkt.loading}
          note={mkt.note}
          error={mkt.error}
          flying={flying && (direction === 'm2d' || direction === 'both')}
          transferred={mkt.transferred}
        />
      </div>


      {/* Record Details Drawer */}
      {detailsDrawer && (
        <>
          <div className="sv-drawer-backdrop" onClick={closeDetailsDrawer} />
          <div className="panel" style={{
            position: 'fixed', top: 0, right: 0, bottom: 0, width: 500,
            zIndex: 1000, margin: 0, borderRadius: 0, display: 'flex', flexDirection: 'column',
            boxShadow: '-8px 0 32px rgba(0,0,0,0.5)', borderLeft: '1px solid var(--border)',
            background: 'var(--panel)'
          }}>
            <div className="row" style={{ padding: '24px 24px 12px', borderBottom: '1px solid var(--border)' }}>
              <div style={{ flex: 1 }}>
                <h2 style={{ margin: 0, fontSize: 18 }}>Record Details</h2>
                <div style={{ color: 'var(--muted)', fontSize: 13, marginTop: 4 }}>{detailsDrawer.ident}</div>
              </div>
              <button className="ghost" onClick={closeDetailsDrawer} style={{ padding: '4px 8px' }}>✕</button>
            </div>
            
            <div style={{ flex: 1, overflowY: 'auto', padding: 24 }}>
              <div style={{ display: 'grid', gap: 12 }}>
                {Object.entries(detailsDrawer.row).map(([k, v]) => (
                  <div key={k} style={{ padding: '8px 0', borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                    <div style={{ fontSize: 11, color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 4 }}>{k}</div>
                    <div style={{ fontSize: 14, fontFamily: 'var(--mono)', wordBreak: 'break-all' }}>
                      {v == null ? <span style={{ color: 'var(--muted)', fontStyle: 'italic' }}>null</span> : String(v)}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="row" style={{ padding: 24, borderTop: '1px solid var(--border)', gap: 12 }}>
              <button 
                className="primary" 
                style={{ flex: 1 }}
                onClick={() => {
                  const id = sourceIdOf(detailsDrawer.row);
                  openEventsDrawer({ source: detailsDrawer.side, sourceId: id, ident: detailsDrawer.ident });
                }}
              >
                Show Events History
              </button>
            </div>
          </div>
        </>
      )}



      {/* Status log */}
      {log.length > 0 && (
        <div className="panel">
          <h2>Sync Log</h2>
          <ul className="sv-log">
            {log.map((l, i) => {
              const s = (l.status || '').toUpperCase().trim();
              const chipKind =
                s === 'SUCCESS' || s === 'COMPLETED' || s === 'ENQUEUED' ? 'success' :
                s === 'FAILED'  || s === 'ERROR'                         ? 'failed' :
                'skipped';
              return (
                <li key={i}>
                  <span className="sv-log-arrow">{l.side} → {l.target}</span>
                  <span className="sv-log-ident">{l.ident}</span>
                  <span className={'chip ' + chipKind}>{l.status}</span>
                  {(l.error || l.reason) && (
                    <span className="sv-log-error">{l.error || l.reason}</span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Account-list result */}
      {listResult && (
        <div className="panel">
          <h2>Named Account List result</h2>
          <div className="sv-list-summary">
            <div>
              <span className="sv-list-k">List name</span>
              <span className="sv-list-v">{listResult.listName || '—'}</span>
            </div>
            <div>
              <span className="sv-list-k">Marketo list ID</span>
              <span className="sv-list-v">{listResult.listId || '—'}</span>
            </div>
            <div>
              <span className="sv-list-k">Members</span>
              <span className="sv-list-v">
                {(listResult.upserted || []).length} upserted · {(listResult.addedToList || []).length} added to list
              </span>
            </div>
            {listResult.error && (
              <div className="sv-note err" style={{ marginTop: 8 }}>
                {listResult.error}{listResult.hint ? ` — ${listResult.hint}` : ''}
              </div>
            )}
          </div>

          {(listResult.upserted || []).length > 0 && (
            <ul className="sv-log" style={{ marginTop: 12 }}>
              {listResult.upserted.map((m, i) => {
                const added = (listResult.addedToList || []).find(a => a.id === m.namedAccountId);
                const finalStatus = m.status === 'skipped' || m.status === 'failed'
                  ? m.status
                  : (added && (added.status === 'skipped' || added.status === 'failed')
                    ? `add:${added.status}`
                    : (added?.status || m.status));
                const s = (finalStatus || '').toUpperCase().trim();
                const chipKind =
                  s === 'CREATED' || s === 'UPDATED' || s === 'ADDED' || s === 'SUCCESS' || s === 'COMPLETED' ? 'success' :
                  s === 'SKIPPED' || s.startsWith('ADD:SKIPPED') ? 'skipped' :
                  'failed';
                return (
                  <li key={i}>
                    <span className="sv-log-arrow">account</span>
                    <span className="sv-log-ident">{m.name || '(no name)'}</span>
                    <span className={'chip ' + chipKind}>{finalStatus}</span>
                    {(m.error || added?.error) && (
                      <span className="sv-log-error">{m.error || added.error}</span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {/* Account-list modal */}
      {askListName && (
        <Modal
          title="Named Account List Configuration"
          body={
            <div style={{ padding: '8px 0' }}>
              <p style={{ marginBottom: 20, fontSize: 14, color: 'var(--text)', lineHeight: 1.5 }}>
                You are creating a <strong>Marketo Named Account List</strong>. This will group the <strong>{selectedDyn.length}</strong> selected accounts together for targeted campaigns.
              </p>
              <div style={{ marginBottom: 8 }}>
                <label className="sv-lbl" style={{ fontSize: 11, marginBottom: 8, display: 'block' }}>LIST NAME</label>
                <input
                  type="text"
                  placeholder="e.g. Q4 High Value Accounts"
                  value={listNameInput}
                  onChange={e => setListNameInput(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && submitAccountList()}
                  style={{ 
                    width: '100%', padding: '12px 16px', background: 'rgba(255,255,255,0.03)', 
                    border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text)',
                    fontSize: 14, outline: 'none'
                  }}
                  autoFocus
                />
              </div>
              <p style={{ marginTop: 16, fontSize: 12, color: 'var(--muted)', fontStyle: 'italic' }}>
                Note: This requires the Marketo ABM module.
              </p>
            </div>
          }
          confirmLabel="Create & Push List"
          onCancel={() => setAskListName(false)}
          onConfirm={submitAccountList}
        />
      )}



      {/* Per-record events drawer */}
      {drawer && (
        <EventsDrawer drawer={drawer} onClose={closeEventsDrawer} />
      )}

      {/* Confirm real transfer */}
      {confirmTransfer && (
        <Modal
          title="Confirm Real-Time Sync?"
          body={
            <>
              <p>This will enqueue <strong>{selectedDyn.length + selectedMkt.length}</strong> record(s)
                into the live sync pipeline. Real writes will occur on the target system.</p>
              <p>Continue?</p>
            </>
          }
          confirmLabel="Yes, sync for real"
          danger
          onCancel={() => setConfirmTransfer(false)}
          onConfirm={() => { setConfirmTransfer(false); onSyncClick(); }}
        />
      )}

      {/* Bundle Sync — preview + progress modal */}
      {(bundlePreview || bundleProgress || bundleResult) && (
        <BundleSyncModal
          preview={bundlePreview}
          progress={bundleProgress}
          result={bundleResult}
          entity={entity}
          onCancel={onBundleCancel}
          onConfirm={onBundleConfirm}
          onClose={() => { setBundleResult(null); setBundlePreview(null); setBundleProgress(null); }}
        />
      )}
    </div>
  );
}

// ─── Bundle Sync modal ─────────────────────────────────────────────────────
// ─── Bundle Sync modal — polished version ──────────────────────────────────
const BUNDLE_PURPLE = '#a855f7';
const BUNDLE_PURPLE_LIGHT = '#c4b5fd';

function BundleSyncModal({ preview, progress, result, entity, onCancel, onConfirm, onClose }) {
  const [expanded, setExpanded] = useState(() => new Set());
  // Per-row "show raw bodies" toggle — bodies are heavy, default to hidden.
  const [bodiesShown, setBodiesShown] = useState(() => new Set());

  function toggleRow(id) {
    setExpanded(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }
  function toggleBodies(id) {
    setBodiesShown(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  const showPreview  = preview && !progress && !result;
  const showProgress = !!progress;
  const showResult   = !!result && !progress;

  const titleText =
    showPreview ? 'Sync with Company — Preview' :
    showProgress ? 'Syncing…' :
    showResult ? 'Sync Complete' : '';
  const subtitle =
    showPreview && preview ? `${preview.summary.total} ${entity}${preview.summary.total === 1 ? '' : 's'} ready to review` :
    showProgress && progress ? `Row ${progress.current} of ${progress.total}` :
    showResult && result ? `${result.summary.total} processed` : '';

  return (
    <div
      className="sv-modal-backdrop"
      style={{
        position: 'fixed', inset: 0, zIndex: 1200,
        background: 'rgba(5, 11, 20, 0.65)',
        backdropFilter: 'blur(6px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 20,
        animation: 'sv-fade-in 0.18s ease',
      }}
    >
      <style>{`
        @keyframes sv-fade-in { from { opacity: 0 } to { opacity: 1 } }
        @keyframes sv-modal-rise {
          from { opacity: 0; transform: translateY(8px) scale(0.985); }
          to   { opacity: 1; transform: translateY(0) scale(1); }
        }
        @keyframes sv-progress-pulse {
          0%, 100% { opacity: 0.85 }
          50%      { opacity: 0.45 }
        }
      `}</style>

      <div
        className="sv-modal"
        onClick={e => e.stopPropagation()}
        style={{
          width: 'min(740px, 96vw)', maxHeight: '88vh',
          display: 'flex', flexDirection: 'column',
          background: 'var(--panel)',
          borderRadius: 16,
          border: '1px solid rgba(168, 85, 247, 0.18)',
          boxShadow: '0 30px 80px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.04)',
          overflow: 'hidden',
          animation: 'sv-modal-rise 0.22s cubic-bezier(0.4, 0, 0.2, 1)',
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: '20px 24px',
            background: 'linear-gradient(135deg, rgba(168, 85, 247, 0.10), rgba(168, 85, 247, 0.02))',
            borderBottom: '1px solid rgba(168, 85, 247, 0.15)',
            display: 'flex', alignItems: 'center', gap: 14,
          }}
        >
          <div
            style={{
              width: 40, height: 40, borderRadius: 10,
              background: 'rgba(168, 85, 247, 0.14)',
              border: '1px solid rgba(168, 85, 247, 0.3)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: BUNDLE_PURPLE_LIGHT, flexShrink: 0,
            }}
          >
            <Building2 size={20} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text)', letterSpacing: '0.1px' }}>
              {titleText}
            </div>
            {subtitle && (
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2, fontVariantNumeric: 'tabular-nums' }}>
                {subtitle}
              </div>
            )}
          </div>
          {!showProgress && (
            <button
              type="button"
              onClick={showResult ? onClose : onCancel}
              aria-label="Close"
              style={{
                width: 32, height: 32, borderRadius: 8,
                border: 'none', background: 'rgba(255,255,255,0.04)',
                color: 'var(--muted)', cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                transition: 'background 0.15s, color 0.15s',
              }}
              onMouseOver={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.08)'; e.currentTarget.style.color = 'var(--text)'; }}
              onMouseOut={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.04)'; e.currentTarget.style.color = 'var(--muted)'; }}
            >
              <X size={16} />
            </button>
          )}
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>
          {showPreview && (
            <BundlePreviewBody
              preview={preview}
              entity={entity}
              expanded={expanded}
              toggleRow={toggleRow}
              bodiesShown={bodiesShown}
              toggleBodies={toggleBodies}
            />
          )}
          {showProgress && <BundleProgressBody progress={progress} />}
          {showResult && (
            <BundleResultBody
              result={result}
              entity={entity}
              expanded={expanded}
              toggleRow={toggleRow}
            />
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: '14px 24px',
            borderTop: '1px solid var(--border)',
            background: 'rgba(255,255,255,0.01)',
            display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 10,
          }}
        >
          {showPreview && (
            <>
              <button
                type="button"
                onClick={onCancel}
                style={{
                  height: 36, padding: '0 18px', borderRadius: 18,
                  border: '1px solid var(--border)',
                  background: 'transparent', color: 'var(--muted)',
                  fontSize: 13, fontWeight: 600, cursor: 'pointer',
                  transition: 'color 0.15s, border-color 0.15s',
                }}
                onMouseOver={e => { e.currentTarget.style.color = 'var(--text)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.2)'; }}
                onMouseOut={e => { e.currentTarget.style.color = 'var(--muted)'; e.currentTarget.style.borderColor = 'var(--border)'; }}
              >
                Cancel
              </button>
              {(() => {
                const pushable = preview.summary.withCompany + preview.summary.personOnly;
                const disabled = pushable === 0;
                return (
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={onConfirm}
                    style={{
                      height: 36, padding: '0 22px', borderRadius: 18,
                      border: 'none',
                      background: disabled ? 'rgba(168, 85, 247, 0.18)' : `linear-gradient(135deg, ${BUNDLE_PURPLE}, #9333ea)`,
                      color: disabled ? 'rgba(196, 181, 253, 0.55)' : '#fff',
                      fontSize: 13, fontWeight: 700,
                      cursor: disabled ? 'not-allowed' : 'pointer',
                      boxShadow: disabled ? 'none' : '0 6px 18px rgba(168, 85, 247, 0.35)',
                      transition: 'transform 0.12s, box-shadow 0.15s',
                      display: 'flex', alignItems: 'center', gap: 8,
                    }}
                    onMouseOver={e => { if (!disabled) e.currentTarget.style.transform = 'translateY(-1px)'; }}
                    onMouseOut={e => { if (!disabled) e.currentTarget.style.transform = 'translateY(0)'; }}
                  >
                    Push {pushable} now
                    <ArrowRight size={14} />
                  </button>
                );
              })()}
            </>
          )}
          {showProgress && (
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>
              Working… you can leave this open.
            </span>
          )}
          {showResult && (
            <button
              type="button"
              onClick={onClose}
              style={{
                height: 36, padding: '0 22px', borderRadius: 18,
                border: 'none',
                background: `linear-gradient(135deg, ${BUNDLE_PURPLE}, #9333ea)`,
                color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer',
                boxShadow: '0 6px 18px rgba(168, 85, 247, 0.35)',
              }}
            >
              Done
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Stat cards ──────────────────────────────────────────────────────────────
function BundleStatGrid({ items }) {
  const visible = items.filter(i => i.value !== undefined && i.value !== null);
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${visible.length}, 1fr)`,
        gap: 10,
        marginBottom: 18,
      }}
    >
      {visible.map(i => (
        <div
          key={i.label}
          style={{
            padding: '14px 12px',
            borderRadius: 12,
            background: `linear-gradient(180deg, ${i.color}1a, ${i.color}05)`,
            border: `1px solid ${i.color}33`,
            textAlign: 'center',
            transition: 'transform 0.15s, border-color 0.15s',
          }}
        >
          <div
            style={{
              fontSize: 26, fontWeight: 800, color: i.color, lineHeight: 1,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {i.value}
          </div>
          <div
            style={{
              fontSize: 10, color: 'var(--muted)',
              textTransform: 'uppercase', letterSpacing: '0.6px',
              marginTop: 6, fontWeight: 600,
            }}
          >
            {i.label}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Body — Preview ──────────────────────────────────────────────────────────
function BundlePreviewBody({ preview, entity, expanded, toggleRow, bodiesShown, toggleBodies }) {
  return (
    <>
      <BundleStatGrid
        items={[
          { label: 'With company', value: preview.summary.withCompany, color: BUNDLE_PURPLE },
          { label: 'Person only',  value: preview.summary.personOnly,  color: '#7dd3fc' },
          { label: 'Will skip',    value: preview.summary.willSkip,    color: '#facc15' },
          { label: 'Errors',       value: preview.summary.errors,      color: '#ef4444' },
        ]}
      />
      <BundleRowList
        rows={preview.rows}
        expanded={expanded}
        toggleRow={toggleRow}
        bodiesShown={bodiesShown}
        toggleBodies={toggleBodies}
        mode="preview"
        entity={entity}
      />
    </>
  );
}

// ── Body — Progress ─────────────────────────────────────────────────────────
function BundleProgressBody({ progress }) {
  const pct = progress.total > 0 ? Math.min(100, Math.round((progress.current / progress.total) * 100)) : 0;
  return (
    <div style={{ padding: '24px 0 8px', textAlign: 'center' }}>
      <div
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 64, height: 64,
          borderRadius: '50%',
          background: 'rgba(168, 85, 247, 0.10)',
          border: '1px solid rgba(168, 85, 247, 0.3)',
          marginBottom: 18,
          animation: 'sv-progress-pulse 1.6s ease-in-out infinite',
        }}
      >
        <RefreshCw size={28} className="spin" style={{ color: BUNDLE_PURPLE_LIGHT }} />
      </div>
      <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>
        Syncing {progress.current} of {progress.total}
      </div>
      <div
        style={{
          margin: '20px auto 8px',
          width: '70%',
          height: 6,
          borderRadius: 99,
          background: 'rgba(255,255,255,0.06)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: '100%',
            background: `linear-gradient(90deg, ${BUNDLE_PURPLE}, #9333ea)`,
            borderRadius: 99,
            transition: 'width 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
          }}
        />
      </div>
      <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 12, lineHeight: 1.6 }}>
        Sequential — Account first, then Person.<br />
        Per-row failures are recorded; the batch keeps going.
      </div>
    </div>
  );
}

// ── Body — Result ───────────────────────────────────────────────────────────
function BundleResultBody({ result, entity, expanded, toggleRow }) {
  return (
    <>
      <BundleStatGrid
        items={[
          { label: 'Persons',     value: result.summary.personsSynced,  color: '#22c55e' },
          { label: 'Companies',   value: result.summary.accountsSynced, color: BUNDLE_PURPLE },
          { label: 'Skipped',     value: result.summary.skipped,        color: '#facc15' },
          { label: 'Failed',      value: result.summary.failed,         color: '#ef4444' },
        ]}
      />
      <BundleRowList
        rows={result.results}
        expanded={expanded}
        toggleRow={toggleRow}
        mode="result"
        entity={entity}
      />
    </>
  );
}

// ── Row list ────────────────────────────────────────────────────────────────
function previewTone(plan) {
  if (plan === 'with-company') return BUNDLE_PURPLE;
  if (plan === 'person-only')  return '#7dd3fc';
  if (plan === 'skip')         return '#facc15';
  return '#ef4444';
}
function resultTone(r) {
  if (r.personSynced) return '#22c55e';
  if (r.skipReason)   return '#facc15';
  return '#ef4444';
}
function previewLabel(r) {
  if (r.plan === 'with-company') return 'Person + Company';
  if (r.plan === 'person-only')  return 'Person only';
  if (r.plan === 'skip')         return 'Skip';
  return 'Error';
}
function resultLabel(r) {
  if (r.personSynced) return r.accountSynced ? 'Synced (with company)' : 'Synced';
  if (r.skipReason)   return 'Skipped';
  return 'Failed';
}

function BundleRowList({ rows, expanded, toggleRow, bodiesShown, toggleBodies, mode }) {
  if (rows.length === 0) {
    return (
      <div style={{ padding: 20, textAlign: 'center', fontSize: 13, color: 'var(--muted)' }}>
        No rows.
      </div>
    );
  }
  return (
    <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
      {rows.map(r => (
        <BundleRow
          key={r.sourceId}
          r={r}
          isOpen={expanded.has(r.sourceId)}
          toggle={() => toggleRow(r.sourceId)}
          bodiesOpen={bodiesShown ? bodiesShown.has(r.sourceId) : false}
          toggleBodies={toggleBodies ? () => toggleBodies(r.sourceId) : null}
          mode={mode}
        />
      ))}
    </ul>
  );
}

function BundleRow({ r, isOpen, toggle, bodiesOpen, toggleBodies, mode }) {
  const tone  = mode === 'preview' ? previewTone(r.plan) : resultTone(r);
  const label = mode === 'preview' ? previewLabel(r)     : resultLabel(r);
  const detail = (mode === 'preview' && r.skipReason)  ? r.skipReason
               : (mode === 'preview' && r.plan === 'error') ? (r.error || 'unknown')
               : (mode === 'result'  && r.skipReason)  ? r.skipReason
               : (mode === 'result'  && !r.personSynced && r.error) ? r.error
               : null;

  return (
    <li
      style={{
        borderRadius: 10,
        background: isOpen ? `${tone}08` : 'rgba(255,255,255,0.015)',
        border: `1px solid ${isOpen ? tone + '55' : tone + '22'}`,
        transition: 'background 0.15s, border-color 0.15s',
      }}
    >
      <div
        onClick={toggle}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 12, padding: '11px 14px', cursor: 'pointer', userSelect: 'none',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0, flex: 1 }}>
          <ChevronRightIcon
            size={14}
            style={{
              color: 'var(--muted)', flexShrink: 0,
              transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)',
              transition: 'transform 0.18s cubic-bezier(0.4, 0, 0.2, 1)',
            }}
          />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div
              style={{
                fontSize: 13, fontWeight: 600,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                color: 'var(--text)',
              }}
            >
              {r.identifier || r.sourceId}
            </div>
            <div
              className="mono"
              style={{
                fontSize: 10, color: 'var(--muted)', marginTop: 2,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}
            >
              {r.sourceId}
            </div>
          </div>
        </div>
        <span
          style={{
            fontSize: 10, padding: '4px 10px', borderRadius: 99,
            background: `${tone}1a`, color: tone, border: `1px solid ${tone}55`,
            whiteSpace: 'nowrap', fontWeight: 700, letterSpacing: '0.3px',
            textTransform: 'uppercase', flexShrink: 0,
          }}
        >
          {label}
        </span>
      </div>

      {isOpen && (
        <div style={{ padding: '0 14px 12px 38px', fontSize: 12, color: 'var(--muted)' }}>
          {detail && (
            <div
              style={{
                padding: '8px 10px', borderRadius: 6,
                background: `${tone}10`, color: tone, marginBottom: 10,
                fontSize: 12, lineHeight: 1.4,
              }}
            >
              {detail}
            </div>
          )}

          {mode === 'preview' && (r.accountBody || r.personBody) && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: bodiesOpen ? 8 : 0 }}>
              <span style={{ fontSize: 11 }}>
                {r.accountBody ? '1 Account body + ' : ''}1 Person body to send
              </span>
              {toggleBodies && (
                <button
                  type="button"
                  onClick={e => { e.stopPropagation(); toggleBodies(); }}
                  style={{
                    fontSize: 11, padding: '4px 10px', borderRadius: 12,
                    border: '1px solid var(--border)',
                    background: 'transparent', color: 'var(--muted)', cursor: 'pointer',
                    fontWeight: 600,
                  }}
                >
                  {bodiesOpen ? 'Hide bodies' : 'Inspect bodies'}
                </button>
              )}
            </div>
          )}

          {mode === 'preview' && bodiesOpen && (
            <div
              style={{
                padding: 12, background: '#080c12', borderRadius: 8,
                fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)',
                overflow: 'auto', maxHeight: 280,
                border: '1px solid var(--border)',
              }}
            >
              {r.accountBody && (
                <>
                  <div style={{ color: BUNDLE_PURPLE_LIGHT, fontWeight: 700, marginBottom: 6, fontSize: 10, letterSpacing: '0.5px', textTransform: 'uppercase' }}>
                    Account → Marketo Company
                  </div>
                  <pre style={{ margin: 0, marginBottom: r.personBody ? 12 : 0 }}>{JSON.stringify(r.accountBody, null, 2)}</pre>
                </>
              )}
              {r.personBody && (
                <>
                  <div style={{ color: '#7dd3fc', fontWeight: 700, marginBottom: 6, fontSize: 10, letterSpacing: '0.5px', textTransform: 'uppercase' }}>
                    Person → Marketo Lead
                  </div>
                  <pre style={{ margin: 0 }}>{JSON.stringify(r.personBody, null, 2)}</pre>
                </>
              )}
            </div>
          )}

          {mode === 'result' && (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, fontSize: 12, lineHeight: 1.7 }}>
              <li><strong style={{ color: 'var(--text)' }}>Plan:</strong> {r.plan || 'n/a'}</li>
              <li>
                <strong style={{ color: 'var(--text)' }}>Company:</strong>{' '}
                {r.accountSynced
                  ? <span style={{ color: '#22c55e' }}>synced — id <code style={{ fontFamily: 'var(--mono)' }}>{r.accountTargetId || '?'}</code></span>
                  : <span>not synced</span>}
              </li>
              <li>
                <strong style={{ color: 'var(--text)' }}>Person:</strong>{' '}
                {r.personSynced
                  ? <span style={{ color: '#22c55e' }}>synced — id <code style={{ fontFamily: 'var(--mono)' }}>{r.personTargetId || '?'}</code></span>
                  : <span>not synced</span>}
              </li>
            </ul>
          )}
        </div>
      )}
    </li>
  );
}



function EventsDrawer({ drawer, onClose }) {
  const { source, sourceId, ident, events, loading, error } = drawer;
  const [expanded, setExpanded] = useState(() => new Set()); // event ids whose payload is shown

  function toggleExpand(id) {
    setExpanded(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  return (
    <div className="sv-drawer-backdrop" style={{ zIndex: 1100 }} onClick={onClose}>
      <aside
        className="panel"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-label="Per-record sync events"
        style={{
          position: 'fixed',
          top: 0, right: 0, bottom: 0,
          width: 'min(520px, 100vw)',
          background: 'var(--panel)',
          boxShadow: '-8px 0 32px rgba(0,0,0,0.5)',
          borderLeft: '1px solid var(--border)',
          zIndex: 1101,
          display: 'flex',
          flexDirection: 'column',
          margin: 0, borderRadius: 0,
          overflow: 'hidden',
        }}
      >
        <header style={{ padding: '24px 24px 12px', borderBottom: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <h2 style={{ margin: 0, fontSize: 18 }}>Sync Events History</h2>
            <button type="button" className="ghost" onClick={onClose} aria-label="Close drawer" style={{ padding: '4px 8px' }}>✕</button>
          </div>
          <div style={{ marginTop: 6, color: 'var(--muted)', fontSize: 13 }}>
            <span>{source.toUpperCase()}</span>
            <span style={{ margin: '0 8px', opacity: 0.5 }}>·</span>
            <span style={{ fontFamily: 'var(--mono)' }}>{ident || sourceId}</span>
          </div>
        </header>

        <div style={{ flex: 1, overflowY: 'auto', padding: 24 }}>
          {loading && <div className="empty" style={{ padding: 16 }}>Loading events…</div>}
          {error && <div className="sv-note err">{error}</div>}
          {!loading && !error && events.length === 0 && (
            <div className="empty" style={{ padding: 16 }}>
              No events for this record yet.
            </div>
          )}
          {!loading && !error && events.length > 0 && (
            <ul className="sv-drawer-timeline" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {events.map(evt => {
                const chipKind =
                  evt.status === 'success' ? 'success' :
                    evt.status === 'skipped' ? 'skipped' :
                      evt.status === 'failed' ? 'failed' : 'failed';
                const isOpen = expanded.has(evt.id);
                return (
                  <li
                    key={evt.id}
                    style={{
                      padding: '8px 0',
                      borderBottom: '1px solid var(--border, #eee)',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <span className={'chip ' + chipKind}>{evt.status}</span>
                      <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                        {source} → {source === 'dynamics' ? 'marketo' : 'dynamics'}
                      </span>
                      <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--muted)' }} title={evt.created_at}>
                        {relativeTime(evt.created_at)}
                      </span>
                    </div>
                    {formatEventReason(evt) && (
                      <div style={{ marginTop: 4, fontSize: 13, color: evt.status === 'failed' ? 'var(--err)' : 'var(--muted)', fontStyle: 'italic', lineHeight: 1.4 }}>
                        {formatEventReason(evt)}
                      </div>
                    )}
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => toggleExpand(evt.id)}
                      style={{ marginTop: 6, fontSize: 11, padding: '2px 6px' }}
                    >
                      {isOpen ? 'Hide payload' : 'Show payload'}
                      {evt.payload_truncated ? ' (truncated)' : ''}
                    </button>
                    {isOpen && (
                      <div 
                        className="msg-drawer-json"
                        style={{ marginTop: 8 }}
                        dangerouslySetInnerHTML={{ __html: prettyHighlightJson(evt.payload_preview) }}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </aside>
    </div>
  );
}

function Modal({ title, body, confirmLabel, danger, onCancel, onConfirm }) {
  return (
    <div className="sv-modal-backdrop" onClick={onCancel}>
      <div className="sv-modal" onClick={e => e.stopPropagation()}>
        <h3>{title}</h3>
        <div className="sv-modal-body">{body}</div>
        <div className="sv-modal-actions">
          <button className="ghost" onClick={onCancel}>Cancel</button>
          <button className={'primary' + (danger ? ' danger' : '')} onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
