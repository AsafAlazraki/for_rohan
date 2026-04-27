const { router: pullRouter } = require('../routes/pull');
'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { validateDynamicsSignature, validateMarketoSignature } = require('./validate');
const { normalizeDynamicsWebhookPayload, isRemoteExecutionContext } = require('./dynamicsPayload');
const { enqueue } = require('../queue/producer');
const logger = require('../audit/logger');
const eventsRouter = require('../routes/events');
const { router: configRouter } = require('../routes/config');


const { router: accountListRouter } = require('../routes/accountList');
const { router: engagementRouter } = require('../routes/engagement');
const { router: outboundWebhooksRouter } = require('../routes/outboundWebhooks');
const { router: transferRouter } = require('../routes/transfer');
const fieldmap = require('../config/fieldmap.json');

const QUEUE_NAME = process.env.SYNC_QUEUE_NAME || 'sync-events';

// Middleware that captures the raw body as a Buffer for HMAC verification
const rawBody = express.raw({ type: '*/*', limit: '1mb' });

const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});


function createApp() {
  const app = express();
  app.use('/api/pull', pullRouter);

  // helmet with relaxed CSP so the SPA's inline React bundle + SSE work.
  // For a POC this is fine; tighten for production.
  app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  }));

  // ── CORS (for split frontend/backend deploys, e.g. SWA + App Service) ─────
  // Comma-separated list of allowed origins. Requests with no Origin (curl,
  // server-to-server) are always allowed. Webhooks don't need CORS anyway.
  const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  if (allowedOrigins.length > 0) {
    app.use((req, res, next) => {
      const origin = req.headers.origin;
      if (origin && allowedOrigins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'false');
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      }
      if (req.method === 'OPTIONS') return res.sendStatus(204);
      next();
    });
  }

  // ── Health ────────────────────────────────────────────────────────────────

  app.get('/health', (_req, res) =>
    res.json({ status: 'ok', service: 'dynamics-marketo-sync', ts: new Date().toISOString() }));
  app.get('/ready', (_req, res) => res.json({ ready: true }));

  // ── Dapr subscription discovery ───────────────────────────────────────────
  app.get('/dapr/subscribe', (_req, res) => {
    const pubsubName = process.env.DAPR_PUBSUB_NAME || 'pubsub';
    const dynTopic = process.env.DAPR_TOPIC_DYNAMICS || 'dynamics-contacts';
    const mktTopic = process.env.DAPR_TOPIC_MARKETO || 'marketo-events';

    const subscriptions = [
      { pubsubname: pubsubName, topic: dynTopic, route: '/webhook/dynamics' },
      { pubsubname: pubsubName, topic: mktTopic, route: '/webhook/marketo' }
    ];
    res.json(subscriptions);
  });

  // ── POST /webhook/dynamics ────────────────────────────────────────────────
  app.post('/webhook/dynamics', webhookLimiter, rawBody, async (req, res) => {
    function tryParseEnvelope(rawBuffer) {
      try {
        const parsed = JSON.parse(rawBuffer.toString('utf8'));
        if (parsed && Object.prototype.hasOwnProperty.call(parsed, 'data')) return parsed;
      } catch { /* not JSON or not envelope */ }
      return null;
    }

    let envelope = tryParseEnvelope(req.body);
    let payloadRawBuffer;
    let signatureHeader;

    if (envelope) {
      payloadRawBuffer = Buffer.from(JSON.stringify(envelope.data), 'utf8');
      signatureHeader = req.headers['x-dynamics-signature'] || (envelope.metadata && envelope.metadata['x-dynamics-signature']);
    } else {
      payloadRawBuffer = req.body;
      signatureHeader = req.headers['x-dynamics-signature'];
    }

    let payload;
    if (envelope) payload = envelope.data;
    else {
      try { payload = JSON.parse(payloadRawBuffer.toString('utf8')); } catch { payload = payloadRawBuffer.toString('utf8'); }
    }

    logger.info({ source: 'dynamics', payloadKeys: payload ? Object.keys(payload) : null }, '[webhook/dynamics] Received webhook');

    let valid = false;
    if (process.env.ALLOW_UNVERIFIED_DAPR === 'true') {
      logger.warn({ source: 'dynamics' }, '[webhook/dynamics] Skipping signature check (ALLOW_UNVERIFIED_DAPR=true)');
      valid = true;
    } else {
      try {
        if (!signatureHeader) {
          return res.status(401).json({ error: 'Missing signature' });
        }
        valid = validateDynamicsSignature(payloadRawBuffer, { headers: { 'x-dynamics-signature': signatureHeader } });
        if (!valid) {
          logger.warn({ source: 'dynamics' }, '[webhook/dynamics] Signature validation failed');
        }
      } catch (err) {
        logger.error({ error: err.message }, '[webhook/dynamics] Signature validation error');
        return res.status(500).json({ error: 'Internal server error' });
      }
    }

    if (!valid) return res.status(401).json({ error: 'Invalid signature' });

    const wasContext = isRemoteExecutionContext(payload);
    const normalized = normalizeDynamicsWebhookPayload(payload);
    if (wasContext) {
      logger.info(
        { source: 'dynamics', flattenedKeys: Object.keys(normalized || {}) },
        '[webhook/dynamics] Flattened RemoteExecutionContext',
      );
    }

    try {
      const jobId = await enqueue(QUEUE_NAME, {
        source:     'dynamics',
        receivedAt: new Date().toISOString(),
        payload:    normalized,
        meta: {
          dapr: !!envelope,
          daprTopic: envelope ? envelope.topic : undefined,
        }
      });
      logger.info({ jobId, source: 'dynamics' }, '[webhook/dynamics] Enqueued job');
      res.status(200).json({ status: 'SUCCESS', jobId });
    } catch (err) {
      logger.error({ error: err.message }, '[webhook/dynamics] Enqueue failed');
      res.status(500).json({ error: err.message });
    }
  });

  // ── POST /webhook/marketo ─────────────────────────────────────────────────
  app.post('/webhook/marketo', webhookLimiter, rawBody, async (req, res) => {
    function tryParseEnvelope(rawBuffer) {
      try {
        const parsed = JSON.parse(rawBuffer.toString('utf8'));
        if (parsed && Object.prototype.hasOwnProperty.call(parsed, 'data')) return parsed;
      } catch { /* not JSON or not envelope */ }
      return null;
    }

    let envelope = tryParseEnvelope(req.body);
    let payloadRawBuffer;
    let signatureHeader;

    if (envelope) {
      payloadRawBuffer = Buffer.from(JSON.stringify(envelope.data), 'utf8');
      signatureHeader = req.headers['x-marketo-signature'] || (envelope.metadata && envelope.metadata['x-marketo-signature']);
    } else {
      payloadRawBuffer = req.body;
      signatureHeader = req.headers['x-marketo-signature'];
    }

    let payload;
    if (envelope) payload = envelope.data;
    else {
      try { payload = JSON.parse(payloadRawBuffer.toString('utf8')); } catch { payload = payloadRawBuffer.toString('utf8'); }
    }

    logger.info({ source: 'marketo', payloadKeys: payload ? Object.keys(payload) : null }, '[webhook/marketo] Received webhook');

    let valid = false;
    if (process.env.ALLOW_UNVERIFIED_DAPR === 'true') {
      logger.warn({ source: 'marketo' }, '[webhook/marketo] Skipping signature check (ALLOW_UNVERIFIED_DAPR=true)');
      valid = true;
    } else {
      try {
        if (!signatureHeader) {
          return res.status(401).json({ error: 'Missing signature' });
        }
        valid = validateMarketoSignature(payloadRawBuffer, { headers: { 'x-marketo-signature': signatureHeader } });
        if (!valid) {
          logger.warn({ source: 'marketo' }, '[webhook/marketo] Signature validation failed');
        }
      } catch (err) {
        logger.error({ error: err.message }, '[webhook/marketo] Signature validation error');
        return res.status(500).json({ error: 'Internal server error' });
      }
    }

    if (!valid) return res.status(401).json({ error: 'Invalid signature' });

    try {
      const jobId = await enqueue(QUEUE_NAME, {
        source:     'marketo',
        receivedAt: new Date().toISOString(),
        payload,
        meta: {
          dapr: !!envelope,
          daprTopic: envelope ? envelope.topic : undefined,
        }
      });
      logger.info({ jobId, source: 'marketo' }, '[webhook/marketo] Enqueued job');
      res.status(200).json({ status: 'SUCCESS', jobId });
    } catch (err) {
      logger.error({ error: err.message }, '[webhook/marketo] Enqueue failed');
      res.status(500).json({ error: err.message });
    }
  });

  // ── JSON-body API routes (mounted AFTER webhooks so the raw-body middleware
  //    on /webhook/* still applies) ───────────────────────────────────────────
  const apiJson = express.json({ limit: '1mb' });

  // Mount Service Bus messages API
  const servicebusRouter = require('../routes/servicebus');
  app.use('/api/servicebus', apiJson, servicebusRouter);

  app.use('/api/events', apiJson, eventsRouter);
  app.use('/api/config', apiJson, configRouter);


  app.use('/api/account-list', apiJson, accountListRouter);
  app.use('/api/engagement', apiJson, engagementRouter);
  app.use('/api/webhooks', apiJson, outboundWebhooksRouter);
  app.use('/api/transfer', apiJson, transferRouter);
  app.get('/api/fieldmap', (_req, res) => res.json(fieldmap));

  // ── React SPA static serving (built to web/dist) ──────────────────────────
  const spaDir = path.resolve(__dirname, '../../web/dist');
  if (fs.existsSync(spaDir)) {
    app.use(express.static(spaDir));
    // SPA fallback for anything that isn't an API/webhook route
    app.get(/^(?!\/api\/|\/webhook\/|\/health|\/ready).*/, (_req, res) => {
      res.sendFile(path.join(spaDir, 'index.html'));
    });
  } else {
    logger.info({ spaDir }, '[listeners] web/dist not found — SPA not served (run `npm run build:web`)');
  }

  return app;
}

/**
 * Start the webhook listener server.
 * @param {number} [port]
 * @returns {Promise<import('http').Server>}
 */
function startListeners(port = process.env.PORT || 3000) {
  const app = createApp();
  return new Promise((resolve, reject) => {
    const server = app.listen(Number(port), () => {
      console.log(`[listeners] webhook server on port ${port}`);
      resolve(server);
    });
    server.on('error', reject);
  });
}

module.exports = { createApp, startListeners };
