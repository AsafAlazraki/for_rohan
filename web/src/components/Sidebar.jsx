import React from 'react';
import ThemeToggle from './ThemeToggle.jsx';

export const NAV_ITEMS = [
  { id: 'dashboard',    label: 'Overview' },
  { id: 'syncview',     label: 'Sync' },
  { id: 'webhooks',     label: 'Webhooks' },
  { id: 'messages',     label: 'Messages' },
  { id: 'logs',         label: 'Logs' },
  { id: 'architecture', label: 'Architecture' },
  { id: 'admin',        label: 'Settings' },
];

export default function Sidebar({ tab, setTab }) {
  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <div className="brand-logo">
          {/* Simple CSS logo */}
          <span className="logo-bar b1"></span>
          <span className="logo-bar b2"></span>
          <span className="logo-bar b3"></span>
        </div>
        <div className="brand-text">
          <div className="brand-title">DYNAMICS-MARKETO</div>
          <div className="brand-sub">SYNC</div>
        </div>
      </div>
      <nav className="sidebar-nav">
        {NAV_ITEMS.map(t => (
          <button
            key={t.id}
            className={'sidebar-nav-item' + (tab === t.id ? ' active' : '')}
            onClick={() => setTab(t.id)}
          >
            <span className="nav-label">{t.label}</span>
          </button>
        ))}
      </nav>
      {/* Optional user info at bottom */}
      <div className="sidebar-footer">
        <div className="user-avatar">JM</div>
        <div className="user-info">
          <div className="user-name">John M.</div>
          <div className="user-role">Admin</div>
        </div>
        <div className="spacer" />
        <ThemeToggle />
      </div>
    </aside>
  );
}
