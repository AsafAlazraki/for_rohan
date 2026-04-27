import React from 'react';
import {
  Shield,
  ArrowRight,
  ArrowLeft,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  User,
  Users,
  Briefcase,
  BookOpen,
  Sparkles,
} from 'lucide-react';

// ─── constants ────────────────────────────────────────────────────────────
const AUTHORITY = [
  { domain: 'Account identity',              system: 'CRM' },
  { domain: 'Person identity (Lead/Contact)', system: 'CRM' },
  { domain: 'Account ↔ Person relationships', system: 'CRM' },
  { domain: 'Marketing consent & unsubscribe', system: 'Marketo' },
  { domain: 'Marketing engagement data',      system: 'Marketo' },
];

const SYNC_MATRIX = [
  {
    entity: 'Contact',
    icon: <User size={16} />,
    d2m: { kind: 'full',         label: 'Full sync',           detail: 'All mapped fields flow CRM → Marketo.' },
    m2d: { kind: 'conditional',  label: 'Unsubscribe only',    detail: 'Only the global unsubscribe flag (donotbulkemail). All other fields will skip.' },
  },
  {
    entity: 'Lead',
    icon: <Users size={16} />,
    d2m: { kind: 'full',         label: 'Full sync',           detail: 'All mapped fields flow CRM → Marketo.' },
    m2d: { kind: 'conditional',  label: 'New leads only',      detail: 'Marketo may create new Leads in CRM. Existing Leads (with a CRM ID) will skip.' },
  },
  {
    entity: 'Account',
    icon: <Briefcase size={16} />,
    d2m: { kind: 'full',         label: 'Full sync',           detail: 'All mapped fields flow CRM → Marketo.' },
    m2d: { kind: 'forbidden',    label: 'Not permitted',       detail: 'Marketo cannot write Accounts to CRM — Accounts are CRM-authoritative.' },
  },
];

const PERMITTED = [
  {
    title: 'Global Unsubscribe',
    subtitle: 'CRM Contact · donotbulkemail',
    points: [
      'Triggered when a Marketo Person is marked globally unsubscribed.',
      'Requires an existing crmContactId (or email fallback) that resolves to an active CRM Contact.',
      'Only the donotbulkemail consent flag is updated. No other fields.',
    ],
  },
  {
    title: 'New Lead Creation',
    subtitle: 'CRM Lead · create',
    points: [
      'Triggered for unresolved Leads (no crmLeadId, no crmContactId).',
      'Subject to the full eligibility criteria: personType, email validity, consent, data completeness, country/lifecycle/source gates.',
      'If the Person resolves to an existing Contact instead, the create is skipped.',
    ],
  },
];

const PROHIBITED = [
  'Create or update CRM Accounts.',
  'Update CRM Leads (including consent — lead consent lives in CRM).',
  'Create Contact records directly (Contacts are created in CRM and synced outbound).',
  'Update any non-consent Contact fields (name, address, phone, job title, etc.).',
];

const CLASSIFIER = [
  { idx: 1, indicator: 'crmContactId populated',  kind: 'Contact',       note: 'Strongest signal — record is linked to a CRM Contact.' },
  { idx: 2, indicator: 'crmLeadId populated',     kind: 'Lead',          note: 'Record is linked to a CRM Lead.' },
  { idx: 3, indicator: 'isCustomer = true',       kind: 'Contact',       note: 'Marketo-flagged customer.' },
  { idx: 4, indicator: 'isLead = true',           kind: 'Lead',          note: 'Marketo-flagged lead.' },
  { idx: 5, indicator: "type = 'lead'",           kind: 'Lead',          note: 'Marketo-native type field (fallback).' },
  { idx: 6, indicator: "type = 'contact'",        kind: 'Contact',       note: 'Marketo-native type field (fallback).' },
  { idx: 7, indicator: 'otherwise',               kind: 'Undetermined',  note: 'Rejected at the authority guard — sync skipped.' },
];

const ELIGIBILITY_CRITERIA = [
  { criterion: 'personType',         rule: 'Classified as Lead with no crmLeadId and no crmContactId.' },
  { criterion: 'emailValid',         rule: 'Email present and matches standard format.' },
  { criterion: 'consent',            rule: 'unsubscribed !== true.' },
  { criterion: 'dataCompleteness',   rule: 'firstName, lastName, and email all present.' },
  { criterion: 'companyExists',      rule: 'Account resolved in CRM, or auto-created if company name is provided.' },
  { criterion: 'countryScope',       rule: 'Country in LEAD_COUNTRY_ALLOWLIST (when flag enabled).' },
  { criterion: 'lifecycleGate',      rule: 'leadScore ≥ LEAD_LIFECYCLE_MIN (when flag enabled).' },
  { criterion: 'sourceChannelScope', rule: 'source in LEAD_SOURCE_ALLOWLIST (when flag enabled).' },
];

