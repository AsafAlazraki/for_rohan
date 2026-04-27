'use strict';

/**
 * REST CRUD for outbound webhook sinks + delivery history.
 *
 *   GET    /api/webhooks/sinks                  — list all sinks
 *   POST   /api/webhooks/sinks                  — create a sink
 *   PUT    /api/webhooks/sinks/:id              — update a sink
 *   DELETE /api/webhooks/sinks/:id              — delete a sink
 *   GET    /api/webhooks/deliveries?sinkId=&limit=
 *                                              — delivery history (debug)
 *
 * Secrets are masked in GET responses (last 4 chars + stars) so the UI can
 * display them without leaking the HMAC key.
 */

const express = require('express');
const {
  listSinks, createSink, updateSink, deleteSink, listDeliveries,
} = require('../webhooks/outboundDispatcher');

const router = express.Router();

function maskSecret(s) {
  if (!s || typeof s !== 'string') return '';
  if (s.length <= 4) return '*'.repeat(s.length);
  return '*'.repeat(s.length - 4) + s.slice(-4);
}

function publicSink(sink) {
  if (!sink) return sink;
  return { ...sink, secret: maskSecret(sink.secret) };
}

router.get('/sinks', async (_req, res) => {
  try {
    const sinks = await listSinks();
    res.json({ sinks: sinks.map(publicSink) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/sinks', async (req, res) => {
  const body = req.body || {};
  if (!body.name || !body.url || !body.secret) {
    return res.status(400).json({ error: 'name, url, and secret are required' });
  }
  try {
    const sink = await createSink({
      name:            String(body.name),
      url:             String(body.url),
      secret:          String(body.secret),
      filter_status:   Array.isArray(body.filter_status)   ? body.filter_status   : null,
      filter_category: Array.isArray(body.filter_category) ? body.filter_category : null,
      filter_sources:  Array.isArray(body.filter_sources)  ? body.filter_sources  : null,
      enabled:         body.enabled === undefined ? true : !!body.enabled,
    });
    res.status(201).json({ sink: publicSink(sink) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/sinks/:id', async (req, res) => {
  const { id } = req.params;
  const patch  = req.body || {};
  try {
    const sink = await updateSink(id, patch);
    if (!sink) return res.status(404).json({ error: 'sink not found' });
    res.json({ sink: publicSink(sink) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/sinks/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const ok = await deleteSink(id);
    if (!ok) return res.status(404).json({ error: 'sink not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/deliveries', async (req, res) => {
  const sinkId = req.query.sinkId ? String(req.query.sinkId) : null;
  const limit  = req.query.limit  ? parseInt(req.query.limit, 10) : 50;
  try {
    const deliveries = await listDeliveries({ sinkId, limit });
    res.json({ deliveries });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = { router };
