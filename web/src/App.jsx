import React, { useState } from 'react';
import Dashboard    from './tabs/Dashboard.jsx';
import Admin        from './tabs/Admin.jsx';


import SyncView     from './tabs/SyncView.jsx';
import SyncRules    from './tabs/SyncRules.jsx';
import Architecture from './tabs/Architecture.jsx';
import Messages     from './tabs/Messages.jsx';
import Logs         from './tabs/Logs.jsx';
import Webhooks     from './tabs/Webhooks.jsx';

const TABS = [
  { id: 'syncview',     label: 'Sync View' },
  { id: 'messages',     label: 'Messages' },
  { id: 'dashboard',    label: 'Dashboard' },
  { id: 'logs',         label: 'Logs' },
  { id: 'architecture', label: 'Architecture' },
  { id: 'admin',        label: 'Admin' },

];

import Sidebar, { NAV_ITEMS } from './components/Sidebar.jsx';

export default function App() {
  const [tab, setTab]   = useState('dashboard');
  // Expose setTab globally for cross-component tab switching (e.g., from SyncView link)
  if (typeof window !== 'undefined') {
    window.setTab = setTab;
  }
  const [toast, setToast] = useState(null); // { kind: 'ok'|'err', msg }

  function flash(kind, msg) {
    setToast({ kind, msg });
    setTimeout(() => setToast(null), 3500);
  }

  const currentTab = NAV_ITEMS.find(t => t.id === tab);

  return (
    <>
      <div className="app-layout">
        <Sidebar tab={tab} setTab={setTab} />
        <div className="main-container">
          <header className="page-header">
            <h1>{currentTab ? currentTab.label : 'Dynamics-Marketo Sync'}</h1>
          </header>
          <main>
            {tab === 'syncview'     && <SyncView     flash={flash} />}
            {tab === 'syncrules'    && <SyncRules    onClose={() => setTab('syncview')} />}
            {tab === 'dashboard'    && <Dashboard    flash={flash} />}
            {tab === 'logs'         && <Logs         flash={flash} />}
            {tab === 'architecture' && <Architecture />}
            {tab === 'admin'        && <Admin        flash={flash} />}

            {tab === 'messages'     && <Messages />}
            {tab === 'webhooks'     && <Webhooks flash={flash} />}
          </main>
        </div>
      </div>
      {toast && <div className={'toast ' + toast.kind}>{toast.msg}</div>}
    </>
  );
}