// ─── small subcomponents ──────────────────────────────────────────────────
function KindBadge({ kind, label }) {
  const styles = {
    full:        { bg: 'rgba(16, 185, 129, 0.12)', border: 'rgba(16, 185, 129, 0.35)', fg: '#10b981', Icon: CheckCircle2 },
    conditional: { bg: 'rgba(234, 179, 8, 0.12)',  border: 'rgba(234, 179, 8, 0.35)',  fg: '#eab308', Icon: AlertTriangle },
    forbidden:   { bg: 'rgba(239, 68, 68, 0.12)',  border: 'rgba(239, 68, 68, 0.35)',  fg: '#ef4444', Icon: XCircle },
  };
  const s = styles[kind] || styles.full;
  const Icon = s.Icon;
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 10px',
        borderRadius: 999,
        background: s.bg,
        border: `1px solid ${s.border}`,
        color: s.fg,
        fontSize: 12,
        fontWeight: 600,
        whiteSpace: 'nowrap',
      }}
    >
      <Icon size={13} />
      {label}
    </span>
  );
}

function SectionHeader({ icon, title, subtitle }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
      <div
        style={{
          width: 36, height: 36, borderRadius: 10,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(56, 189, 248, 0.1)',
          border: '1px solid rgba(56, 189, 248, 0.2)',
          color: 'var(--accent)',
        }}
      >
        {icon}
      </div>
      <div>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{title}</h2>
        {subtitle && (
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>{subtitle}</div>
        )}
      </div>
    </div>
  );
}

