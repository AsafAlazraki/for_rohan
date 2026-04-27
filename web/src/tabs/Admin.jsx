import React, { useEffect, useState } from 'react';
import {
  getConfig, saveConfig,
  listWebhookSinks, createWebhookSink, updateWebhookSink, deleteWebhookSink,
  listWebhookDeliveries,
} from '../lib/api.js';


// Spec-decision flags surfaced for operators. Keys are non-secret and
// hot-reloaded by src/config/loader.js (60s cache). See Task 20 in
// docs/COMPLIANCE_ANALYSIS.md.
const INTEGRATION_RULE_FIELDS = [
  {
    key:         'LEAD_COUNTRY_ALLOWLIST',
    label:       'Lead country allowlist',
    type:        'text',
    placeholder: 'US,NZ,AU (blank = disabled)',
    help:        'Comma-separated country codes. Blank disables the gate.',
  },
  {
    key:         'LEAD_LIFECYCLE_MIN',
    label:       'Lead lifecycle minimum score',
    type:        'number',
    placeholder: '50 (blank = disabled)',
    help:        'Minimum leadScore for a lead to be eligible. Blank disables the gate.',
  },
  {
    key:         'LEAD_SOURCE_ALLOWLIST',
    label:       'Lead source allowlist',
    type:        'text',
    placeholder: 'webform,event,paid-search',
    help:        'Comma-separated Marketo sources. Blank disables the gate.',
  },
  {
    key:         'ACCOUNT_NETSUITE_FIELD',
    label:       'Account NetSuite field',
    type:        'text',
    placeholder: 'cr_netsuiteid',
    help:        'Logical name of the NetSuite ID field on the Account entity. Default: cr_netsuiteid.',
  },
];

