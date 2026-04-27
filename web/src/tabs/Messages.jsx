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
import { getServiceBusMessages } from '../lib/api.js';

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

const SYSTEM_STYLES = {
  dynamics: {
    label: 'Dynamics',
    background: 'rgba(56, 189, 248, 0.12)',
    color: '#38bdf8',
    border: '1px solid rgba(56, 189, 248, 0.3)',
  },
  marketo: {
    label: 'Marketo',
    background: 'rgba(167, 139, 250, 0.12)',
    color: '#a78bfa',
    border: '1px solid rgba(167, 139, 250, 0.3)',
  },
};

function SystemBadge({ system }) {
  const key = (system || '').toLowerCase();
  const style = SYSTEM_STYLES[key] || {
    label: system,
    background: 'rgba(148,163,184,0.1)',
    color: 'var(--muted)',
    border: '1px solid var(--border)',
  };
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 5,
      padding: '3px 10px',
      borderRadius: 20,
      fontSize: 11,
      fontWeight: 700,
      letterSpacing: '0.3px',
      background: style.background,
      color: style.color,
      border: style.border,
      whiteSpace: 'nowrap',
    }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: style.color, display: 'inline-block', flexShrink: 0 }} />
      {style.label}
    </span>
  );
}

export default function Messages() {
  const [messages, setMessages] = useState([]);
  const [pagination, setPagination] = useState({ total: 0, page: 1, limit: 50, pages: 0 });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [selectedMessage, setSelectedMessage] = useState(null);
  
  // Filters
  const [statusFilter, setStatusFilter] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const searchTimeout = useRef(null);

  // Debounce search input
  useEffect(() => {
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(() => {
      setDebouncedSearch(searchQuery);
    }, 400);
    return () => clearTimeout(searchTimeout.current);
  }, [searchQuery]);

  const fetchMessages = useCallback(async (page = 1) => {
    setLoading(true); 
    setError(null);
    try {
      const res = await getServiceBusMessages({ 
        page, 
        limit: pagination.limit, 
        status: statusFilter, 
        search: debouncedSearch 
      });
      setMessages(res.messages || []);
      setPagination(res.pagination || { total: 0, page: 1, limit: 50, pages: 0 });
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [pagination.limit, statusFilter, debouncedSearch]);

  useEffect(() => {
    fetchMessages(1);
  }, [fetchMessages]);

  function copyToClipboard(payload) {
    if (payload) {
      const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
      navigator.clipboard.writeText(text)
        .then(() => alert('Copied to clipboard!'))
        .catch(err => console.error('Failed to copy: ', err));
    }
  }

  function getStatusIcon(state) {
    const s = (state || '').toLowerCase();
    if (s === 'completed') return <CheckCircle2 size={14} className="text-ok" style={{ color: 'var(--ok)' }} />;
    if (s === 'failed') return <AlertCircle size={14} className="text-err" style={{ color: 'var(--err)' }} />;
    return <Clock size={14} className="text-warn" style={{ color: 'var(--warn)' }} />;
  }

  return (
    <>
      <div className="panel" style={{ minHeight: 'calc(100vh - 200px)', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
          <div>
            <h2 style={{ margin: 0 }}>Service Bus Messages</h2>
            <p style={{ margin: '4px 0 0 0', fontSize: 13, color: 'var(--muted)' }}>
              Real-time message history from pgboss job queue
            </p>
          </div>
          <button className="ghost" onClick={() => fetchMessages(pagination.page)} disabled={loading} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
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
              placeholder="Search by ID, Name or Payload content..." 
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
              <option value="completed">Completed</option>
              <option value="failed">Failed</option>
              <option value="created">Created</option>
              <option value="active">Active</option>
            </select>
          </div>

          {(statusFilter || debouncedSearch) && (
            <button className="ghost" onClick={() => { setStatusFilter(''); setSearchQuery(''); }} style={{ fontSize: 12 }}>
              Clear Filters
            </button>
          )}
        </div>

        {error && <div className="sv-note err" style={{ marginBottom: 20 }}>{error}</div>}
        
        <div className="data-table-container" style={{ flex: 1 }}>
          <table className="data-table">
            <thead>
              <tr>
                <th style={{ width: '220px' }}>Message ID</th>
                <th style={{ width: '120px' }}>Source</th>
                <th style={{ width: '120px' }}>Destination</th>
                <th style={{ width: '100px' }}>Type</th>
                <th style={{ width: '120px' }}>Status</th>
                <th style={{ width: '140px' }}>Created</th>
                <th style={{ width: '100px' }}>Retries</th>
                <th style={{ width: '100px', textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading && messages.length === 0 ? (
                <tr>
                  <td colSpan="8" style={{ textAlign: 'center', padding: '40px', color: 'var(--muted)' }}>
                    <RefreshCw size={24} className="spin" style={{ marginBottom: 12 }} />
                    <div>Loading messages...</div>
                  </td>
                </tr>
              ) : messages.length === 0 ? (
                <tr>
                  <td colSpan="8" style={{ textAlign: 'center', padding: '40px', color: 'var(--muted)' }}>
                    No messages found matching your filters.
                  </td>
                </tr>
              ) : (
                messages.map(msg => (
                  <tr key={msg.id}>
                    <td className="mono" title={msg.id}>
                      <span style={{ color: 'var(--accent)' }}>{msg.id.substring(0, 8)}</span>
                      <span style={{ opacity: 0.5 }}>{msg.id.substring(8, 18)}...</span>
                    </td>
                    <td>
                      {msg.source ? (
                        <SystemBadge system={msg.source} />
                      ) : (
                        <span style={{ color: 'var(--muted)', fontSize: 12 }}>—</span>
                      )}
                    </td>
                    <td>
                      {msg.destination ? (
                        <SystemBadge system={msg.destination} />
                      ) : (
                        <span style={{ color: 'var(--muted)', fontSize: 12 }}>—</span>
                      )}
                    </td>
                    <td>
                      <span style={{ 
                        fontSize: 12, 
                        fontWeight: 600, 
                        color: msg.type === 'Activity' ? 'var(--warn)' : 'var(--text)',
                        background: 'rgba(255,255,255,0.03)',
                        padding: '2px 8px',
                        borderRadius: 4,
                        border: '1px solid var(--border)'
                      }}>
                        {msg.type || 'Contact'}
                      </span>
                    </td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        {getStatusIcon(msg.state)}
                        <span className={`chip ${
                          (msg.state || '').toLowerCase().trim() === 'completed' ? 'success' : 
                          (msg.state || '').toLowerCase().trim() === 'failed'    ? 'failed' : 
                          'skipped'
                        }`} style={{ fontSize: 10 }}>{msg.state}</span>
                      </div>
                    </td>
                    <td>
                      <div style={{ fontSize: 13 }}>{relativeTime(msg.createdOn)}</div>
                      <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                        {new Date(msg.createdOn).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </div>
                    </td>
                    <td>
                      <span style={{ 
                        color: msg.retryCount > 0 ? 'var(--warn)' : 'var(--muted)',
                        fontWeight: msg.retryCount > 0 ? 600 : 400
                      }}>
                        {msg.retryCount} {msg.retryCount === 1 ? 'retry' : 'retries'}
                      </span>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <button 
                        className="pager-btn" 
                        onClick={() => setSelectedMessage(msg)}
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
              Showing <strong>{(pagination.page - 1) * pagination.limit + 1}</strong> - <strong>{Math.min(pagination.page * pagination.limit, pagination.total)}</strong> of <strong>{pagination.total}</strong> messages
            </div>
            <div className="pagination-controls">
              <button 
                className="pager-btn" 
                disabled={pagination.page <= 1}
                onClick={() => fetchMessages(pagination.page - 1)}
              >
                <ChevronLeft size={18} />
              </button>
              
              {/* Simple Page Numbers */}
              {Array.from({ length: Math.min(5, pagination.pages) }, (_, i) => {
                let p = i + 1;
                // Center the active page if possible
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
                    onClick={() => fetchMessages(p)}
                  >
                    {p}
                  </button>
                );
              })}
              
              {pagination.pages > 5 && pagination.page < pagination.pages - 2 && (
                <>
                  <span style={{ color: 'var(--muted)' }}>...</span>
                  <button className="pager-btn" onClick={() => fetchMessages(pagination.pages)}>{pagination.pages}</button>
                </>
              )}

              <button 
                className="pager-btn" 
                disabled={pagination.page >= pagination.pages}
                onClick={() => fetchMessages(pagination.page + 1)}
              >
                <ChevronRight size={18} />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Side Drawer for Payload Inspection */}
      {selectedMessage && (
        <div className="sv-drawer-backdrop" onClick={() => setSelectedMessage(null)}>
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
                    <h3 style={{ margin: 0, fontSize: 18, color: 'var(--text)' }}>Message Inspection</h3>
                    <div className="mono" style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>{selectedMessage.id}</div>
                  </div>
                </div>
                <button className="ghost" onClick={() => setSelectedMessage(null)} style={{ padding: 8, borderRadius: '50%', width: 36, height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <X size={20} />
                </button>
              </div>
              
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
                <div className="stat-card" style={{ padding: '12px', border: '1px solid var(--border)', background: 'rgba(0,0,0,0.2)', borderRadius: 8 }}>
                  <div style={{ fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Status</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
                    {getStatusIcon(selectedMessage.state)}
                    <span style={{ fontSize: 13, fontWeight: 600 }}>{selectedMessage.state}</span>
                  </div>
                </div>
                <div className="stat-card" style={{ padding: '12px', border: '1px solid var(--border)', background: 'rgba(0,0,0,0.2)', borderRadius: 8 }}>
                  <div style={{ fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Retries</div>
                  <div style={{ fontSize: 13, fontWeight: 600, marginTop: 4 }}>{selectedMessage.retryCount} attempts</div>
                </div>
                <div className="stat-card" style={{ padding: '12px', border: '1px solid var(--border)', background: 'rgba(0,0,0,0.2)', borderRadius: 8 }}>
                  <div style={{ fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Created</div>
                  <div style={{ fontSize: 13, fontWeight: 600, marginTop: 4 }}>{relativeTime(selectedMessage.createdOn)}</div>
                </div>
              </div>
            </header>
            
            <div style={{ flex: 1, overflowY: 'auto', padding: '32px' }}>
              <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 12, color: 'var(--accent)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1px' }}>PAYLOAD DATA</span>
                  {selectedMessage.parseError && <span className="chip failed" style={{ fontSize: 9 }}>Invalid JSON</span>}
                </div>
                <button 
                  className="ghost" 
                  onClick={() => copyToClipboard(selectedMessage.data)}
                  style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, padding: '4px 12px' }}
                >
                  <Copy size={14} />
                  Copy JSON
                </button>
              </div>
              
              <div style={{ position: 'relative' }}>
                <pre 
                  className="msg-drawer-json" 
                  style={{ margin: 0, padding: '20px', borderRadius: 12, border: '1px solid var(--border)', background: '#080c12' }}
                  dangerouslySetInnerHTML={{ __html: syntaxHighlight(selectedMessage.data) }} 
                />
              </div>

              {selectedMessage.parseError && (
                <div className="sv-note err" style={{ marginTop: 16 }}>
                  <strong>Parse Error:</strong> This message contains invalid or non-JSON data.
                </div>
              )}
            </div>

            <footer style={{ padding: '24px 32px', borderTop: '1px solid var(--border)', background: 'rgba(255,255,255,0.01)' }}>
              <button className="primary" style={{ width: '100%', height: 44 }} onClick={() => setSelectedMessage(null)}>
                Close Inspector
              </button>
            </footer>
          </aside>
        </div>
      )}
    </>
  );
}
