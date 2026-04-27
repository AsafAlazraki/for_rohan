import React from 'react';
import { X } from 'lucide-react';

// Aesthetic rules page for displaying sync rules and allowed operations
// Pulls content from the context/transformed_doc/Marketo-CRM Integration Behaviour & Rules Specification.md
// Accepts optional onClose prop to show an 'x' button
export default function SyncRules({ onClose }) {
  // Custom link style for better contrast in dark mode
  const linkStyle = {
    color: '#7dd3fc', // Lighter cyan for dark backgrounds
    textDecoration: 'underline',
    fontWeight: 500,
  };
  return (
    <div className="panel" style={{ maxWidth: 900, margin: '0 auto', padding: 32, position: 'relative' }}>
      {onClose && (
        <button
          onClick={onClose}
          title="Return to Sync"
          style={{
            position: 'absolute',
            top: 18,
            right: 18,
            background: 'rgba(56,189,248,0.10)',
            border: '1.5px solid var(--accent)',
            borderRadius: '50%',
            width: 38,
            height: 38,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            color: 'var(--accent)',
            boxShadow: '0 2px 8px 0 rgba(56,189,248,0.08)',
            zIndex: 10,
            transition: 'background 0.18s, border 0.18s',
          }}
          onMouseOver={e => e.currentTarget.style.background = 'rgba(56,189,248,0.18)'}
          onMouseOut={e => e.currentTarget.style.background = 'rgba(56,189,248,0.10)'}
        >
          <X size={22} />
        </button>
      )}
      <h1 style={{ fontSize: 32, marginBottom: 8, fontWeight: 800 }}>Integration Sync Rules</h1>
      <p style={{ color: 'var(--muted)', fontSize: 16, marginBottom: 32 }}>
        This page summarizes the allowed and forbidden sync operations between Marketo and Dynamics 365 CRM. For full details, see the{' '}
        <a
          href="/context/transformed_doc/Marketo-CRM%20Integration%20Behaviour%20%26%20Rules%20Specification.md"
          target="_blank"
          rel="noopener noreferrer"
          style={linkStyle}
        >
          Integration Behaviour & Rules Specification
        </a>.
      </p>

      <section style={{ marginBottom: 40 }}>
        <h2 style={{ marginBottom: 12 }}>System of Record & Authority</h2>
        <div style={{ overflowX: 'auto' }}>
          <table className="rules-table" style={{ minWidth: 420, width: '100%', marginBottom: 0 }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: '6px 18px 6px 0' }}>Domain</th>
                <th style={{ textAlign: 'left', padding: '6px 0' }}>Authoritative System</th>
              </tr>
            </thead>
            <tbody>
              <tr><td style={{ padding: '6px 18px 6px 0' }}>Account identity</td><td>CRM</td></tr>
              <tr><td style={{ padding: '6px 18px 6px 0' }}>Person identity (Lead vs Contact)</td><td>CRM</td></tr>
              <tr><td style={{ padding: '6px 18px 6px 0' }}>Account–Person relationships</td><td>CRM</td></tr>
              <tr><td style={{ padding: '6px 18px 6px 0' }}>Marketing consent & unsubscribe</td><td>Marketo</td></tr>
              <tr><td style={{ padding: '6px 18px 6px 0' }}>Marketing engagement data</td><td>Marketo</td></tr>
            </tbody>
          </table>
        </div>
        <div style={{ marginTop: 8, color: 'var(--muted)', fontSize: 15 }}>
          <b>Exception:</b> Marketo may update CRM Contact consent fields for global unsubscribe events only. No other identity or lifecycle data is updated by Marketo.
        </div>
      </section>

      <section style={{ marginBottom: 40 }}>
        <h2 style={{ marginBottom: 12 }}>Allowed Sync Directions</h2>
        <div style={{ overflowX: 'auto' }}>
          <table className="rules-table" style={{ minWidth: 600, width: '100%', marginBottom: 0 }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: '6px 18px 6px 0' }}>CRM Entity</th>
                <th style={{ textAlign: 'left', padding: '6px 18px 6px 0' }}>Marketo Entity</th>
                <th style={{ textAlign: 'left', padding: '6px 18px 6px 0' }}>Direction</th>
                <th style={{ textAlign: 'left', padding: '6px 0' }}>Allowed?</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td style={{ padding: '6px 18px 6px 0' }}>Account</td>
                <td style={{ padding: '6px 18px 6px 0' }}>Company</td>
                <td style={{ padding: '6px 18px 6px 0' }}>CRM → Marketo</td>
                <td>✔️</td>
              </tr>
              <tr>
                <td style={{ padding: '6px 18px 6px 0' }}>Contact</td>
                <td style={{ padding: '6px 18px 6px 0' }}>Lead (Person)</td>
                <td style={{ padding: '6px 18px 6px 0' }}>CRM → Marketo</td>
                <td>✔️</td>
              </tr>
              <tr>
                <td style={{ padding: '6px 18px 6px 0' }}>Contact</td>
                <td style={{ padding: '6px 18px 6px 0' }}>Lead (Person)</td>
                <td style={{ padding: '6px 18px 6px 0' }}>Marketo → CRM (Global Unsubscribes only)</td>
                <td>✔️ <span style={{ fontSize: 13, color: 'var(--muted)' }}>(consent fields only)</span></td>
              </tr>
              <tr>
                <td style={{ padding: '6px 18px 6px 0' }}>Lead</td>
                <td style={{ padding: '6px 18px 6px 0' }}>Lead (Person)</td>
                <td style={{ padding: '6px 18px 6px 0' }}>Marketo → CRM (New Leads)</td>
                <td>✔️ <span style={{ fontSize: 13, color: 'var(--muted)' }}>(see rules)</span></td>
              </tr>
              <tr>
                <td style={{ padding: '6px 18px 6px 0' }}>Lead</td>
                <td style={{ padding: '6px 18px 6px 0' }}>Lead (Person)</td>
                <td style={{ padding: '6px 18px 6px 0' }}>CRM → Marketo (Qualification/Disqualification)</td>
                <td>✔️</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div style={{ marginTop: 8, color: 'var(--muted)', fontSize: 15 }}>
          <b>Note:</b> Marketo cannot create or update CRM Accounts, update CRM Leads for consent, or update non-consent Contact fields.
        </div>
      </section>

      <section style={{ marginBottom: 40 }}>
        <h2>Key Sync Rules</h2>
        <ul style={{ fontSize: 16, lineHeight: 1.7 }}>
          <li>CRM is authoritative for all identities and relationships.</li>
          <li>Marketo is authoritative for marketing consent and engagement.</li>
          <li>Marketo can only update CRM Contact consent fields (e.g., <code>donotbulkemail</code>) for global unsubscribes.</li>
          <li>All other Marketo → CRM updates are forbidden.</li>
          <li>Sync triggers only on mapped field changes or explicit events (see full spec).</li>
        </ul>
      </section>

      <section style={{ marginBottom: 40 }}>
        <h2>Lead Creation Criteria (Marketo → CRM)</h2>
        <ul style={{ fontSize: 16, lineHeight: 1.7 }}>
          <li>Person type: <b>isLead = true</b> AND <b>crmLeadId</b> and <b>crmContactId</b> are blank.</li>
          <li>Company exists in CRM.</li>
          <li>Email present & valid.</li>
          <li>Consent/marketing eligibility: not globally unsubscribed.</li>
          <li>Data completeness: first name, last name, email, company.</li>
          <li>Other exclusion and qualification gates may apply (see full spec).</li>
        </ul>
      </section>

      <section style={{ marginBottom: 40 }}>
        <h2 style={{ fontWeight: 700 }}>Further Reading</h2>
        <ul>
          <li>
            <a
              href="/context/transformed_doc/Marketo-CRM%20Integration%20Behaviour%20%26%20Rules%20Specification.md"
              target="_blank"
              rel="noopener noreferrer"
              style={linkStyle}
            >
              Integration Behaviour & Rules Specification (full)
            </a>
          </li>
          <li>
            <a
              href="/context/transformed_doc/Marketo-D365-IntegrationMapping.md"
              target="_blank"
              rel="noopener noreferrer"
              style={linkStyle}
            >
              Field Mapping Specification
            </a>
          </li>
        </ul>
      </section>
    </div>
  );
}