// ─── main component ───────────────────────────────────────────────────────
export default function Rules() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20, maxWidth: 1100, margin: '0 auto' }}>
      {/* Hero */}
      <div
        className="panel"
        style={{
          background: 'linear-gradient(135deg, rgba(56, 189, 248, 0.08), rgba(56, 189, 248, 0.02))',
          border: '1px solid rgba(56, 189, 248, 0.2)',
          padding: 28,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 14 }}>
          <div
            style={{
              width: 48, height: 48, borderRadius: 12,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'var(--accent)', color: '#050b14',
            }}
          >
            <BookOpen size={22} />
          </div>
          <div>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, letterSpacing: '-0.01em' }}>
              Sync Rules & Authority Model
            </h1>
            <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>
              How data flows between Dynamics 365 and Marketo — and why some syncs are intentionally restricted.
            </div>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginTop: 20 }}>
          <GuidingCard
            accent="rgba(56, 189, 248, 0.4)"
            title="CRM is authoritative"
            body="for identity & relationships."
          />
          <GuidingCard
            accent="rgba(168, 85, 247, 0.4)"
            title="Marketo is authoritative"
            body="for consent & engagement."
          />
          <GuidingCard
            accent="rgba(234, 179, 8, 0.4)"
            title="Marketo → CRM is narrow"
            body="write-back is explicitly scoped."
          />
        </div>
      </div>

      {/* Authority matrix */}
      <div className="panel" style={{ padding: 24 }}>
        <SectionHeader
          icon={<Shield size={18} />}
          title="System of Record"
          subtitle="Which system owns which domain."
        />
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 180px',
            border: '1px solid var(--border)',
            borderRadius: 10,
            overflow: 'hidden',
          }}
        >
          <div style={{ ...rowStyle, ...headerStyle }}>Domain</div>
          <div style={{ ...rowStyle, ...headerStyle, textAlign: 'right' }}>Authoritative System</div>
          {AUTHORITY.map((r, i) => {
            const isLast = i === AUTHORITY.length - 1;
            const isCrm = r.system === 'CRM';
            return (
              <React.Fragment key={r.domain}>
                <div style={{ ...rowStyle, borderBottom: isLast ? 'none' : '1px solid var(--border)' }}>
                  {r.domain}
                </div>
                <div
                  style={{
                    ...rowStyle,
                    borderBottom: isLast ? 'none' : '1px solid var(--border)',
                    textAlign: 'right',
                  }}
                >
                  <span
                    style={{
                      display: 'inline-block',
                      padding: '2px 10px',
                      borderRadius: 6,
                      fontSize: 12,
                      fontWeight: 600,
                      background: isCrm ? 'rgba(56, 189, 248, 0.12)' : 'rgba(168, 85, 247, 0.12)',
                      color: isCrm ? 'var(--accent)' : '#c084fc',
                      border: `1px solid ${isCrm ? 'rgba(56, 189, 248, 0.3)' : 'rgba(168, 85, 247, 0.3)'}`,
                    }}
                  >
                    {r.system}
                  </span>
                </div>
              </React.Fragment>
            );
          })}
        </div>
        <div style={{ marginTop: 14, fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>
          <strong style={{ color: 'var(--text)' }}>Controlled exception:</strong>{' '}
          Marketo may update a strictly-limited set of CRM Contact consent fields (global unsubscribe only) — this
          does not extend to identity, lifecycle, or qualification data.
        </div>
      </div>

      {/* Sync matrix */}
      <div className="panel" style={{ padding: 24 }}>
        <SectionHeader
          icon={<Sparkles size={18} />}
          title="Sync Matrix"
          subtitle="What syncs in each direction, per entity."
        />
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '140px 1fr 1fr',
            border: '1px solid var(--border)',
            borderRadius: 10,
            overflow: 'hidden',
          }}
        >
          <div style={{ ...rowStyle, ...headerStyle }}>Entity</div>
          <div style={{ ...rowStyle, ...headerStyle, display: 'flex', alignItems: 'center', gap: 8 }}>
            <ArrowRight size={14} /> Dynamics → Marketo
          </div>
          <div style={{ ...rowStyle, ...headerStyle, display: 'flex', alignItems: 'center', gap: 8 }}>
            <ArrowLeft size={14} /> Marketo → Dynamics
          </div>
          {SYNC_MATRIX.map((row, i) => {
            const isLast = i === SYNC_MATRIX.length - 1;
            const border = isLast ? 'none' : '1px solid var(--border)';
            return (
              <React.Fragment key={row.entity}>
                <div style={{ ...rowStyle, borderBottom: border, display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600 }}>
                  <span style={{ color: 'var(--accent)' }}>{row.icon}</span>
                  {row.entity}
                </div>
                <div style={{ ...rowStyle, borderBottom: border }}>
                  <KindBadge kind={row.d2m.kind} label={row.d2m.label} />
                  <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6, lineHeight: 1.45 }}>
                    {row.d2m.detail}
                  </div>
                </div>
                <div style={{ ...rowStyle, borderBottom: border }}>
                  <KindBadge kind={row.m2d.kind} label={row.m2d.label} />
                  <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6, lineHeight: 1.45 }}>
                    {row.m2d.detail}
                  </div>
                </div>
              </React.Fragment>
            );
          })}
        </div>
      </div>

      {/* Permitted vs Prohibited */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div
          className="panel"
          style={{
            padding: 24,
            background: 'linear-gradient(180deg, rgba(16, 185, 129, 0.04), rgba(16, 185, 129, 0))',
            border: '1px solid rgba(16, 185, 129, 0.18)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
            <CheckCircle2 size={20} color="#10b981" />
            <h2 style={{ margin: 0, fontSize: 15 }}>Marketo → CRM: Permitted</h2>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {PERMITTED.map(p => (
              <div
                key={p.title}
                style={{
                  padding: 14,
                  background: 'rgba(255,255,255,0.02)',
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                }}
              >
                <div style={{ fontSize: 13, fontWeight: 600 }}>{p.title}</div>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2, fontFamily: 'var(--mono, monospace)' }}>
                  {p.subtitle}
                </div>
                <ul style={{ margin: '10px 0 0', paddingLeft: 18, fontSize: 12.5, lineHeight: 1.55, color: 'var(--text)' }}>
                  {p.points.map((pt, i) => (
                    <li key={i} style={{ marginBottom: 4 }}>{pt}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>

        <div
          className="panel"
          style={{
            padding: 24,
            background: 'linear-gradient(180deg, rgba(239, 68, 68, 0.04), rgba(239, 68, 68, 0))',
            border: '1px solid rgba(239, 68, 68, 0.18)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
            <XCircle size={20} color="#ef4444" />
            <h2 style={{ margin: 0, fontSize: 15 }}>Marketo → CRM: Prohibited</h2>
          </div>
          <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none' }}>
            {PROHIBITED.map((p, i) => (
              <li
                key={i}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 10,
                  padding: '10px 0',
                  borderBottom: i === PROHIBITED.length - 1 ? 'none' : '1px solid var(--border)',
                  fontSize: 13,
                  lineHeight: 1.5,
                }}
              >
                <XCircle size={14} color="#ef4444" style={{ flexShrink: 0, marginTop: 3 }} />
                <span>{p}</span>
              </li>
            ))}
          </ul>
          <div
            style={{
              marginTop: 16,
              padding: 12,
              background: 'rgba(239, 68, 68, 0.06)',
              border: '1px solid rgba(239, 68, 68, 0.2)',
              borderRadius: 8,
              fontSize: 12,
              color: 'var(--muted)',
              lineHeight: 1.5,
            }}
          >
            Attempts to sync any prohibited combination are rejected by the authority guard and logged with reason{' '}
            <code style={{ color: '#ef4444' }}>marketo-cannot-*</code>.
          </div>
        </div>
      </div>

      {/* Classifier priority */}
      <div className="panel" style={{ padding: 24 }}>
        <SectionHeader
          icon={<Users size={18} />}
          title="Lead vs Contact Classification"
          subtitle="How a Marketo Person is classified (highest priority wins)."
        />
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '40px 1fr 140px 1fr',
            border: '1px solid var(--border)',
            borderRadius: 10,
            overflow: 'hidden',
          }}
        >
          <div style={{ ...rowStyle, ...headerStyle }}>#</div>
          <div style={{ ...rowStyle, ...headerStyle }}>Indicator</div>
          <div style={{ ...rowStyle, ...headerStyle }}>Classified as</div>
          <div style={{ ...rowStyle, ...headerStyle }}>Note</div>
          {CLASSIFIER.map((row, i) => {
            const isLast = i === CLASSIFIER.length - 1;
            const border = isLast ? 'none' : '1px solid var(--border)';
            const kindColor = row.kind === 'Contact'
              ? { bg: 'rgba(56, 189, 248, 0.12)', fg: 'var(--accent)', bd: 'rgba(56, 189, 248, 0.3)' }
              : row.kind === 'Lead'
              ? { bg: 'rgba(168, 85, 247, 0.12)', fg: '#c084fc',      bd: 'rgba(168, 85, 247, 0.3)' }
              : { bg: 'rgba(239, 68, 68, 0.1)',  fg: '#ef4444',      bd: 'rgba(239, 68, 68, 0.3)' };
            return (
              <React.Fragment key={row.idx}>
                <div style={{ ...rowStyle, borderBottom: border, color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>
                  {row.idx}
                </div>
                <div style={{ ...rowStyle, borderBottom: border, fontFamily: 'var(--mono, monospace)', fontSize: 12.5 }}>
                  {row.indicator}
                </div>
                <div style={{ ...rowStyle, borderBottom: border }}>
                  <span
                    style={{
                      display: 'inline-block',
                      padding: '2px 10px',
                      borderRadius: 6,
                      fontSize: 12,
                      fontWeight: 600,
                      background: kindColor.bg,
                      color: kindColor.fg,
                      border: `1px solid ${kindColor.bd}`,
                    }}
                  >
                    {row.kind}
                  </span>
                </div>
                <div style={{ ...rowStyle, borderBottom: border, fontSize: 12.5, color: 'var(--muted)' }}>
                  {row.note}
                </div>
              </React.Fragment>
            );
          })}
        </div>
      </div>

      {/* Eligibility criteria */}
      <div className="panel" style={{ padding: 24 }}>
        <SectionHeader
          icon={<CheckCircle2 size={18} />}
          title="New Lead Eligibility Criteria"
          subtitle="All criteria must pass for Marketo → CRM Lead creation to proceed."
        />
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '200px 1fr',
            border: '1px solid var(--border)',
            borderRadius: 10,
            overflow: 'hidden',
          }}
        >
          <div style={{ ...rowStyle, ...headerStyle }}>Criterion</div>
          <div style={{ ...rowStyle, ...headerStyle }}>Rule</div>
          {ELIGIBILITY_CRITERIA.map((row, i) => {
            const isLast = i === ELIGIBILITY_CRITERIA.length - 1;
            const border = isLast ? 'none' : '1px solid var(--border)';
            return (
              <React.Fragment key={row.criterion}>
                <div style={{ ...rowStyle, borderBottom: border, fontFamily: 'var(--mono, monospace)', fontSize: 12.5, color: 'var(--accent)' }}>
                  {row.criterion}
                </div>
                <div style={{ ...rowStyle, borderBottom: border, fontSize: 13, lineHeight: 1.5 }}>
                  {row.rule}
                </div>
              </React.Fragment>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ─── inline style primitives ─────────────────────────────────────────────
const rowStyle = {
  padding: '12px 16px',
  fontSize: 13,
};

const headerStyle = {
  background: 'rgba(255, 255, 255, 0.03)',
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '0.6px',
  textTransform: 'uppercase',
  color: 'var(--muted)',
  borderBottom: '1px solid var(--border)',
};

// ─── small composites ────────────────────────────────────────────────────
function GuidingCard({ accent, title, body }) {
  return (
    <div
      style={{
        padding: 14,
        borderRadius: 10,
        background: 'rgba(255, 255, 255, 0.02)',
        border: `1px solid ${accent}`,
        borderLeft: `3px solid ${accent}`,
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 600 }}>{title}</div>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4, lineHeight: 1.45 }}>{body}</div>
    </div>
  );
}
