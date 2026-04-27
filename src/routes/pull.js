// src/routes/pull.js
'use strict';

const express = require('express');
const { readDynamics } = require('../readers/dynamics');
const { readMarketo } = require('../readers/marketo');

const router = express.Router();

/**
 * GET /api/pull?side=dynamics|marketo&entity=contact|lead&limit=10&cursor=...
 * Fetch records from Dynamics or Marketo for sync preview.
 */
router.get('/', async (req, res) => {
  const { side, entity = 'contact', limit = 10, cursor } = req.query;
  try {
    let result;
    if (side === 'dynamics') {
      // Auto-paginate on the server: follow nextCursor until Dataverse
      // indicates completion and aggregate all rows into one response.
      // Safety: very large cap to avoid unbounded memory use in pathological cases.
      const MAX_AGGREGATE_ROWS = 1000000;
      let allRows = [];
      let nextCursor = typeof cursor === 'undefined' ? undefined : cursor;
      let lastNote = null;
      let lastError = null;
      while (true) {
        const page = await readDynamics({ entity, limit: Number(limit), cursor: nextCursor });
        allRows = allRows.concat(page.rows || []);
        lastNote = page.note || lastNote;
        lastError = page.error || lastError;
        nextCursor = page.nextCursor || null;
        if (!nextCursor) break;
        if (allRows.length >= MAX_AGGREGATE_ROWS) {
          // Stop early to avoid exhausting memory; return what we have with a note.
          lastNote = lastNote || `Pull aborted after ${allRows.length} rows to avoid excessive memory usage.`;
          break;
        }
      }
      result = { rows: allRows, nextCursor };
      if (lastError) result.error = lastError;
      if (lastNote) result.note = lastNote;
    } else if (side === 'marketo') {
      result = await readMarketo({ entity, limit: Number(limit), cursor });
    } else {
      return res.status(400).json({ error: 'Missing or invalid side (dynamics|marketo)' });
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = { router };