'use strict';

const axios = require('axios');
const { getConfig } = require('../config/loader');
const { getMarketoToken } = require('../auth/marketo');

const LEAD_FIELDS = [
  'id','email','firstName','lastName','phone','title','company',
  'city','state','country','postalCode',
];

function parseCsvLine(line) {
  const values = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQuotes = !inQuotes; }
    else if (ch === ',' && !inQuotes) { values.push(current); current = ''; }
    else { current += ch; }
  }
  values.push(current);
  return values;
}

// Marketo's bulk-export CSV labels columns with field display names (e.g.
// "First Name"). Map them back to REST API names so callers see the same
// shape as the list-membership endpoint.
const DISPLAY_TO_API = {
  'id':              'id',
  'email address':   'email',
  'first name':      'firstName',
  'last name':       'lastName',
  'phone number':    'phone',
  'job title':       'title',
  'company name':    'company',
  'city':            'city',
  'state':           'state',
  'country':         'country',
  'postal code':     'postalCode',
};

function normalizeHeader(h) {
  const key = h.trim().toLowerCase();
  return DISPLAY_TO_API[key] || h.trim();
}

function parseCsv(text) {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]).map(normalizeHeader);
  return lines.slice(1).map(line => {
    const values = parseCsvLine(line);
    return Object.fromEntries(headers.map((h, i) => {
      const v = values[i] ?? '';
      return [h, v.toLowerCase() === 'null' ? '' : v];
    }));
  });
}

// Marketo's Bulk Lead Extract API supports smartListId as a filter, unlike
// the standard list-membership endpoint which only works with static lists.
async function bulkExportSmartList(baseUrl, token, smartListId) {
  const headers = { Authorization: `Bearer ${token}` };

  const createRes = await axios.post(
    `${baseUrl}/bulk/v1/leads/export/create.json`,
    { filter: { smartListId: Number(smartListId) }, fields: LEAD_FIELDS, format: 'CSV' },
    { headers },
  );
  if (!createRes.data.success) {
    throw new Error(`[readers/marketo] export create failed: ${JSON.stringify(createRes.data.errors)}`);
  }
  const exportId = createRes.data.result[0].exportId;

  await axios.post(`${baseUrl}/bulk/v1/leads/export/${exportId}/enqueue.json`, {}, { headers });

  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const statusRes = await axios.get(
      `${baseUrl}/bulk/v1/leads/export/${exportId}/status.json`,
      { headers },
    );
    if (!statusRes.data.success) continue;
    const { status } = statusRes.data.result[0];
    if (status === 'Completed') break;
    if (status === 'Failed' || status === 'Cancelled') {
      throw new Error(`[readers/marketo] bulk export ${status.toLowerCase()}`);
    }
    if (i === 19) throw new Error('[readers/marketo] bulk export timed out after 60s');
  }

  const fileRes = await axios.get(
    `${baseUrl}/bulk/v1/leads/export/${exportId}/file.json`,
    { headers, responseType: 'text' },
  );
  return parseCsv(fileRes.data);
}

/**
 * Read a page of leads from Marketo.
 *
 * Tries the standard list-membership endpoint first (works for static lists).
 * Falls back to the Bulk Lead Extract API if the list ID resolves to a Smart
 * List — the bulk API explicitly supports smartListId as a filter. Cursor is
 * a Marketo nextPageToken for static lists, or a numeric offset string for
 * smart list bulk exports.
 *
 * @param {object} opts
 * @param {'contact'|'lead'|'account'} opts.entity
 * @param {number} [opts.limit=10]
 * @param {string|null} [opts.cursor]
 * @returns {Promise<{ rows: object[], nextCursor: string|null, note?: string }>}
 */
// Marketo's Companies API only supports lookup by known values, and Named
// Accounts requires the paid ABM feature. Derive accounts from the unique
// `company` values of leads in the configured Smart List — in Marketo's data
// model, companies are primarily attributes of leads.
function deriveAccountsFromLeads(leads) {
  const byCompany = new Map();
  for (const lead of leads) {
    const name = (lead.company || '').trim();
    if (!name || name.toLowerCase() === 'null') continue;
    if (!byCompany.has(name)) {
      byCompany.set(name, {
        id:         name,
        accountid:  name,
        name,
        company:    name,
        city:       lead.city || '',
        state:      lead.state || '',
        country:    lead.country || '',
        postalCode: lead.postalCode || '',
      });
    }
  }
  return [...byCompany.values()];
}

async function readMarketo({ entity, limit = 10, cursor = null }) {
  const baseUrl = await getConfig('MARKETO_BASE_URL');
  if (!baseUrl) throw new Error('MARKETO_BASE_URL not configured');

  const listId = await getConfig('MARKETO_DEMO_LIST_ID');
  if (!listId) {
    return {
      rows: [],
      nextCursor: null,
      note: 'No demo list configured for Marketo reads. Set MARKETO_DEMO_LIST_ID in Admin → Marketo (use a Smart List ID for auto-updating results).',
    };
  }

  const token = await getMarketoToken();

  if (entity === 'account') {
    const leads  = await bulkExportSmartList(baseUrl, token, listId);
    const all    = deriveAccountsFromLeads(leads);
    const offset = cursor && Number.isInteger(Number(cursor)) ? Number(cursor) : 0;
    const page   = all.slice(offset, offset + limit);
    return {
      rows: page,
      nextCursor: offset + limit < all.length ? String(offset + limit) : null,
    };
  }

  const params = {
    batchSize: String(limit),
    fields:    LEAD_FIELDS.join(','),
  };
  if (cursor && !Number.isInteger(Number(cursor))) params.nextPageToken = cursor;

  const { data } = await axios.get(
    `${baseUrl}/rest/v1/list/${encodeURIComponent(listId)}/leads.json`,
    { params, headers: { Authorization: `Bearer ${token}` } },
  );

  if (!data.success) {
    const isNotFound = (data.errors || []).some(e => String(e.code) === '1013');
    if (!isNotFound) {
      throw new Error(`[readers/marketo] list read failed: ${JSON.stringify(data.errors)}`);
    }
    // Smart List — fall back to Bulk Extract API
    const rows = await bulkExportSmartList(baseUrl, token, listId);
    const offset = cursor && Number.isInteger(Number(cursor)) ? Number(cursor) : 0;
    const page = rows.slice(offset, offset + limit);
    return {
      rows: page,
      nextCursor: offset + limit < rows.length ? String(offset + limit) : null,
    };
  }

  return {
    rows: data.result || [],
    nextCursor: data.moreResult ? (data.nextPageToken || null) : null,
  };
}

module.exports = { readMarketo };
