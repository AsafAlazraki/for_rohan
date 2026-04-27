import React, { useEffect, useState } from 'react';
import { getWebhookUsage } from '../lib/api.js';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { Activity, Clock } from 'lucide-react';

export default function Webhooks({ flash }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState('24h');

  async function refresh() {
    setLoading(true);
    try {
      const res = await getWebhookUsage(period);
      setData(res);
    } catch (e) {
      if (flash) flash('err', `Failed to load webhook usage: ${e.message}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, [period]);

  const renderCard = (webhook, color, gradientId) => {
    if (!webhook || !data || !Array.isArray(data.graphData)) return null;

    // Ensure the webhook has required properties
    const safeWebhook = {
      ...webhook,
      total: webhook.total || 0,
      active: !!webhook.active,
      last_received: webhook.last_received || null
    };

    return (
      <div className="panel" key={safeWebhook.id} style={{ marginBottom: 24, background: 'rgba(255,255,255,0.02)', minHeight: 220 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div>
            <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8, fontSize: 16 }}>
              {safeWebhook.name}
              {safeWebhook.active ? (
                <span className="chip success" style={{ fontSize: 10, padding: '1px 6px' }}>Active</span>
              ) : (
                <span className="chip" style={{ fontSize: 10, padding: '1px 6px' }}>Inactive</span>
              )}
            </h3>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--muted)', fontSize: 11, marginTop: 4 }}>
              <Clock size={12} />
              Last: {safeWebhook.last_received ? new Date(safeWebhook.last_received).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Never'}
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 20, fontWeight: 700, color }}>
              {safeWebhook.total.toLocaleString()}
            </div>
            <div style={{ fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
              Triggers
            </div>
          </div>
        </div>

        <div style={{ height: 140, width: '100%', marginTop: 10 }}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data.graphData} margin={{ top: 5, right: 5, left: -25, bottom: 0 }}>
              <defs>
                <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={color} stopOpacity={0.2}/>
                  <stop offset="95%" stopColor={color} stopOpacity={0}/>
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.03)" vertical={false} />
              <XAxis dataKey="label" stroke="var(--muted)" fontSize={10} tickLine={false} axisLine={false} hide={period === '24h' && data.graphData.length > 12} />
              <YAxis stroke="var(--muted)" fontSize={10} tickLine={false} axisLine={false} />
              <Tooltip 
                contentStyle={{ backgroundColor: 'var(--panel-bg)', borderColor: 'var(--border)', borderRadius: 8, fontSize: 11 }}
                itemStyle={{ color: 'var(--fg)' }}
              />
              <Area 
                type="monotone" 
                dataKey={safeWebhook.id} 
                stroke={color} 
                strokeWidth={2}
                fillOpacity={1} 
                fill={`url(#${gradientId})`} 
                animationDuration={500}
                isAnimationActive={false} 
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>
    );
  };

  return (
    <div className="webhooks-tab" style={{ padding: '0' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <div style={{
          display: 'flex', 
          alignItems: 'center', 
          gap: 12, 
          padding: '12px 16px', 
          backgroundColor: 'rgba(74, 144, 226, 0.08)', 
          border: '1px solid rgba(74, 144, 226, 0.2)', 
          borderRadius: 8, 
          color: 'var(--fg)', 
          fontSize: 13,
          maxWidth: 600
        }}>
          <Activity size={18} color="#4a90e2" />
          <span>
            <strong style={{ color: '#4a90e2', fontWeight: 600 }}>Webhook Analytics</strong>: Monitor inbound payload activity across different entities.
          </span>
        </div>

        <div className="btn-group" style={{ display: 'flex', backgroundColor: 'var(--panel-bg)', borderRadius: 6, padding: 4, border: '1px solid var(--border)' }}>
          {['24h', '7d', '30d'].map(p => (
            <button 
              key={p}
              className={`ghost ${period === p ? 'active' : ''}`}
              style={{
                backgroundColor: period === p ? 'rgba(255,255,255,0.1)' : 'transparent',
                color: period === p ? 'var(--fg)' : 'var(--muted)',
                border: 'none',
                padding: '4px 12px',
                borderRadius: 4,
                cursor: 'pointer',
                fontSize: 12,
                fontWeight: period === p ? 600 : 400
              }}
              onClick={() => setPeriod(p)}
            >
              {p.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {(loading || !data) && (
        <div className="empty" style={{ padding: 40 }}>
          <Activity className="spin" size={24} style={{ marginBottom: 12, color: 'var(--muted)' }} />
          <div>Loading usage metrics...</div>
        </div>
      )}

      {!loading && data && data.systems && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 32, alignItems: 'start' }}>
          {/* Dynamics Column */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20, paddingLeft: 4 }}>
              <div style={{ width: 3, height: 16, backgroundColor: '#4a90e2', borderRadius: 2 }} />
              <h2 style={{ margin: 0, fontSize: 18, letterSpacing: -0.5 }}>Dynamics 365 Webhooks</h2>
            </div>
            {data.systems.dynamics
              ?.filter(wh => wh.name === 'Contact Created' || wh.name === 'Lead Created')
              .map((wh, idx) => renderCard(wh, '#4a90e2', `colorDyn${idx}`))}
          </div>

          {/* Marketo Column */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20, paddingLeft: 4 }}>
              <div style={{ width: 3, height: 16, backgroundColor: '#8e44ad', borderRadius: 2 }} />
              <h2 style={{ margin: 0, fontSize: 18, letterSpacing: -0.5 }}>Marketo Webhooks</h2>
            </div>
            {data.systems.marketo
              ?.filter(wh => wh.name === 'Contact Created' || wh.name === 'Lead Created')
              .map((wh, idx) => renderCard(wh, '#8e44ad', `colorMkt${idx}`))}
          </div>
        </div>
      )}
    </div>
  );
}
