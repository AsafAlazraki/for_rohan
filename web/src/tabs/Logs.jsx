import React, { useState, useEffect, useCallback, useRef } from 'react';
import { 
  Search, 
  RefreshCw, 
  ChevronLeft, 
  ChevronRight, 
  Eye, 
  Copy, 
  Filter, 
  X,
  CheckCircle2,
  AlertCircle,
  Clock,
  ExternalLink
} from 'lucide-react';
import { getEvents } from '../lib/api.js';
import { openSyncStream } from '../lib/sse.js';

const PAGE_SIZE = 25;

function relativeTime(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return String(iso);
  const diff = Math.max(0, Date.now() - then);
  const s = Math.floor(diff / 1000);
  if (s < 60)      return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60)      return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24)      return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function syntaxHighlight(json) {
  if (typeof json !== 'string') {
    json = JSON.stringify(json, null, 2);
  }
  if (!json) return '';
  json = json.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return json.replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, function (match) {
    let cls = 'json-number';
    if (/^"/.test(match)) {
      if (/:$/.test(match)) {
        cls = 'json-key';
      } else {
        cls = 'json-string';
      }
    } else if (/true|false/.test(match)) {
      cls = 'json-boolean';
    } else if (/null/.test(match)) {
      cls = 'json-null';
    }
    return '<span class="' + cls + '">' + match + '</span>';
  });
}

function getStatusIcon(state) {
  const s = (state || '').toLowerCase();
  if (s === 'success' || s === 'completed') return <CheckCircle2 size={14} className="text-ok" style={{ color: 'var(--ok)' }} />;
  if (s === 'failed' || s === 'error') return <AlertCircle size={14} className="text-err" style={{ color: 'var(--err)' }} />;
  if (s === 'skipped') return <span style={{ color: 'var(--muted)', width: 14, display: 'inline-block', textAlign: 'center' }}>—</span>;
  return <Clock size={14} className="text-warn" style={{ color: 'var(--warn)' }} />;
}

