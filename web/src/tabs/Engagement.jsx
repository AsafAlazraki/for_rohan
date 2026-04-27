import React, { useEffect, useMemo, useState, useCallback } from 'react';
import {
  getEngagementRecent, getEngagementStats,
  triggerEngagementRun
} from '../lib/api.js';
import { openSyncStream } from '../lib/sse.js';



// ─── constants ───────────────────────────────────────────────────────────
// Marketo activity type IDs we care about. Server returns numeric `type`
// plus a human `typeName`; the dropdown filters on the numeric id.
// Numeric IDs match the canonical Marketo activity-type IDs the backend
// emits (see src/engagement/activityWriter.js TYPE_LABELS): 1, 2, 7, 9, 10, 14.
const TYPE_FILTERS = [
  { value: '',   label: 'All types' },
  { value: '7',  label: 'Email Delivered' },
  { value: '10', label: 'Email Open' },
  { value: '9',  label: 'Email Click' },
  { value: '2',  label: 'Form Submit' },
  { value: '1',  label: 'Web Visit' },
  { value: '14', label: 'Campaign Response' },
];

const STATUS_FILTERS = [
  { value: '',          label: 'All' },
  { value: 'written',   label: 'Written' },
  { value: 'skipped',   label: 'Skipped' },
  { value: 'unmatched', label: 'Unmatched' },
];

// Coloured dot prefix per type — no emojis, just a tinted bullet.
function typeAccent(typeName = '') {
  const n = typeName.toLowerCase();
  if (n.includes('open'))      return 'var(--accent)';
  if (n.includes('click'))     return 'var(--ok)';
  if (n.includes('form'))      return 'var(--warn)';
  if (n.includes('web'))       return 'var(--accent)';
  if (n.includes('campaign'))  return 'var(--ok)';
  if (n.includes('delivered'))return 'var(--muted)';
  return 'var(--muted)';
}

// ─── helpers ─────────────────────────────────────────────────────────────
function relativeTime(iso) {
  if (!iso) return '—';
  const ms   = Date.now() - new Date(iso).getTime();
  const sec  = Math.round(ms / 1000);
  if (sec < 5)    return 'just now';
  if (sec < 60)   return `${sec}s ago`;
  const min  = Math.round(sec / 60);
  if (min < 60)   return `${min}m ago`;
  const hr   = Math.round(min / 60);
  if (hr  < 24)   return `${hr}h ago`;
  const day  = Math.round(hr / 24);
  return `${day}d ago`;
}

