'use strict';

const express = require('express');
const { listConfig, setConfig, maskSecret } = require('../config/loader');

const router = express.Router();

// Fixed schema the Admin page renders. Keeps the UI stable regardless of what
// happens to sit in the DB.
const KNOWN_KEYS = [
  // Dynamics
  { key: 'DYNAMICS_TENANT_ID',       group: 'Dynamics', secret: true  },
  { key: 'DYNAMICS_CLIENT_ID',       group: 'Dynamics', secret: true  },
  { key: 'DYNAMICS_CLIENT_SECRET',   group: 'Dynamics', secret: true  },
  { key: 'DYNAMICS_RESOURCE_URL',    group: 'Dynamics', secret: false },
  { key: 'DYNAMICS_API_VERSION',     group: 'Dynamics', secret: false },
  // Marketo
  { key: 'MARKETO_BASE_URL',         group: 'Marketo',  secret: false },
  { key: 'MARKETO_CLIENT_ID',        group: 'Marketo',  secret: true  },
  { key: 'MARKETO_CLIENT_SECRET',    group: 'Marketo',  secret: true  },
  { key: 'MARKETO_DEMO_LIST_ID',     group: 'Marketo',  secret: false },
  // Webhook secrets
  { key: 'DYNAMICS_WEBHOOK_SECRET',  group: 'Webhooks', secret: true  },
  { key: 'MARKETO_WEBHOOK_SECRET',   group: 'Webhooks', secret: true  },
  // Engagement (Doc 2 — Marketo activity → Dynamics task ingest)
  { key: 'MARKETO_INGEST_INTERVAL_MIN',    group: 'Engagement', secret: false },
  { key: 'MARKETO_INGEST_LOOKBACK_HOURS',  group: 'Engagement', secret: false },
  { key: 'MARKETO_INGEST_ENABLED',         group: 'Engagement', secret: false },
  { key: 'MARKETO_WEB_VISIT_KEY_URLS',     group: 'Engagement', secret: false },
  { key: 'MARKETO_ENGAGEMENT_CURSOR',      group: 'Engagement', secret: false },
  { key: 'MARKETO_ENGAGEMENT_LAST_RUN',    group: 'Engagement', secret: false },
  // Integration rules — spec-decision flags for leadEligibility.js and
  // accountResolver.js. All non-secret; blank disables the corresponding gate
  // (except ACCOUNT_NETSUITE_FIELD which falls back to cr_netsuiteid).
  { key: 'LEAD_COUNTRY_ALLOWLIST',         group: 'Integration rules', secret: false },
  { key: 'LEAD_LIFECYCLE_MIN',             group: 'Integration rules', secret: false },
  { key: 'LEAD_SOURCE_ALLOWLIST',          group: 'Integration rules', secret: false },
  { key: 'ACCOUNT_NETSUITE_FIELD',         group: 'Integration rules', secret: false },
];

/**
 * GET /api/config
 * Returns the fixed schema merged with current DB values (secrets masked).
 */
router.get('/', async (_req, res) => {
  try {
    const rows  = await listConfig();
    const byKey = Object.fromEntries(rows.map(r => [r.key, r]));

    const out = KNOWN_KEYS.map(spec => {
      const dbRow  = byKey[spec.key];
      const envVal = process.env[spec.key];

      // Match getConfig() resolution: .env wins over admin_config so the UI
      // reflects the values the running service will actually use.
      if (envVal != null && envVal !== '') {
        return {
          key:        spec.key,
          group:      spec.group,
          is_secret:  spec.secret,
          value:      spec.secret ? maskSecret(envVal) : envVal,
          set:        true,
          source:     'env',
          updated_at: null,
        };
      }

      return {
        key:        spec.key,
        group:      spec.group,
        is_secret:  spec.secret,
        value:      dbRow?.value || '',
        set:        !!dbRow,
        source:     dbRow ? 'db' : null,
        updated_at: dbRow?.updated_at || null,
      };
    });

    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/config  { key, value }
 * Upserts a single config row. is_secret is inferred from KNOWN_KEYS.
 */
router.post('/', async (req, res) => {
  const { key, value } = req.body || {};

  if (!key || typeof key !== 'string') {
    return res.status(400).json({ error: 'key is required' });
  }
  if (typeof value !== 'string') {
    return res.status(400).json({ error: 'value must be a string' });
  }

  const spec = KNOWN_KEYS.find(k => k.key === key);
  if (!spec) return res.status(400).json({ error: `Unknown config key: ${key}` });

  try {
    await setConfig(key, value, spec.secret);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = { router, KNOWN_KEYS };