function FieldDiff({ sourceFields, targetFields, source, target }) {
  const sKeys = Object.keys(sourceFields || {});
  const tKeys = Object.keys(targetFields || {});
  return (
    <div className="diff" style={{ display: 'flex', gap: 24, marginTop: 16 }}>
      <div className="col" style={{ flex: 1 }}>
        <h3 style={{ margin: '0 0 12px 0', fontSize: 13, color: 'var(--muted)', textTransform: 'uppercase' }}>{source} fields (source)</h3>
        {sKeys.length === 0 && <div className="empty" style={{padding:8}}>—</div>}
        {sKeys.map(k => (
          <div key={k} className="kv" style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: '1px solid var(--border)' }}>
            <span className="k" style={{ color: 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 12 }}>{k}</span>
            <span className="v" style={{ fontSize: 13 }}>{String(sourceFields[k])}</span>
          </div>
        ))}
      </div>
      <div className="col" style={{ flex: 1 }}>
        <h3 style={{ margin: '0 0 12px 0', fontSize: 13, color: 'var(--muted)', textTransform: 'uppercase' }}>{target} fields (target, mapped)</h3>
        {tKeys.length === 0 && <div className="empty" style={{padding:8}}>—</div>}
        {tKeys.map(k => (
          <div key={k} className="kv" style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: '1px solid var(--border)' }}>
            <span className="k" style={{ color: 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 12 }}>{k}</span>
            <span className="v" style={{ fontSize: 13 }}>{String(targetFields[k])}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function normalize(row) {
  if (row.sourceFields || row.targetFields) {
    return {
      id: row.id,
      source: row.source,
      target: row.target,
      status: row.status,
      entityType: row.entityType || 'contact',
      email:  row.email,
      ts:     row.ts,
      sourceFields: row.sourceFields || {},
      targetFields: row.targetFields || {},
      error:  row.error,
      reason: row.reason,
      _live:  true,
    };
  }
  const payload = row.payload || {};
  return {
    id:     row.id,
    source: row.source_system,
    target: row.target_system,
    status: row.status,
    entityType: row.source_type || 'contact',
    email:  payload.email || payload.emailaddress1 || null,
    ts:     row.created_at,
    sourceFields: payload,
    targetFields: {},
    error:  row.error_message,
    _live:  false,
  };
}

export default function Logs({ flash }) {
  const [events, setEvents] = useState([]);
  const [pagination, setPagination] = useState({ total: 0, page: 1, limit: PAGE_SIZE, pages: 0 });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [selectedEvent, setSelectedEvent] = useState(null);
  
  const [statusFilter, setStatusFilter] = useState('');
  const [entityFilter, setEntityFilter] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const searchTimeout = useRef(null);

  // Keep references to current filters to use inside SSE without recreating the subscription
  const filtersRef = useRef({ page: 1, status: '', entityType: '', search: '' });

  useEffect(() => {
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(() => {
      setDebouncedSearch(searchQuery);
    }, 400);
    return () => clearTimeout(searchTimeout.current);
  }, [searchQuery]);

  useEffect(() => {
    filtersRef.current = { page: pagination.page, status: statusFilter, entityType: entityFilter, search: debouncedSearch };
  }, [pagination.page, statusFilter, entityFilter, debouncedSearch]);

  const fetchEvents = useCallback(async (page = 1) => {
    setLoading(true);
    setError(null);
    try {
      const res = await getEvents({
        page,
        limit: pagination.limit,
        status: statusFilter,
        entityType: entityFilter,
        search: debouncedSearch
      });
      // Filter out live events if they don't match, or just rely on backend rows
      // Best to just use backend rows and let live ones prepend if we are on page 1
      setEvents(res.rows.map(normalize));
      setPagination({ total: res.total, page: res.page, limit: res.limit, pages: res.pages });
    } catch (e) {
      setError(e.message);
      if (flash) flash('err', `Load failed: ${e.message}`);
    } finally {
      setLoading(false);
    }
  }, [pagination.limit, statusFilter, entityFilter, debouncedSearch, flash]);

  useEffect(() => {
    fetchEvents(1);
  }, [fetchEvents]);

  // Live stream
  useEffect(() => {
    const close = openSyncStream(
      (evt) => {
        const { page, status, entityType, search } = filtersRef.current;
        if (page !== 1) return; // Only prepend on first page

        const shaped = normalize(evt);

        // Simple local filtering for live events
        if (status && shaped.status.toLowerCase() !== status.toLowerCase()) return;
        if (entityType && (shaped.entityType || '').toLowerCase() !== entityType.toLowerCase()) return;
        if (search) {
          const sStr = search.toLowerCase();
          const jStr = JSON.stringify(shaped).toLowerCase();
          if (!jStr.includes(sStr)) return;
        }

        setEvents(prev => {
          if (prev.some(e => e.id === shaped.id)) return prev;
          return [shaped, ...prev];
        });
      },
      () => {}
    );
    return close;
  }, []);

  function copyToClipboard(payload) {
    if (payload) {
      const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
      navigator.clipboard.writeText(text)
        .then(() => alert('Copied to clipboard!'))
        .catch(err => console.error('Failed to copy: ', err));
    }
  }

  return (
    <>
      <div className="panel" style={{ minHeight: 'calc(100vh - 200px)', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
          <div>
            <h2 style={{ margin: 0 }}>Live sync feed</h2>
            <p style={{ margin: '4px 0 0 0', fontSize: 13, color: 'var(--muted)' }}>
              Real-time synchronization logs and payload history
            </p>
          </div>
          <button className="ghost" onClick={() => fetchEvents(pagination.page)} disabled={loading} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <RefreshCw size={16} className={loading ? 'spin' : ''} />
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>

        {/* Filter Bar */}
        <div className="filter-bar">
          <div className="search-input-wrapper">
            <Search className="icon" size={18} />
            <input 
              type="text" 
              placeholder="Search by ID, Email, Payload content..." 
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            {searchQuery && (
              <button 
                onClick={() => setSearchQuery('')}
                style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer' }}
              >
                <X size={16} />
              </button>
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Filter size={16} style={{ color: 'var(--muted)' }} />
            <select
              className="filter-select"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
            >
              <option value="">All Statuses</option>
              <option value="success">Success</option>
              <option value="failed">Failed</option>
              <option value="skipped">Skipped</option>
              <option value="pending">Pending</option>
            </select>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <select
              className="filter-select"
              value={entityFilter}
              onChange={(e) => setEntityFilter(e.target.value)}
              title="Filter by entity type"
            >
              <option value="">All Types</option>
              <option value="contact">Contact</option>
              <option value="lead">Lead</option>
              <option value="account">Account</option>
            </select>
          </div>

          {(statusFilter || entityFilter || debouncedSearch) && (
            <button className="ghost" onClick={() => { setStatusFilter(''); setEntityFilter(''); setSearchQuery(''); }} style={{ fontSize: 12 }}>
              Clear Filters
            </button>
          )}
        </div>

        {error && <div className="sv-note err" style={{ marginBottom: 20 }}>{error}</div>}
        
        <div className="data-table-container" style={{ flex: 1 }}>
          <table className="data-table">
            <thead>
              <tr>
                <th style={{ width: '180px' }}>Log ID</th>
                <th>Flow</th>
                <th>Identifier</th>
                <th style={{ width: '120px' }}>Status</th>
                <th style={{ width: '140px' }}>Timestamp</th>
                <th style={{ width: '100px', textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading && events.length === 0 ? (
                <tr>
                  <td colSpan="6" style={{ textAlign: 'center', padding: '40px', color: 'var(--muted)' }}>
                    <RefreshCw size={24} className="spin" style={{ marginBottom: 12 }} />
                    <div>Loading logs...</div>
                  </td>
                </tr>
              ) : events.length === 0 ? (
                <tr>
                  <td colSpan="6" style={{ textAlign: 'center', padding: '40px', color: 'var(--muted)' }}>
                    No events found matching your filters.
                  </td>
                </tr>
              ) : (
                events.map(evt => (
                  <tr key={evt.id}>
                    <td className="mono" title={evt.id}>
                      <span style={{ color: 'var(--accent)' }}>{String(evt.id).substring(0, 8)}</span>
                      {String(evt.id).length > 8 && <span style={{ opacity: 0.5 }}>{String(evt.id).substring(8, 18)}...</span>}
                      {evt._live && <span style={{ marginLeft: 6, fontSize: 9, background: 'var(--accent)', color: '#000', padding: '2px 4px', borderRadius: 4, fontWeight: 700 }}>LIVE</span>}
                    </td>
                    <td>
                      <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span>{evt.source}</span>
                        <span style={{ color: 'var(--muted)' }}>→</span>
                        <span>{evt.target}</span>
                      </div>
                      {evt.entityType && (
                        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                          {evt.entityType}
                        </div>
                      )}
                    </td>
                    <td>
                      <div style={{ fontSize: 13 }}>
                        {evt.email || evt.sourceFields?.name || evt.sourceFields?.company || '(no identifier)'}
                      </div>
                    </td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        {getStatusIcon(evt.status)}
                        <span className={`chip ${
                          (evt.status || '').toLowerCase().trim() === 'success' || (evt.status || '').toLowerCase().trim() === 'completed' ? 'success' : 
                          (evt.status || '').toLowerCase().trim() === 'failed' || (evt.status || '').toLowerCase().trim() === 'error' ? 'failed' : 
                          'skipped'
                        }`} style={{ fontSize: 10 }}>{evt.status || 'unknown'}</span>
                      </div>
                    </td>
                    <td>
                      <div style={{ fontSize: 13 }}>{relativeTime(evt.ts)}</div>
                      <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                        {new Date(evt.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </div>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <button 
                        className="pager-btn" 
                        onClick={() => setSelectedEvent(evt)}
                        title="Inspect Payload"
                        style={{ display: 'inline-flex', width: 32, height: 32 }}
                      >
                        <Eye size={14} />
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination Bar */}
        {!loading && pagination.total > 0 && (
          <div className="pagination-bar">
            <div className="pagination-info">
              Showing <strong>{(pagination.page - 1) * pagination.limit + 1}</strong> - <strong>{Math.min(pagination.page * pagination.limit, pagination.total)}</strong> of <strong>{pagination.total}</strong> events
            </div>
            <div className="pagination-controls">
              <button 
                className="pager-btn" 
                disabled={pagination.page <= 1}
                onClick={() => fetchEvents(pagination.page - 1)}
              >
                <ChevronLeft size={18} />
              </button>
              
              {Array.from({ length: Math.min(5, pagination.pages) }, (_, i) => {
                let p = i + 1;
                if (pagination.pages > 5 && pagination.page > 3) {
                  p = pagination.page - 3 + i;
                  if (p > pagination.pages) p = pagination.pages - (4 - i);
                }
                if (p <= 0) return null;
                if (p > pagination.pages) return null;

                return (
                  <button 
                    key={p}
                    className={pagination.page === p ? 'pager-current' : 'pager-btn'}
                    onClick={() => fetchEvents(p)}
                  >
                    {p}
                  </button>
                );
              })}
              
              {pagination.pages > 5 && pagination.page < pagination.pages - 2 && (
                <>
                  <span style={{ color: 'var(--muted)' }}>...</span>
                  <button className="pager-btn" onClick={() => fetchEvents(pagination.pages)}>{pagination.pages}</button>
                </>
              )}

              <button 
                className="pager-btn" 
                disabled={pagination.page >= pagination.pages}
                onClick={() => fetchEvents(pagination.page + 1)}
              >
                <ChevronRight size={18} />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Side Drawer for Event Inspection */}
      {selectedEvent && (
        <div className="sv-drawer-backdrop" onClick={() => setSelectedEvent(null)}>
          <aside
            className="sv-drawer"
            onClick={e => e.stopPropagation()}
            style={{
              position: 'fixed',
              top: 0, right: 0, bottom: 0,
              width: 'min(700px, 100vw)',
              background: 'var(--panel)',
              boxShadow: '-8px 0 32px rgba(0,0,0,0.6)',
              zIndex: 1000,
              display: 'flex',
              flexDirection: 'column',
              borderLeft: '1px solid var(--border)',
              animation: 'drawer-slide 0.3s cubic-bezier(0.4, 0, 0.2, 1)'
            }}
          >
            <style>{`
              @keyframes drawer-slide {
                from { transform: translateX(100%); }
                to { transform: translateX(0); }
              }
            `}</style>
            
            <header style={{ padding: '24px 32px', borderBottom: '1px solid var(--border)', background: 'rgba(255,255,255,0.02)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div style={{ 
                    width: 40, height: 40, borderRadius: 10, 
                    background: 'rgba(56, 189, 248, 0.1)', color: 'var(--accent)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center'
                  }}>
                    <ExternalLink size={20} />
                  </div>
                  <div>
                    <h3 style={{ margin: 0, fontSize: 18, color: 'var(--text)' }}>Log Inspection</h3>
                    <div className="mono" style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>{selectedEvent.id}</div>
                  </div>
                </div>
                <button className="ghost" onClick={() => setSelectedEvent(null)} style={{ padding: 8, borderRadius: '50%', width: 36, height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <X size={20} />
             </button>
              </div>
              
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
                <div className="stat-card" style={{ padding: '12px', border: '1px solid var(--border)', background: 'rgba(0,0,0,0.2)', borderRadius: 8 }}>
                  <div style={{ fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Status</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
                    {getStatusIcon(selectedEvent.status)}
                    <span style={{ fontSize: 13, fontWeight: 600, textTransform: 'capitalize' }}>{selectedEvent.status || 'unknown'}</span>
                  </div>
                </div>
                <div className="stat-card" style={{ padding: '12px', border: '1px solid var(--border)', background: 'rgba(0,0,0,0.2)', borderRadius: 8 }}>
                  <div style={{ fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Flow</div>
                  <div style={{ fontSize: 13, fontWeight: 600, marginTop: 4 }}>{selectedEvent.source} → {selectedEvent.target}</div>
                </div>
                <div className="stat-card" style={{ padding: '12px', border: '1px solid var(--border)', background: 'rgba(0,0,0,0.2)', borderRadius: 8 }}>
                  <div style={{ fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Timestamp</div>
                  <div style={{ fontSize: 13, fontWeight: 600, marginTop: 4 }}>{relativeTime(selectedEvent.ts)}</div>
                </div>
              </div>
            </header>
            
            <div style={{ flex: 1, overflowY: 'auto', padding: '32px' }}>
              {selectedEvent.error && (
                <div className="sv-note err" style={{ marginBottom: 24 }}>
                  <strong style={{ display: 'block', marginBottom: 4 }}>Error / Exception:</strong>
                  {selectedEvent.error}
                </div>
              )}

              {selectedEvent.reason && (
                <div className="sv-note warn" style={{ marginBottom: 24, background: 'rgba(234, 179, 8, 0.1)', borderColor: 'rgba(234, 179, 8, 0.2)', color: 'var(--warn)' }}>
                  <strong style={{ display: 'block', marginBottom: 4 }}>Skip Reason:</strong>
                  {selectedEvent.reason}
                </div>
              )}

              {Object.keys(selectedEvent.sourceFields || {}).length > 0 || Object.keys(selectedEvent.targetFields || {}).length > 0 ? (
                <>
                  <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: 12, color: 'var(--accent)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1px' }}>FIELD COMPARISON</span>
                  </div>
                  <div style={{ background: '#080c12', padding: 20, borderRadius: 12, border: '1px solid var(--border)' }}>
                    <FieldDiff 
                      source={selectedEvent.source} 
                      target={selectedEvent.target} 
                      sourceFields={selectedEvent.sourceFields} 
                      targetFields={selectedEvent.targetFields} 
                    />
                  </div>
                </>
              ) : (
                <>
                  <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: 12, color: 'var(--accent)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1px' }}>PAYLOAD DATA</span>
                    <button 
                      className="ghost" 
                      onClick={() => copyToClipboard(selectedEvent.sourceFields || selectedEvent.payload)}
                      style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, padding: '4px 12px' }}
                    >
                      <Copy size={14} />
                      Copy JSON
                    </button>
                  </div>
                  <pre 
                    className="msg-drawer-json" 
                    style={{ margin: 0, padding: '20px', borderRadius: 12, border: '1px solid var(--border)', background: '#080c12' }}
                    dangerouslySetInnerHTML={{ __html: syntaxHighlight(selectedEvent.sourceFields || selectedEvent.payload || {}) }} 
                  />
                </>
              )}
            </div>

            <footer style={{ padding: '24px 32px', borderTop: '1px solid var(--border)', background: 'rgba(255,255,255,0.01)' }}>
              <button className="primary" style={{ width: '100%', height: 44 }} onClick={() => setSelectedEvent(null)}>
                Close Inspector
              </button>
            </footer>
          </aside>
        </div>
      )}
    </>
  );
}
