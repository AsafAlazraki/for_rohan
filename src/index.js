'use strict';

require('dotenv').config();

// Boot-time vars — without these the service can't reach its own config store,
// so we can't even offer the Admin UI. Missing => hard fail.
const REQUIRED_ENV = [
  'DATABASE_URL',
];

// Runtime-configurable vars — managed by the Admin UI via admin_config.
// Missing at boot is fine; the service starts in "unconfigured" mode and the
// operator fills these in through the UI.
const ADMIN_UI_ENV = [
  'DYNAMICS_TENANT_ID',
  'DYNAMICS_CLIENT_ID',
  'DYNAMICS_CLIENT_SECRET',
  'DYNAMICS_RESOURCE_URL',
  'DYNAMICS_WEBHOOK_SECRET',
  'MARKETO_BASE_URL',
  'MARKETO_CLIENT_ID',
  'MARKETO_CLIENT_SECRET',
  'MARKETO_WEBHOOK_SECRET',
];

/**
 * Validate boot-time env vars. Hard-exits on missing DATABASE_URL since the
 * service cannot reach the database without it. Admin-UI-managed
 * vars are only warned about — the operator can set them via the UI.
 *
 * @param {boolean} [exitOnMissing=true]
 */
function validateEnv(exitOnMissing = true) {
  const missing = REQUIRED_ENV.filter(k => !process.env[k]);
  const unset   = ADMIN_UI_ENV.filter(k => !process.env[k]);

  if (unset.length > 0) {
    console.warn(
      `[bootstrap] ${unset.length} runtime config var(s) unset — set via Admin UI (/admin):\n` +
      `  ${unset.join('\n  ')}`,
    );
  }

  if (missing.length === 0) return;

  const msg =
    `[bootstrap] FATAL — missing required environment variables:\n` +
    `  ${missing.join('\n  ')}\n\n` +
    `  These are needed to reach the admin_config store. ` +
    `Copy .env.example to .env and fill them in before starting.`;

  if (exitOnMissing) {
    console.error(msg);
    process.exit(1);
  }
  throw new Error(msg);
}

/**
 * Bootstrap the full application stack.
 *
 * Start order:
 *   1. HTTP listener  (webhooks + health)
 *   2. BullMQ worker  (job processor)
 *   3. DLQ listener   (capture final failures)
 *   4. Alert monitor  (heartbeat)
 *
 * @returns {Promise<{ server: import('http').Server, worker: import('bullmq').Worker }>}
 */
async function main() {
  const { createApp }         = require('./listeners/server');
  const { startWorkers }      = require('./queue/worker');
  const { attachDLQListener } = require('./queue/dlq');
  const { stopBoss }          = require('./queue/queue');
  const { startMonitor, stopMonitor } = require('./monitor/alerts');
  const { startEngagementScheduler }  = require('./engagement/scheduler');
  const { checkEngagementEntity }     = require('./engagement/activityWriter');
  const { getDynamicsToken }          = require('./auth/dynamics');
  const { getPool }           = require('./audit/db');
  const logger                = require('./audit/logger');

  logger.info('[bootstrap] Starting dynamics-marketo-sync…');

  // ── 1. HTTP server ──────────────────────────────────────────────────────────
  const PORT = parseInt(process.env.PORT || '3000', 10);
  const app = createApp();

  const server = await new Promise((resolve, reject) => {
    const s = app.listen(PORT, () => {
      logger.info({ port: PORT }, '[bootstrap] HTTP server started');
      resolve(s);
    });
    s.on('error', reject);
  });

  // ── 2 + 3. pg-boss worker + DLQ ───────────────────────────────────────────
  const worker = await startWorkers();
  await attachDLQListener();
  logger.info({ concurrency: process.env.SYNC_CONCURRENCY || 5 }, '[bootstrap] Worker started');

  // ── 3b. Engagement-ingest scheduler (Doc 2) ────────────────────────────────
  try {
    const sched = await startEngagementScheduler();
    logger.info(sched, '[bootstrap] Engagement scheduler ready');
  } catch (err) {
    // Don't fail boot — the rest of the service should still come up.
    logger.error({ error: err.message }, '[bootstrap] Engagement scheduler failed to start');
  }

  // ── 3c. Engagement-entity boot check (spec #3 §5.1) ────────────────────────
  // Fire-and-forget WARN-only probe: if the custom `ubt_marketingengagementactivity`
  // entity is missing in Dataverse we log once so operators know engagement
  // writes will fail until it's created. Mirrors the connection-role check
  // wired from src/queue/worker.js. Never blocks startup.
  (async () => {
    try {
      const token = await getDynamicsToken();
      const status = await checkEngagementEntity(token);
      if (status.ok) {
        logger.info({ logicalName: status.logicalName }, '[bootstrap] Engagement entity present ✓');
      }
    } catch (err) {
      logger.info({ err: err.message }, '[bootstrap] skipping engagement-entity boot check (no Dynamics token)');
    }
  })();

  // ── 4. Monitor ──────────────────────────────────────────────────────────────
  startMonitor();
  logger.info('[bootstrap] Alert monitor started');

  logger.info('[bootstrap] All services online ✓');

  // ── Graceful shutdown ───────────────────────────────────────────────────────
  async function shutdown(signal) {
    logger.info({ signal }, '[bootstrap] Graceful shutdown initiated');

    // Stop accepting new HTTP requests
    await new Promise(resolve => server.close(resolve));
    logger.info('[bootstrap] HTTP server closed');

    // Drain in-flight queue jobs (pg-boss handles graceful drain)
    try {
      await stopBoss();
      logger.info('[bootstrap] Worker drained');
    } catch (err) {
      logger.error({ error: err.message }, '[bootstrap] Worker close error');
    }

    // Release Postgres connections
    try {
      await getPool().end();
      logger.info('[bootstrap] DB pool closed');
    } catch (err) {
      logger.error({ error: err.message }, '[bootstrap] DB pool close error');
    }

    // Stop heartbeat
    stopMonitor();
    logger.info('[bootstrap] Monitor stopped');

    logger.info('[bootstrap] Shutdown complete');
    process.exit(0);
  }

  // Use once() so a second signal during shutdown doesn't re-enter
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT',  () => shutdown('SIGINT'));

  return { server, worker };
}

// ── Entry point ───────────────────────────────────────────────────────────────
if (require.main === module) {
  validateEnv();          // hard exit on missing vars
  main().catch(err => {
    console.error('[bootstrap] Fatal startup error:', err.message);
    process.exit(1);
  });
}

module.exports = { validateEnv, main, REQUIRED_ENV, ADMIN_UI_ENV };
