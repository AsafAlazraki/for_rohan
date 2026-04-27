// src/routes/servicebus.js
'use strict';

const express = require('express');
const { getRecentJobs, getJobCount } = require('./jobQuery');

const router = express.Router();

/**
 * GET /api/servicebus/messages?limit=20
 * Returns the most recent Service Bus (Dapr) messages from the sync queue.
 * Only for operator/debug UI. Not for production use.
 */
const logger = require('../audit/logger');
router.get('/messages', async (req, res) => {
  const limit = Math.max(1, Math.min(500, parseInt(req.query.limit, 10) || 50));
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const offset = (page - 1) * limit;
  const status = req.query.status || null;
  const search = req.query.search || null;

  try {
    const [jobs, total] = await Promise.all([
      getRecentJobs(null, { limit, offset, status, search }),
      getJobCount(null, { status, search })
    ]);

    logger.info({ limit, page, status, search, jobCount: jobs.length, total }, '[servicebus] /messages debug');
    
    // Activity type labels for Marketo jobs
    const TYPE_LABELS = {
      1:  'Web Visit',
      2:  'Form Submit',
      7:  'Email Delivered',
      9:  'Email Click',
      10: 'Email Open',
      14: 'Campaign Response',
    };

    const messages = jobs.map(j => {
      let parsedData = null;
      let activityTypeLabel = null;
      let assetName = null;
      let campaignName = null;
      let error = null;
      
      if (typeof j.data === 'string') {
        try {
          parsedData = JSON.parse(j.data);
        } catch {
          error = 'Invalid JSON';
        }
      } else {
        parsedData = j.data;
      }

      if (j.name === 'marketo-engagement-ingest' && parsedData) {
        if (parsedData.activityTypeId && TYPE_LABELS[parsedData.activityTypeId]) {
          activityTypeLabel = TYPE_LABELS[parsedData.activityTypeId];
        }
        assetName = parsedData.assetName || parsedData.primaryAttributeValue || null;
        campaignName = parsedData.campaignName || null;
      }

      // Derive source / destination from job data
      let source = null;
      let destination = null;
      if (j.name === 'marketo-engagement-ingest') {
        source = 'Marketo';
        destination = 'Dynamics';
      } else if (parsedData && parsedData.source) {
        const s = (parsedData.source || '').toLowerCase();
        if (s === 'dynamics') {
          source = 'Dynamics';
          destination = 'Marketo';
        } else if (s === 'marketo') {
          source = 'Marketo';
          destination = 'Dynamics';
        } else {
          source = parsedData.source;
          destination = null;
        }
      }

      // Derive entity type (Contact, Lead, etc.)
      let type = 'Contact';
      if (j.name === 'marketo-engagement-ingest') {
        type = 'Activity';
      } else if (parsedData && parsedData.payload && parsedData.payload.type) {
        // Simulated jobs often have payload.type
        type = parsedData.payload.type.charAt(0).toUpperCase() + parsedData.payload.type.slice(1);
      } else if (parsedData && parsedData.type) {
        type = parsedData.type.charAt(0).toUpperCase() + parsedData.type.slice(1);
      } else if (parsedData) {
        const p = parsedData.payload || parsedData;
        if (p.leadid || p.crmLeadId || p.isLead) {
          type = 'Lead';
        } else if (p.accountid || p.type === 'account') {
          type = 'Account';
        } else if (p.contactid || p.crmContactId || p.isCustomer) {
          type = 'Contact';
        }
      }

      return {
        id: j.id,
        name: j.name,
        state: j.state,
        createdOn: j.createdon,
        completedOn: j.completedon,
        retryCount: j.retrycount,
        data: parsedData,
        source,
        destination,
        type,
        activityTypeLabel,
        assetName,
        campaignName,
        parseError: error,
      };
    });

    res.json({ 
      messages,
      pagination: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (err) {
    logger.error({ error: err.message }, '[servicebus] /messages error');
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
