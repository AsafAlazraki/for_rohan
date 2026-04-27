'use strict';

const express = require('express');
const logger  = require('../audit/logger');
const {
  getSchemaStatus,
  createCustomFields,
  REQUIRED_LEAD_FIELDS,
} = require('../auth/marketoSchema');

const router = express.Router();

/**
 * GET /api/marketo/schema-status
 *
 * Returns whether Marketo's Lead schema has the custom fields the integration
 * needs (`crmEntityType`, `crmContactId`, `crmLeadId`). Drives the in-SPA
 * "Set up Marketo fields" banner.
 */
router.get('/schema-status', async (_req, res) => {
  try {
    const status = await getSchemaStatus();
    res.json({
      ...status,
      requiredFields: REQUIRED_LEAD_FIELDS.map(f => ({
        name: f.name, displayName: f.displayName, dataType: f.dataType,
      })),
    });
  } catch (err) {
    logger.error({ err: err.message }, '[marketo/schema-status] failed');
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/marketo/setup-custom-fields
 *
 * Creates the three custom fields the integration depends on. Idempotent —
 * fields that already exist return `status: 'already-exists'`. 401/403 from
 * Marketo (API user lacks Read-Write Schema Custom Fields permission) is
 * surfaced as HTTP 502 with a hint.
 */
router.post('/setup-custom-fields', async (_req, res) => {
  try {
    const result = await createCustomFields();
    const permissionFailure = result.results.find(
      r => r.accessDenied || r.httpStatus === 401 || r.httpStatus === 403,
    );
    if (permissionFailure) {
      return res.status(502).json({
        ...result,
        accessDenied: true,
        error: permissionFailure.error,
        hint:
          'The Marketo API user does not have the "Read-Write Schema Custom Fields" ' +
          'permission (Marketo returned error 603 — Access Denied). You have two choices:',
        manualSetup: {
          steps: [
            'Open Marketo Admin → Field Management.',
            'Click "New Custom Field" and create each of the fields below.',
            'Once all three exist, reload this page — the banner will clear.',
          ],
          fields: REQUIRED_LEAD_FIELDS.map(f => ({
            name:        f.name,
            displayName: f.displayName,
            dataType:    f.dataType,
            description: f.description,
          })),
          permissionFix:
            'Alternatively, ask your Marketo admin to grant the "Read-Write Schema ' +
            'Custom Fields" role permission to the API user, then click "Try again".',
        },
      });
    }
    logger.info(
      { created: result.created, alreadyExisted: result.alreadyExisted, failed: result.failed },
      '[marketo/setup-custom-fields] complete',
    );
    res.json(result);
  } catch (err) {
    logger.error({ err: err.message }, '[marketo/setup-custom-fields] failed');
    res.status(500).json({ error: err.message });
  }
});

module.exports = { router };
