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

      {/* Bundle sync row — Sync with Company */}
      {(entity === 'contact' || entity === 'lead') && !inListMode && (
        <div
          className="sv-bundle-row"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 16,
            margin: '0 24px 16px',
            padding: '12px 18px',
            borderRadius: 12,
            background: 'rgba(168, 85, 247, 0.06)',
            border: '1px solid rgba(168, 85, 247, 0.2)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1 }}>
            <Building2 size={18} style={{ color: '#c4b5fd' }} />
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>
                Sync with Company
              </div>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                Push the selected {entity}{selectedDyn.length === 1 ? '' : 's'} together with their associated Account / Company.
                {selectedDyn.length > 0 && ` (${selectedDyn.length} selected)`}
              </div>
            </div>
          </div>
          <button
            type="button"
            disabled={!bundleEligible || transferring}
            onClick={onBundleSyncClick}
            title={
              !bundleEligible
                ? (selectedDyn.length === 0
                    ? 'Select ≥1 Dynamics-side row first'
                    : direction === 'm2d'
                      ? 'Bundle sync only runs Dynamics → Marketo'
                      : 'Not available')
                : `Preview ${selectedDyn.length} row${selectedDyn.length === 1 ? '' : 's'} before pushing`
            }
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              height: 38,
              padding: '0 18px',
              borderRadius: 19,
              border: 'none',
              background: bundleEligible ? '#a855f7' : 'rgba(168, 85, 247, 0.18)',
              color: bundleEligible ? '#fff' : 'rgba(196, 181, 253, 0.55)',
              fontSize: 13,
              fontWeight: 700,
              cursor: bundleEligible && !transferring ? 'pointer' : 'not-allowed',
              boxShadow: bundleEligible ? '0 4px 12px rgba(168, 85, 247, 0.25)' : 'none',
              transition: 'all 0.2s ease',
            }}
          >
            <Building2 size={14} />
            Sync with Company
          </button>
        </div>
      )}

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

        <div className={'sv-arrow dir-' + direction + (flying ? ' flying' : '')} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 20 }}>
          <div className="sv-arrow-track">
            <span className="sv-arrow-glyph">{directionGlyph}</span>
          </div>
          
          <button
            className="primary danger"
            disabled={transferring || currentRule.kind === 'forbidden'}
            onClick={onSyncClick}
            title={currentRule.kind === 'forbidden' ? currentRule.note : undefined}
            style={{
              height: 48,
              padding: '0 40px',
              fontWeight: 700,
              fontSize: 15,
              borderRadius: 24,
              boxShadow: currentRule.kind === 'forbidden' ? 'none' : '0 4px 12px rgba(235, 87, 87, 0.3)',
              transition: 'all 0.2s ease',
              width: 180,
              cursor: currentRule.kind === 'forbidden' ? 'not-allowed' : 'pointer',
              opacity: currentRule.kind === 'forbidden' ? 0.4 : 1,
            }}
          >
            {transferring
              ? (inListMode ? 'Working…' : 'Syncing…')
              : inListMode
                ? 'Push as Named List'
                : 'Sync Selected'}
          </button>

          {!inListMode && (
            <button
              className="ghost"
              disabled={transferring || currentRule.kind === 'forbidden'}
              onClick={onSyncAllClick}
              title={currentRule.kind === 'forbidden' ? currentRule.note : undefined}
              style={{
                marginTop: -8,
                fontSize: 13,
                fontWeight: 600,
                color: 'var(--accent)',
                padding: '8px 16px',
                borderRadius: 20,
                background: 'rgba(56, 189, 248, 0.05)',
                border: '1px solid rgba(56, 189, 248, 0.1)',
                cursor: currentRule.kind === 'forbidden' ? 'not-allowed' : 'pointer',
                opacity: currentRule.kind === 'forbidden' ? 0.4 : 1,
              }}
            >
              Sync All Records
            </button>
          )}

          <div className="sv-arrow-label" style={{ fontSize: 12, opacity: 0.6 }}>
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
function BundleSyncModal({ preview, progress, result, entity, onCancel, onConfirm, onClose }) {
  const [expanded, setExpanded] = useState(() => new Set());

  function toggleRow(id) {
    setExpanded(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  // Three render modes: preview, progress, result.
  const showPreview  = preview && !progress && !result;
  const showProgress = !!progress;
  const showResult   = !!result && !progress;

  return (
    <div className="sv-modal-backdrop" style={{ zIndex: 1200 }}>
      <div
        className="sv-modal"
        onClick={e => e.stopPropagation()}
        style={{ width: 'min(720px, 92vw)', maxHeight: '85vh', display: 'flex', flexDirection: 'column' }}
      >
        <div
          className="sv-modal-title"
          style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '18px 22px', borderBottom: '1px solid var(--border)' }}
        >
          <Building2 size={18} style={{ color: '#c4b5fd' }} />
          <span style={{ fontSize: 16, fontWeight: 700 }}>
            {showPreview && 'Sync with Company — Preview'}
            {showProgress && 'Syncing…'}
            {showResult && 'Sync Complete'}
          </span>
        </div>

        <div className="sv-modal-body" style={{ flex: 1, overflowY: 'auto', padding: 22 }}>
          {showPreview && <BundlePreviewBody preview={preview} entity={entity} expanded={expanded} toggleRow={toggleRow} />}
          {showProgress && <BundleProgressBody progress={progress} />}
          {showResult && <BundleResultBody result={result} entity={entity} expanded={expanded} toggleRow={toggleRow} />}
        </div>

        <div className="sv-modal-actions" style={{ padding: '14px 22px', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          {showPreview && (
            <>
              <button type="button" className="ghost" onClick={onCancel}>Cancel</button>
              <button
                type="button"
                disabled={preview.summary.total === 0 || (preview.summary.willSkip + preview.summary.errors === preview.summary.total)}
                onClick={onConfirm}
                style={{
                  padding: '8px 18px',
                  borderRadius: 19,
                  border: 'none',
                  background: '#a855f7',
                  color: '#fff',
                  fontWeight: 700,
                  cursor: 'pointer',
                  boxShadow: '0 4px 12px rgba(168, 85, 247, 0.25)',
                }}
              >
                Push {preview.summary.withCompany + preview.summary.personOnly} now
              </button>
            </>
          )}
          {showProgress && (
            <button type="button" className="ghost" disabled>Working…</button>
          )}
          {showResult && (
            <button type="button" className="primary" onClick={onClose}>Close</button>
          )}
        </div>
      </div>
    </div>
  );
}

function BundleSummaryCounts({ counts }) {
  const items = [
    { label: 'With company', value: counts.withCompany,  color: '#a855f7' },
    { label: 'Person only',  value: counts.personOnly,   color: '#7dd3fc' },
    { label: 'Will skip',    value: counts.willSkip,     color: '#facc15' },
    { label: 'Errors',       value: counts.errors,       color: '#ef4444' },
  ].filter(i => i.value !== undefined);

  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${items.length}, 1fr)`, gap: 10, marginBottom: 18 }}>
      {items.map(i => (
        <div
          key={i.label}
          style={{
            padding: '12px',
            borderRadius: 10,
            background: `${i.color}10`,
            border: `1px solid ${i.color}33`,
            textAlign: 'center',
          }}
        >
          <div style={{ fontSize: 22, fontWeight: 800, color: i.color, lineHeight: 1.2 }}>{i.value}</div>
          <div style={{ fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginTop: 4 }}>{i.label}</div>
        </div>
      ))}
    </div>
  );
}

function BundlePreviewBody({ preview, entity, expanded, toggleRow }) {
  return (
    <>
      <p style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--muted)' }}>
        Reviewing <strong>{preview.summary.total}</strong> {entity}{preview.summary.total === 1 ? '' : 's'}. Click a row to expand.
      </p>
      <BundleSummaryCounts counts={preview.summary} />
      <BundleRowList rows={preview.rows} expanded={expanded} toggleRow={toggleRow} mode="preview" />
    </>
  );
}

function BundleProgressBody({ progress }) {
  return (
    <div style={{ padding: '40px 0', textAlign: 'center' }}>
      <RefreshCw size={32} className="spin" style={{ color: '#a855f7', marginBottom: 16 }} />
      <div style={{ fontSize: 15, fontWeight: 600 }}>
        Syncing {progress.current} of {progress.total}…
      </div>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>
        Sequential — Account first, then Person. Failures don't abort the batch.
      </div>
    </div>
  );
}

function BundleResultBody({ result, entity, expanded, toggleRow }) {
  return (
    <>
      <p style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--muted)' }}>
        Pushed <strong>{result.summary.total}</strong> {entity}{result.summary.total === 1 ? '' : 's'}. Click a row for detail.
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 18 }}>
        <ResultStat label="Persons synced"  value={result.summary.personsSynced}  color="#22c55e" />
        <ResultStat label="Companies synced" value={result.summary.accountsSynced} color="#a855f7" />
        <ResultStat label="Skipped"         value={result.summary.skipped}        color="#facc15" />
        <ResultStat label="Failed"          value={result.summary.failed}         color="#ef4444" />
      </div>
      <BundleRowList rows={result.results} expanded={expanded} toggleRow={toggleRow} mode="result" />
    </>
  );
}

function ResultStat({ label, value, color }) {
  return (
    <div style={{ padding: 12, borderRadius: 10, background: `${color}10`, border: `1px solid ${color}33`, textAlign: 'center' }}>
      <div style={{ fontSize: 22, fontWeight: 800, color, lineHeight: 1.2 }}>{value}</div>
      <div style={{ fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginTop: 4 }}>{label}</div>
    </div>
  );
}

function BundleRowList({ rows, expanded, toggleRow, mode }) {
  return (
    <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
      {rows.map(r => {
        const isOpen = expanded.has(r.sourceId);
        const tone =
          mode === 'preview'
            ? (r.plan === 'with-company' ? '#a855f7'
              : r.plan === 'person-only' ? '#7dd3fc'
              : r.plan === 'skip'        ? '#facc15'
              :                            '#ef4444')
            : (r.personSynced            ? '#22c55e'
              : r.skipReason             ? '#facc15'
              :                            '#ef4444');

        const label =
          mode === 'preview'
            ? (r.plan === 'with-company' ? 'Sync Person + Company'
              : r.plan === 'person-only' ? 'Person only — no company'
              : r.plan === 'skip'        ? `Skip — ${r.skipReason}`
              :                            `Error — ${r.error || 'unknown'}`)
            : (r.personSynced
                ? `Synced${r.accountSynced ? ' (with company)' : ''}`
                : r.skipReason
                  ? `Skipped — ${r.skipReason}`
                  : `Failed — ${r.error || 'unknown'}`);

        return (
          <li
            key={r.sourceId}
            style={{
              padding: '10px 12px',
              borderRadius: 8,
              background: 'rgba(255,255,255,0.02)',
              border: `1px solid ${tone}33`,
            }}
          >
            <div
              onClick={() => toggleRow(r.sourceId)}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, cursor: 'pointer' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                {isOpen ? <ChevronDown size={14} style={{ color: 'var(--muted)' }} /> : <ChevronRightIcon size={14} style={{ color: 'var(--muted)' }} />}
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {r.identifier || r.sourceId}
                  </div>
                  <div className="mono" style={{ fontSize: 10, color: 'var(--muted)', marginTop: 2 }}>{r.sourceId}</div>
                </div>
              </div>
              <span
                className="chip"
                style={{
                  fontSize: 10,
                  padding: '3px 8px',
                  borderRadius: 999,
                  background: `${tone}22`,
                  color: tone,
                  border: `1px solid ${tone}55`,
                  whiteSpace: 'nowrap',
                }}
              >
                {label}
              </span>
            </div>
            {isOpen && (
              <div style={{ marginTop: 8, padding: 10, background: '#080c12', borderRadius: 6, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)', overflow: 'auto' }}>
                {mode === 'preview' && (
                  <>
                    {r.accountBody && (
                      <>
                        <div style={{ color: '#c4b5fd', fontWeight: 700, marginBottom: 4 }}>Account body (Marketo Company)</div>
                        <pre style={{ margin: 0, marginBottom: 10 }}>{JSON.stringify(r.accountBody, null, 2)}</pre>
                      </>
                    )}
                    {r.personBody && (
                      <>
                        <div style={{ color: '#7dd3fc', fontWeight: 700, marginBottom: 4 }}>Person body (Marketo Lead)</div>
                        <pre style={{ margin: 0 }}>{JSON.stringify(r.personBody, null, 2)}</pre>
                      </>
                    )}
                    {!r.accountBody && !r.personBody && r.error && (
                      <div style={{ color: '#ef4444' }}>{r.error}</div>
                    )}
                  </>
                )}
                {mode === 'result' && (
                  <>
                    <div>Plan: {r.plan || 'n/a'}</div>
                    <div>Account synced: {r.accountSynced ? `yes (id ${r.accountTargetId || '?'})` : 'no'}</div>
                    <div>Person synced: {r.personSynced ? `yes (id ${r.personTargetId || '?'})` : 'no'}</div>
                    {r.skipReason && <div>Skip reason: {r.skipReason}</div>}
                    {r.error && <div style={{ color: '#ef4444' }}>Error: {r.error}</div>}
                  </>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ul>
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
