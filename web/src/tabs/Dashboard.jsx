import React, { useCallback, useEffect, useState } from 'react';
import { getEventStats } from '../lib/api.js';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer } from 'recharts';

/* ── Reusable info-tooltip popover ────────────────────────────────────────── */
function InfoPopover({ text }) {
  return (
    <div className="info-popover-anchor">
      <span className="info-trigger">ℹ</span>
      <div className="info-popover">
        <div className="info-popover-arrow" />
        <p>{text}</p>
      </div>
    </div>
  );
}

export default function Dashboard({ flash }) {
  const [stats, setStats]               = useState(null);
  const [graphData, setGraphData]       = useState([]);
  const [statsLoading, setStatsLoading] = useState(true);
  const [graphLoading, setGraphLoading] = useState(false);
  const [graphPeriod, setGraphPeriod]   = useState('24h');
  const [lastRefreshed, setLastRefreshed] = useState(null);

  // Number of inbound webhook sources shown on the Webhooks page
  const INBOUND_WEBHOOK_COUNT = 2; // Dynamics 365 + Marketo

  // Fetch metric cards + initial graph (runs once on mount)
  const loadStats = useCallback(() => {
    setStatsLoading(true);
    getEventStats(graphPeriod)
      .then(data => {
        setStats(data);
        setGraphData(data.graphData || []);
        setLastRefreshed(new Date());
      })
      .catch(e => { if (flash) flash('err', `Load stats failed: ${e.message}`); })
      .finally(() => setStatsLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flash]);

  // Fetch graph data only — called when period changes or refresh clicked
  const loadGraph = useCallback((period) => {
    setGraphLoading(true);
    getEventStats(period)
      .then(data => {
        setGraphData(data.graphData || []);
        setLastRefreshed(new Date());
      })
      .catch(e => { if (flash) flash('err', `Load graph failed: ${e.message}`); })
      .finally(() => setGraphLoading(false));
  }, [flash]);

  // Initial load
  useEffect(() => { loadStats(); }, [loadStats]);

  // Period change — only re-fetch graph
  useEffect(() => {
    if (!stats) return; // don't double-fetch on first mount
    loadGraph(graphPeriod);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphPeriod]);

  if (!stats) {
    return <div style={{ padding: '2rem' }}>Loading dashboard data...</div>;
  }

  const statusColor = stats.syncStatus === 'Healthy'  ? 'green'
                    : stats.syncStatus === 'Degraded' ? 'orange'
                    : 'red';

  const graphLabel = graphPeriod === '24h' ? '24-Hour'
                   : graphPeriod === '7d'  ? '7-Day'
                   : '30-Day';

  return (
    <>
      {/* ─── Page header: refresh control ─── */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 12, marginBottom: '1.5rem' }}>
        {lastRefreshed && (
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>
            Refreshed {lastRefreshed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
          </span>
        )}
        <button
          onClick={loadStats}
          disabled={statsLoading}
          style={{
            background: 'transparent',
            border: '1px solid var(--border)',
            color: statsLoading ? 'var(--muted)' : 'var(--fg)',
            borderRadius: 6,
            padding: '5px 12px',
            cursor: statsLoading ? 'not-allowed' : 'pointer',
            fontSize: 12,
            display: 'flex', alignItems: 'center', gap: 4,
          }}
        >
          {statsLoading ? '↻ Refreshing…' : '↻ Refresh'}
        </button>
      </div>

      {/* ─── Overview Stats Grid ─── */}
      <div className="overview-stats" style={{ marginBottom: '2rem' }}>
        <div className="stat-card blue">
          <InfoPopover text="Total number of sync events processed by the system. The sub-metric shows the absolute count of records synced in the trailing 24 hours." />
          <div className="stat-icon">⇄</div>
          <div className="stat-label">Total Records Synced</div>
          <div className="stat-value">{stats.totalEvents > 0 ? stats.totalEvents.toLocaleString() : '—'}</div>
          <div className="stat-sub positive">
            {stats.count24h.toLocaleString()} synced last 24h
          </div>
        </div>

        <div className="stat-card red">
          <InfoPopover text="Total number of sync events that ended in a 'failed' status. The sub-metric shows how many of those failures occurred in the trailing 24 hours." />
          <div className="stat-icon">⚠</div>
          <div className="stat-label">Total Sync Errors</div>
          <div className="stat-value">{stats.totalErrors.toLocaleString()}</div>
          <div className="stat-sub negative">
            {stats.recentErrors.toLocaleString()} failed last 24h
          </div>
        </div>

        <div className="stat-card purple">
          <InfoPopover text="Number of inbound webhook sources feeding data into the sync pipeline. These are the Dynamics 365 and Marketo webhooks displayed on the Webhooks page." />
          <div className="stat-icon">⎈</div>
          <div className="stat-label">Active Webhooks</div>
          <div className="stat-value">{INBOUND_WEBHOOK_COUNT}</div>
        </div>

        <div className={`stat-card ${statusColor}`}>
          <InfoPopover text="Overall system health based on recent failures and queue depth. Healthy: 0 failures in the last hour and fewer than 50 stale pending events. Degraded: 1–10 failures or 50–100 stale pending. Unhealthy: more than 10 failures or more than 100 stale pending." />
          <div className="stat-icon">{stats.syncStatus === 'Healthy' ? '✓' : '⚠'}</div>
          <div className="stat-label">Sync Status</div>
          <div className="stat-value">{stats.syncStatus}</div>
        </div>
      </div>

      {/* ─── Activity Graph ─── */}
      <div className="panel" style={{ padding: '1.5rem', position: 'relative' }}>
        {/* Header row */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' }}>
          {/* Title + popover */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <h3 style={{ margin: 0 }}>{graphLabel} Activity</h3>
            <InfoPopover text={`Volume of sync events per ${graphPeriod === '24h' ? 'hour over the trailing 24 hours' : `day over the trailing ${graphPeriod === '7d' ? '7 days' : '30 days'}`}. Each point represents one ${graphPeriod === '24h' ? 'clock-hour' : 'calendar-day'} bucket.`} />
          </div>

          {/* Controls */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {/* Period toggle */}
            <div style={{ display: 'flex', backgroundColor: 'var(--panel-bg)', borderRadius: 6, padding: 4, border: '1px solid var(--border)' }}>
              {['24h', '7d', '30d'].map(p => (
                <button
                  key={p}
                  onClick={() => setGraphPeriod(p)}
                  style={{
                    backgroundColor: graphPeriod === p ? 'rgba(255,255,255,0.1)' : 'transparent',
                    color: graphPeriod === p ? 'var(--fg)' : 'var(--muted)',
                    border: 'none',
                    padding: '4px 12px',
                    borderRadius: 4,
                    cursor: 'pointer',
                    fontSize: 12,
                    fontWeight: graphPeriod === p ? 600 : 400,
                  }}
                >
                  {p.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Chart */}
        <div style={{ width: '100%', height: 300, opacity: graphLoading ? 0.5 : 1, transition: 'opacity 0.2s' }}>
          <ResponsiveContainer>
            <AreaChart data={graphData} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="colorCount" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor="#8884d8" stopOpacity={0.8}/>
                  <stop offset="95%" stopColor="#8884d8" stopOpacity={0}/>
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#333" vertical={false} />
              <XAxis dataKey="hourLabel" stroke="#888" tick={{ fill: '#888' }} />
              <YAxis stroke="#888" tick={{ fill: '#888' }} />
              <RechartsTooltip
                contentStyle={{ backgroundColor: '#1e1e1e', borderColor: '#333', color: '#fff' }}
                itemStyle={{ color: '#8884d8' }}
              />
              <Area type="monotone" dataKey="count" name="Events" stroke="#8884d8" fillOpacity={1} fill="url(#colorCount)" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      <style>{`
        /* ── Info popover positioning ─────────────────────────── */
        .info-popover-anchor {
          position: absolute;
          top: 10px;
          right: 10px;
          z-index: 100;
        }

        .info-trigger {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 20px;
          height: 20px;
          border-radius: 50%;
          background: rgba(255, 255, 255, 0.08);
          border: 1px solid rgba(255, 255, 255, 0.15);
          font-size: 11px;
          cursor: help;
          color: rgba(255, 255, 255, 0.6);
          transition: all 0.2s ease;
          font-weight: bold;
        }
        .info-trigger:hover {
          background: rgba(255, 255, 255, 0.2);
          color: #fff;
          border-color: var(--accent);
          box-shadow: 0 0 8px rgba(56, 189, 248, 0.3);
        }

        /* ── Popover card ─────────────────────────────────────── */
        .info-popover {
          display: none;
          position: absolute;
          top: calc(100% + 12px);
          right: -8px;
          width: 280px;
          padding: 16px;
          border-radius: 12px;
          background: rgba(13, 17, 23, 0.98);
          backdrop-filter: blur(20px);
          -webkit-backdrop-filter: blur(20px);
          border: 1px solid rgba(255, 255, 255, 0.2);
          box-shadow: 0 12px 48px rgba(0, 0, 0, 0.8),
                      0 0 0 1px rgba(255, 255, 255, 0.05);
          z-index: 5000;
          animation: popoverIn 0.2s cubic-bezier(0.16, 1, 0.3, 1);
        }

        /* Adjust the last card's popover to open leftwards */
        .stat-card:last-child .info-popover {
          right: auto;
          left: -250px;
        }
        .stat-card:last-child .info-popover-arrow {
          right: 14px;
        }

        .info-popover p {
          margin: 0;
          font-size: 13px;
          line-height: 1.6;
          color: rgba(255, 255, 255, 0.95);
          font-weight: 400;
          white-space: normal;
          word-wrap: break-word;
        }

        /* Arrow positioning */
        .info-popover-arrow {
          position: absolute;
          width: 12px;
          height: 12px;
          background: rgba(13, 17, 23, 0.98);
          border-left: 1px solid rgba(255, 255, 255, 0.2);
          border-top: 1px solid rgba(255, 255, 255, 0.2);
          transform: rotate(45deg);
          right: 12px;
          top: -7px;
        }

        /* Show on hover */
        .info-popover-anchor:hover .info-popover {
          display: block;
        }

        @keyframes popoverIn {
          from { opacity: 0; transform: translateY(-8px) scale(0.95); }
          to   { opacity: 1; transform: translateY(0) scale(1); }
        }

        /* ── Stacking Fix ────────────────────────────────── */
        .stat-card {
          position: relative;
          z-index: 1;
          transition: z-index 0s step-end;
        }
        .stat-card:hover {
          z-index: 100;
          transition: z-index 0s step-start;
        }

        /* ── Orange state for Degraded status ─────────────────── */
        .stat-card.orange {
          border-left-color: #ff9800;
        }
        .stat-card.orange .stat-icon {
          color: #ff9800;
          background: rgba(255, 152, 0, 0.1);
        }

        /* ── Graph panel positioning ──── */
        .panel {
          position: relative;
          z-index: 5;
        }
        .panel .info-popover-anchor {
          position: relative;
          top: auto;
          right: auto;
        }
        .panel .info-popover {
          right: auto;
          left: -8px;
          top: calc(100% + 12px);
        }
        .panel .info-popover-arrow {
          right: auto;
          left: 12px;
        }
      `}</style>
    </>
  );
}