function IntegrationRulesPanel({ rows, onSave }) {
  const byKey = Object.fromEntries(rows.map(r => [r.key, r]));
  const initial = Object.fromEntries(
    INTEGRATION_RULE_FIELDS.map(f => [f.key, (byKey[f.key] && byKey[f.key].set) ? byKey[f.key].value : ''])
  );
  const [values, setValues] = useState(initial);
  const [saving, setSaving] = useState(null);

  // When the parent refreshes after a save, re-seed inputs from the authoritative rows.
  useEffect(() => {
    setValues(Object.fromEntries(
      INTEGRATION_RULE_FIELDS.map(f => [f.key, (byKey[f.key] && byKey[f.key].set) ? byKey[f.key].value : ''])
    ));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  async function save(key) {
    setSaving(key);
    try {
      await onSave(key, values[key] ?? '');
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="panel">
      <h2>Integration rules</h2>
      <p style={{color:'var(--muted)', marginTop:0}}>
        Spec-decision flags consumed by lead eligibility and account resolution.
        Values hot-reload in the worker within 60 seconds; no redeploy needed.
      </p>
      {INTEGRATION_RULE_FIELDS.map(f => {
        const row     = byKey[f.key];
        const dirty   = (values[f.key] ?? '') !== ((row && row.set) ? row.value : '');
        const fromEnv = row && row.source === 'env';
        return (
          <div
            key={f.key}
            className="integration-rule-row"
            style={{
              display:             'grid',
              gridTemplateColumns: '220px 1fr auto',
              gap:                 10,
              alignItems:          'center',
              padding:             '8px 0',
              borderBottom:        '1px solid rgba(139,156,171,0.08)',
            }}
          >
            <span
              title={f.help}
              style={{fontFamily:'var(--mono)', fontSize:12, color:'var(--muted)'}}
            >
              {f.key}
            </span>
            <div style={{display:'flex', flexDirection:'column', gap:4}}>
              <input
                type={f.type}
                value={values[f.key] ?? ''}
                placeholder={f.placeholder}
                disabled={fromEnv || saving === f.key}
                onChange={(e) => setValues(v => ({ ...v, [f.key]: e.target.value }))}
                onKeyDown={(e) => e.key === 'Enter' && dirty && save(f.key)}
              />
              <span style={{color:'var(--muted)', fontSize:11}}>
                {f.help}
                {fromEnv && (
                  <span style={{marginLeft:8}}>set from .env — edit in environment, not here</span>
                )}
              </span>
            </div>
            <div style={{display:'flex', gap:6}}>
              <button
                className="primary"
                disabled={!dirty || fromEnv || saving === f.key}
                onClick={() => save(f.key)}
              >
                {saving === f.key ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ConfigRow({ row, onSave }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal]         = useState('');
  const [saving, setSaving]   = useState(false);

  async function submit() {
    setSaving(true);
    try {
      await onSave(row.key, val);
      setEditing(false);
      setVal('');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="config-row">
      <span className="key">{row.key}</span>
      {editing ? (
        <input
          autoFocus
          type={row.is_secret ? 'password' : 'text'}
          value={val}
          onChange={(e) => setVal(e.target.value)}
          placeholder={row.is_secret ? 'paste new value' : row.key}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
      ) : (
        <span className={'val ' + (row.set ? '' : 'unset')}>
          {row.set ? row.value : '(not set)'}
          {row.source === 'env' && (
            <span style={{marginLeft:8, color:'var(--muted)', fontSize:11}}>from .env</span>
          )}
        </span>
      )}
      <div style={{display:'flex', gap:6}}>
        {editing ? (
          <>
            <button className="primary" disabled={saving || !val} onClick={submit}>
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button className="ghost" disabled={saving} onClick={() => { setEditing(false); setVal(''); }}>
              Cancel
            </button>
          </>
        ) : (
          <button className="ghost" onClick={() => setEditing(true)}>
            {row.set ? 'Edit' : 'Set'}
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Outbound webhooks panel ────────────────────────────────────────────
const FILTER_STATUSES   = ['success', 'failed', 'skipped'];
const FILTER_CATEGORIES = ['authority', 'eligibility', 'no-change', 'loop-guard'];
const FILTER_SOURCES    = ['dynamics', 'marketo'];

function emptyDraft() {
  return {
    name: '', url: '', secret: '',
    filter_status: [], filter_category: [], filter_sources: [],
    enabled: true,
  };
}

function OutboundWebhooksPanel({ flash }) {
  const [sinks, setSinks]           = useState([]);
  const [deliveries, setDeliveries] = useState([]);
  const [loading, setLoading]       = useState(true);
  const [editingId, setEditingId]   = useState(null); // null = not editing; '__new__' = create form
  const [draft, setDraft]           = useState(emptyDraft());
  const [saving, setSaving]         = useState(false);

  async function refresh() {
    setLoading(true);
    try {
      const [sinksRes, delRes] = await Promise.all([
        listWebhookSinks(),
        listWebhookDeliveries({ limit: 20 }),
      ]);
      setSinks(sinksRes.sinks || []);
      setDeliveries(delRes.deliveries || []);
    } catch (e) {
      flash('err', `Load webhook sinks: ${e.message}`);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { refresh(); }, []);

  function toggleFilter(field, value) {
    setDraft(d => {
      const arr = new Set(d[field] || []);
      arr.has(value) ? arr.delete(value) : arr.add(value);
      return { ...d, [field]: Array.from(arr) };
    });
  }

  function startCreate() {
    setDraft(emptyDraft());
    setEditingId('__new__');
  }

  function startEdit(sink) {
    setDraft({
      name:            sink.name || '',
      url:             sink.url  || '',
      secret:          '',                  // blank = don't overwrite
      filter_status:   sink.filter_status   || [],
      filter_category: sink.filter_category || [],
      filter_sources:  sink.filter_sources  || [],
      enabled:         !!sink.enabled,
    });
    setEditingId(sink.id);
  }

  function cancelEdit() {
    setEditingId(null);
    setDraft(emptyDraft());
  }

  async function save() {
    setSaving(true);
    try {
      if (editingId === '__new__') {
        if (!draft.name || !draft.url || !draft.secret) {
          flash('err', 'name, url, and secret are required');
          return;
        }
        await createWebhookSink(draft);
        flash('ok', `Sink "${draft.name}" created`);
      } else {
        const patch = {
          name: draft.name, url: draft.url,
          filter_status:   draft.filter_status,
          filter_category: draft.filter_category,
          filter_sources:  draft.filter_sources,
          enabled:         draft.enabled,
        };
        if (draft.secret) patch.secret = draft.secret;
        await updateWebhookSink(editingId, patch);
        flash('ok', 'Sink updated');
      }
      cancelEdit();
      await refresh();
    } catch (e) {
      flash('err', `Save failed: ${e.message}`);
    } finally {
      setSaving(false);
    }
  }

  async function remove(sink) {
    if (!window.confirm(`Delete webhook sink "${sink.name}"?`)) return;
    try {
      await deleteWebhookSink(sink.id);
      flash('ok', 'Sink deleted');
      await refresh();
    } catch (e) {
      flash('err', `Delete failed: ${e.message}`);
    }
  }

  return (
    <div className="panel">
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between' }}>
        <h2 style={{ margin: 0 }}>Outbound webhooks</h2>
        {editingId == null && (
          <button className="primary" onClick={startCreate}>+ New sink</button>
        )}
      </div>
      <p style={{color:'var(--muted)', marginTop:8}}>
        This service POSTs every matching <code>sync_events</code> row to each
        enabled sink with an HMAC-SHA256 signature in
        <code> x-playground-signature</code>. Empty filter sets mean "match all".
      </p>

      {loading && <div className="empty" style={{padding:12}}>Loading…</div>}

      {!loading && sinks.length === 0 && editingId == null && (
        <div className="empty" style={{padding:12}}>No webhook sinks yet.</div>
      )}

      {!loading && sinks.length > 0 && (
        <table style={{ width:'100%', borderCollapse:'collapse', marginTop:8 }}>
          <thead>
            <tr style={{ textAlign:'left', fontSize:12, color:'var(--muted)' }}>
              <th style={{padding:'6px 4px'}}>Name</th>
              <th style={{padding:'6px 4px'}}>URL</th>
              <th style={{padding:'6px 4px'}}>Filters</th>
              <th style={{padding:'6px 4px'}}>Enabled</th>
              <th style={{padding:'6px 4px'}}>Last</th>
              <th style={{padding:'6px 4px'}}></th>
            </tr>
          </thead>
          <tbody>
            {sinks.map(s => (
              <tr key={s.id} style={{ borderTop:'1px solid var(--border,#eee)' }}>
                <td style={{padding:'6px 4px', fontWeight:600}}>{s.name}</td>
                <td style={{padding:'6px 4px', fontFamily:'monospace', fontSize:11}}>{s.url}</td>
                <td style={{padding:'6px 4px', fontSize:11, color:'var(--muted)'}}>
                  status: {(s.filter_status || []).join(',') || '*'} ·
                  cat: {(s.filter_category || []).join(',') || '*'} ·
                  src: {(s.filter_sources || []).join(',') || '*'}
                </td>
                <td style={{padding:'6px 4px'}}>{s.enabled ? 'yes' : 'no'}</td>
                <td style={{padding:'6px 4px', fontSize:11, color:'var(--muted)'}}>
                  {s.last_status != null ? `HTTP ${s.last_status}` : '—'}
                </td>
                <td style={{padding:'6px 4px', display:'flex', gap:6}}>
                  <button className="ghost" onClick={() => startEdit(s)}>Edit</button>
                  <button className="ghost" onClick={() => remove(s)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {editingId != null && (
        <div style={{ marginTop:12, padding:12, border:'1px solid var(--border,#e3e3e3)', borderRadius:6 }}>
          <h3 style={{ marginTop:0 }}>
            {editingId === '__new__' ? 'New webhook sink' : 'Edit webhook sink'}
          </h3>
          <div style={{ display:'grid', gridTemplateColumns:'120px 1fr', gap:8, alignItems:'center' }}>
            <label>Name</label>
            <input
              type="text"
              value={draft.name}
              onChange={e => setDraft(d => ({ ...d, name: e.target.value }))}
              placeholder="e.g. CRM ops Slack relay"
            />
            <label>URL</label>
            <input
              type="url"
              value={draft.url}
              onChange={e => setDraft(d => ({ ...d, url: e.target.value }))}
              placeholder="https://your-endpoint.example.com/hook"
            />
            <label>Secret</label>
            <input
              type="password"
              value={draft.secret}
              onChange={e => setDraft(d => ({ ...d, secret: e.target.value }))}
              placeholder={editingId === '__new__' ? 'HMAC signing key' : 'leave blank to keep existing'}
            />
            <label>Statuses</label>
            <div style={{display:'flex', gap:10, flexWrap:'wrap'}}>
              {FILTER_STATUSES.map(s => (
                <label key={s} style={{display:'flex', alignItems:'center', gap:4, fontSize:12}}>
                  <input
                    type="checkbox"
                    checked={draft.filter_status.includes(s)}
                    onChange={() => toggleFilter('filter_status', s)}
                  />
                  {s}
                </label>
              ))}
            </div>
            <label>Categories</label>
            <div style={{display:'flex', gap:10, flexWrap:'wrap'}}>
              {FILTER_CATEGORIES.map(c => (
                <label key={c} style={{display:'flex', alignItems:'center', gap:4, fontSize:12}}>
                  <input
                    type="checkbox"
                    checked={draft.filter_category.includes(c)}
                    onChange={() => toggleFilter('filter_category', c)}
                  />
                  {c}
                </label>
              ))}
            </div>
            <label>Sources</label>
            <div style={{display:'flex', gap:10, flexWrap:'wrap'}}>
              {FILTER_SOURCES.map(src => (
                <label key={src} style={{display:'flex', alignItems:'center', gap:4, fontSize:12}}>
                  <input
                    type="checkbox"
                    checked={draft.filter_sources.includes(src)}
                    onChange={() => toggleFilter('filter_sources', src)}
                  />
                  {src}
                </label>
              ))}
            </div>
            <label>Enabled</label>
            <label style={{display:'flex', alignItems:'center', gap:6}}>
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={e => setDraft(d => ({ ...d, enabled: e.target.checked }))}
              />
              active
            </label>
          </div>
          <div style={{ marginTop:12, display:'flex', gap:8 }}>
            <button className="primary" disabled={saving} onClick={save}>
              {saving ? 'Saving…' : (editingId === '__new__' ? 'Create sink' : 'Save changes')}
            </button>
            <button className="ghost" disabled={saving} onClick={cancelEdit}>Cancel</button>
          </div>
        </div>
      )}

      <h3 style={{ marginTop: 20 }}>Recent deliveries</h3>
      {deliveries.length === 0 && (
        <div className="empty" style={{padding:8, fontSize:12}}>No deliveries yet.</div>
      )}
      {deliveries.length > 0 && (
        <table style={{ width:'100%', borderCollapse:'collapse' }}>
          <thead>
            <tr style={{ textAlign:'left', fontSize:12, color:'var(--muted)' }}>
              <th style={{padding:'6px 4px'}}>When</th>
              <th style={{padding:'6px 4px'}}>URL</th>
              <th style={{padding:'6px 4px'}}>Status</th>
              <th style={{padding:'6px 4px'}}>Latency</th>
              <th style={{padding:'6px 4px'}}>Attempt</th>
              <th style={{padding:'6px 4px'}}>Error</th>
            </tr>
          </thead>
          <tbody>
            {deliveries.map(d => (
              <tr key={d.id} style={{ borderTop:'1px solid var(--border,#eee)', fontSize:12 }}>
                <td style={{padding:'6px 4px'}} title={d.delivered_at}>
                  {d.delivered_at ? new Date(d.delivered_at).toLocaleString() : '—'}
                </td>
                <td style={{padding:'6px 4px', fontFamily:'monospace'}}>{d.url}</td>
                <td style={{padding:'6px 4px'}}>
                  <span className={'chip ' + (d.status >= 200 && d.status < 300 ? 'success' : 'failed')}>
                    {d.status != null ? `HTTP ${d.status}` : 'error'}
                  </span>
                </td>
                <td style={{padding:'6px 4px'}}>{d.response_ms != null ? `${d.response_ms}ms` : '—'}</td>
                <td style={{padding:'6px 4px'}}>{d.attempt}</td>
                <td style={{padding:'6px 4px', color:'var(--muted)'}}>{d.error || ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default function Admin({ flash }) {
  const [rows, setRows]       = useState([]);
  const [loading, setLoading] = useState(true);

  async function refresh() {
    setLoading(true);
    try {
      const data = await getConfig();
      setRows(data);
    } catch (e) {
      flash('err', `Load failed: ${e.message}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { refresh(); }, []);

  async function handleSave(key, value) {
    try {
      await saveConfig(key, value);
      flash('ok', `${key} saved`);
      await refresh();
    } catch (e) {
      flash('err', `Save failed: ${e.message}`);
      throw e;
    }
  }

  // Keep the generic grouped list clean; Integration rules renders in its own
  // panel with tailored inputs / placeholders / help text.
  const INTEGRATION_GROUP = 'Integration rules';
  const integrationRows = rows.filter(r => r.group === INTEGRATION_GROUP);
  const grouped = rows
    .filter(r => r.group !== INTEGRATION_GROUP)
    .reduce((acc, r) => {
      (acc[r.group] = acc[r.group] || []).push(r);
      return acc;
    }, {});

  return (
    <>


      <div className="panel">
        <h2>Credentials</h2>
        <p style={{color:'var(--muted)', marginTop:0}}>
          Values set in <code>.env</code> take precedence and are read directly by the service
          (restart required to change). Keys not present in <code>.env</code> fall back to PostgreSQL{' '}
          <code>admin_config</code>, which hot-reloads within 60 seconds. Secrets are masked to
          the last 4 characters.
        </p>
      </div>

      {loading && <div className="panel"><div className="empty">Loading…</div></div>}

      {!loading && Object.entries(grouped).map(([group, list]) => (
        <div key={group} className="panel">
          <div className="config-group">
            <h3>{group}</h3>
            {list.map(row => (
              <ConfigRow key={row.key} row={row} onSave={handleSave} />
            ))}
          </div>
        </div>
      ))}

      {!loading && (
        <IntegrationRulesPanel rows={integrationRows} onSave={handleSave} />
      )}

      <OutboundWebhooksPanel flash={flash} />
    </>
  );
}