function formatDuration(ms) {
  if (ms == null) return '—';
  if (ms < 1000)  return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function StatusChip({ status }) {
  const cls =
    status === 'written'   ? 'eng-status-chip-written'   :
    status === 'skipped'   ? 'eng-status-chip-skipped'   :
    status === 'unmatched' ? 'eng-status-chip-unmatched' :
    status === 'preview'   ? 'eng-status-chip-preview'   :
                             'eng-status-chip-skipped';
  return <span className={'chip ' + cls}>{status}</span>;
}

// Normalize an SSE event into the same shape as a /recent row so the
// feed list renders both with one component.
function normalizeSseEvent(evt) {
  const e = evt.engagement || {};
  return {
    id:                evt.id || `sse-${e.activityId}-${evt.ts}`,
    marketoActivityId: e.activityId || null,
    type:              e.type,
    typeName:          e.typeName || 'Activity',
    contactEmail:      e.contactEmail || null,
    dynamicsContactId: null,
    dynamicsActivityId: null,
    assetName:         e.assetName || null,
    occurredAt:        evt.ts || new Date().toISOString(),
    status:            e.status || 'written',
    reason:            e.reason || null,
    _live:             true,
  };
}

// ─── stats panel ─────────────────────────────────────────────────────────
function StatsPanel({ stats, loading }) {
  if (loading && !stats) {
    return (
      <div className="panel"><div className="empty">Loading stats…</div></div>
    );
  }
  if (!stats) return null;

  const byType = stats.byType || {};
  const typeEntries = Object.entries(byType).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...typeEntries.map(([, v]) => v));

  const lr = stats.lastRun;

  return (
    <div className="panel">
      <h2>Stats</h2>
      <div className="eng-stats">
        <div className="eng-stat-card">
          <h3>Total ingested</h3>
          <div className="value">{(stats.totalIngested || 0).toLocaleString()}</div>
          <div className="sub">activities written across all runs</div>
        </div>

        <div className="eng-stat-card">
          <h3>Last run</h3>
          {lr ? (
            <>
              <div className="value">{lr.written || 0}<span className="value-unit"> written</span></div>
              <div className="sub">
                {relativeTime(lr.at)} · fetched {lr.fetched || 0} · filtered {lr.filtered || 0} · {formatDuration(lr.durationMs)}
              </div>
            </>
          ) : (
            <>
              <div className="value">—</div>
              <div className="sub">No runs yet. Click Run now to kick one off.</div>
            </>
          )}
        </div>

        <div className="eng-stat-card">
          <h3>By type</h3>
          {typeEntries.length === 0 ? (
            <div className="sub">Nothing ingested yet.</div>
          ) : (
            <ul className="eng-spark">
              {typeEntries.map(([name, count]) => (
                <li key={name}>
                  <span className="eng-spark-label">{name}</span>
                  <span className="eng-spark-bar">
                    <span
                      className="eng-spark-fill"
                      style={{ width: `${Math.round((count / max) * 100)}%` }}
                    />
                  </span>
                  <span className="eng-spark-count">{count}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── main component ──────────────────────────────────────────────────────
export default function Engagement({ flash }) {
  const [stats, setStats]         = useState(null);
  const [statsLoading, setStatsLoading] = useState(true);

  const [rows, setRows]           = useState([]);
  const [feedLoading, setFeedLoading] = useState(true);
  const [hasMore, setHasMore]     = useState(false);

  const [typeFilter, setTypeFilter]     = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  const [running, setRunning] = useState(false);

  // Only real mode is supported; simulation/dry-run logic removed.

  const PAGE_SIZE = 50;

  // ── loaders ───────────────────────────────────────────────────────────
  const loadStats = useCallback(async () => {
    setStatsLoading(true);
    try {
      const s = await getEngagementStats();
      setStats(s);
    } catch (e) {
      flash('err', `Stats load failed: ${e.message}`);
    } finally {
      setStatsLoading(false);
    }
  }, [flash]);

  const loadRecent = useCallback(async () => {
    setFeedLoading(true);
    try {
      const r = await getEngagementRecent({
        limit: PAGE_SIZE,
        type:  typeFilter || undefined,
      });
      const fetched = r.rows || [];
      setRows(fetched);
      setHasMore(fetched.length >= PAGE_SIZE);
    } catch (e) {
      flash('err', `Recent load failed: ${e.message}`);
    } finally {
      setFeedLoading(false);
    }
  }, [flash, typeFilter]);

  async function loadMore() {
    if (rows.length === 0) return;
    const oldest = rows[rows.length - 1].occurredAt;
    setFeedLoading(true);
    try {
      const r = await getEngagementRecent({
        limit: PAGE_SIZE,
        type:  typeFilter || undefined,
        // Server expected to interpret `since` as "older than this" via API
        // contract we mirror; if backend treats it strictly as ">=", the
        // worst case is duplicates which the de-dup below absorbs.
        since: oldest,
      });
      const more = r.rows || [];
      setRows(prev => {
        const seen = new Set(prev.map(x => x.id));
        const append = more.filter(x => !seen.has(x.id));
        return [...prev, ...append];
      });
      setHasMore(more.length >= PAGE_SIZE);
    } catch (e) {
      flash('err', `Load more failed: ${e.message}`);
    } finally {
      setFeedLoading(false);
    }
  }

  // ── mount: fetch stats + recent in parallel ──────────────────────────
  useEffect(() => {
    loadStats();
    loadRecent();
  }, [loadStats, loadRecent]);

  // ── SSE subscription (engagement-only) ───────────────────────────────
  useEffect(() => {
    const close = openSyncStream(
      (evt) => {
        if (evt.entityType !== 'engagement') return;
        const shaped = normalizeSseEvent(evt);
        setRows(prev => {
          // de-dup by marketoActivityId (preferred) or row id
          const key = shaped.marketoActivityId || shaped.id;
          const dup = prev.some(r =>
            (r.marketoActivityId && r.marketoActivityId === shaped.marketoActivityId) ||
            r.id === shaped.id
          );
          if (dup) return prev;
          return [shaped, ...prev];
        });
      },
      () => {/* EventSource auto-reconnects */},
    );
    return close;
  }, []);

  // Run now button — only real mode supported
  async function runNow() {
    setRunning(true);
    try {
      const r = await triggerEngagementRun();
      const s = r.summary || {};
      flash('ok', `Run complete: ${s.written || 0} written · ${s.skipped || 0} skipped · ${s.unmatched || 0} unmatched`);
      await Promise.all([loadStats(), loadRecent()]);
    } catch (e) {
      flash('err', `Run failed: ${e.message}`);
    } finally {
      setRunning(false);
    }
  }

  // Mode toggle handler removed — only real mode is supported.

  // ── client-side status filter (the type filter is server-side) ───────
  const filteredRows = useMemo(() => {
    if (!statusFilter) return rows;
    return rows.filter(r => r.status === statusFilter);
  }, [rows, statusFilter]);

  return (
    <>
      <StatsPanel stats={stats} loading={statsLoading} />

      {/* Controls */}
      <div className="panel">
        <h2>Filter & run</h2>
        <div className="eng-controls">
          <div>
            <label className="sv-lbl">Activity type</label>
            <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)}>
              {TYPE_FILTERS.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="sv-lbl">Status</label>
            <div className="eng-chip-row">
              {STATUS_FILTERS.map(s => (
                <button
                  key={s.value}
                  className={'eng-chip-btn' + (statusFilter === s.value ? ' active' : '')}
                  onClick={() => setStatusFilter(s.value)}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>

          <div className="spacer" />

          <button
            className={'primary'}
            disabled={running}
            onClick={runNow}
            title={'Fetch the latest engagement activities from Marketo and write them to Dynamics.'}
          >
            {running ? 'Running…' : 'Run now'}
          </button>
        </div>
      </div>

      {/* Live feed */}
      <div className="panel">
        <div className="row">
          <h2 style={{margin:0}}>Recent activity</h2>
          <div className="spacer" />
          <span style={{color:'var(--muted)', fontSize:12}}>
            {feedLoading && rows.length === 0
              ? 'Loading…'
              : `${previewRows.length + filteredRows.length} shown${statusFilter ? ' (filtered)' : ''}`}
          </span>
        </div>

        {/* Preview banner — appears after a SIM-mode Run preview */}
        {previewBanner && (
          <div className="sv-note" style={{borderColor: 'var(--accent)', color: 'var(--text)', marginBottom: 10}}>
            {previewBanner.demo ? (
              <>
                <strong>Marketo not configured</strong> — showing demo data.{' '}
                Configure credentials in Admin to run a real preview.
              </>
            ) : (
              <>
                Preview cycle complete. <strong>{previewBanner.count}</strong> activit{previewBanner.count === 1 ? 'y' : 'ies'} would be written.
                Toggle Real to actually persist.
              </>
            )}
          </div>
        )}

        {previewRows.length === 0 && filteredRows.length === 0 && !feedLoading && (
          <div className="empty">
            {rows.length === 0
              ? 'No engagement activities ingested yet. Click Run now or wait for the next 15-minute poll.'
              : 'No activities match the current filters.'}
          </div>
        )}

        {(previewRows.length > 0 || filteredRows.length > 0) && (
          <ul className="eng-feed event-list">
            {previewRows.map(r => (
              <li key={r.id} className="event-row eng-row">
                <div className="head eng-row-head">
                  <span
                    className="eng-type-dot"
                    style={{ background: 'var(--accent)' }}
                    aria-hidden="true"
                  />
                  <span className="eng-type-label">{r.typeName || `type ${r.type}`}</span>
                  <span className="email eng-email">
                    {r.contactEmail || '(no contact)'}
                  </span>
                  <span className="eng-asset">{r.assetName || '—'}</span>
                  <StatusChip status="preview" />
                  <span
                    className="ts"
                    title={r.occurredAt ? new Date(r.occurredAt).toLocaleString() : ''}
                  >
                    {relativeTime(r.occurredAt)}
                  </span>
                </div>
                {r.reason && (
                  <div className="eng-reason">
                    <span className="eng-reason-label">reason</span>
                    <span className="eng-reason-text">{r.reason}</span>
                  </div>
                )}
              </li>
            ))}
            {filteredRows.map(r => (
              <li key={r.id} className="event-row eng-row">
                <div className="head eng-row-head">
                  <span
                    className="eng-type-dot"
                    style={{ background: typeAccent(r.typeName) }}
                    aria-hidden="true"
                  />
                  <span className="eng-type-label">{r.typeName || `type ${r.type}`}</span>
                  <span className="email eng-email">
                    {r.contactEmail || '(no contact)'}
                  </span>
                  <span className="eng-asset">{r.assetName || '—'}</span>
                  <StatusChip status={r.status} />
                  <span
                    className="ts"
                    title={r.occurredAt ? new Date(r.occurredAt).toLocaleString() : ''}
                  >
                    {relativeTime(r.occurredAt)}
                  </span>
                </div>
                {r.reason && (
                  <div className="eng-reason">
                    <span className="eng-reason-label">reason</span>
                    <span className="eng-reason-text">{r.reason}</span>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}

        {hasMore && filteredRows.length > 0 && (
          <div className="pager">
            <button className="ghost" disabled={feedLoading} onClick={loadMore}>
              {feedLoading ? 'Loading…' : 'Load more'}
            </button>
          </div>
        )}
      </div>

      {/* Confirm switching TO Real mode (mirrors Sync View) */}
      {confirmReal && (
        <div className="sv-modal-backdrop" onClick={() => setConfirmReal(false)}>
          <div className="sv-modal" onClick={e => e.stopPropagation()}>
            <h3>Switch to Real World mode?</h3>
            <div className="sv-modal-body">
              <p>
                Switching to Real World mode. The next <strong>Run now</strong> will
                write Marketing Engagement Activity records to <strong>live Dynamics</strong>. Continue?
              </p>
            </div>
            <div className="sv-modal-actions">
              <button className="ghost" onClick={() => setConfirmReal(false)}>Cancel</button>
              <button
                className="primary danger"
                onClick={() => {
                  setRealMode(true);
                  setConfirmReal(false);
                  setPreviewBanner(null);
                  setPreviewRows([]);
                }}
              >
                Yes, enable Real mode
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
