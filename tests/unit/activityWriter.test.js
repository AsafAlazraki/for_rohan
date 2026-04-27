'use strict';

/**
 * Unit tests for src/engagement/activityWriter.js — confirms POST shape to
 * the custom `ubt_marketingengagementactivity` entity, dedicated fields in
 * the body, option-value mapping for each supported Marketo type id,
 * axios error unwrapping, and the boot-check probe.
 */

jest.mock('axios', () => ({ get: jest.fn(), post: jest.fn() }));
jest.mock('../../src/audit/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(),
}));
jest.mock('../../src/config/loader', () => ({
  getConfig: jest.fn(async (k) => {
    if (k === 'DYNAMICS_RESOURCE_URL') return 'https://t.crm.dynamics.com';
    if (k === 'DYNAMICS_API_VERSION')  return '9.2';
    return null;
  }),
}));

const axios = require('axios');
const {
  writeEngagementActivity,
  checkEngagementEntity,
  _buildEngagementBody,
  TYPE_LABELS,
  TYPE_TO_OPTION,
  DEFAULT_ENTITY_SET,
  DEFAULT_ENTITY_LOGICAL,
} = require('../../src/engagement/activityWriter');

// Default config mock — individual tests can override via mockImplementation.
function installDefaultGetConfig() {
  const { getConfig } = require('../../src/config/loader');
  getConfig.mockImplementation(async (k) => {
    if (k === 'DYNAMICS_RESOURCE_URL') return 'https://t.crm.dynamics.com';
    if (k === 'DYNAMICS_API_VERSION')  return '9.2';
    return null;
  });
}

beforeEach(() => {
  jest.resetAllMocks();
  installDefaultGetConfig();
});

describe('writeEngagementActivity — input validation', () => {
  test('throws when activity missing', async () => {
    await expect(writeEngagementActivity({ activity: null, contactId: 'c', token: 't' }))
      .rejects.toThrow(/activity is required/);
  });
  test('throws when contactId missing', async () => {
    await expect(writeEngagementActivity({ activity: { id: 1 }, contactId: null, token: 't' }))
      .rejects.toThrow(/contactId is required/);
  });
  test('throws when token missing', async () => {
    await expect(writeEngagementActivity({ activity: { id: 1 }, contactId: 'c' }))
      .rejects.toThrow(/token is required/);
  });
  test('throws when DYNAMICS_RESOURCE_URL missing', async () => {
    const { getConfig } = require('../../src/config/loader');
    getConfig.mockImplementation(async () => null);
    await expect(writeEngagementActivity({ activity: { id: 1 }, contactId: 'c', token: 't' }))
      .rejects.toThrow(/DYNAMICS_RESOURCE_URL/);
  });
});

describe('writeEngagementActivity — 429 retry', () => {
  test('retries on 429 and succeeds, parses Retry-After header', async () => {
    jest.useFakeTimers();
    axios.post
      .mockRejectedValueOnce({ response: { status: 429, headers: { 'retry-after': '0' } } })
      .mockResolvedValueOnce({ data: { activityid: 'eng-2' }, headers: {} });
    const p = writeEngagementActivity({ activity: { id: 1, activityTypeId: 1 }, contactId: 'c1', token: 't' });
    await jest.runAllTimersAsync();
    const r = await p;
    expect(r.activityId).toBe('eng-2');
    jest.useRealTimers();
  });

  test('uses default retry-after when header missing', async () => {
    jest.useFakeTimers();
    axios.post
      .mockRejectedValueOnce({ response: { status: 429, headers: {} } })
      .mockResolvedValueOnce({ data: { activityid: 'eng-3' }, headers: {} });
    const p = writeEngagementActivity({ activity: { id: 1, activityTypeId: 1 }, contactId: 'c1', token: 't' });
    await jest.runAllTimersAsync();
    const r = await p;
    expect(r.activityId).toBe('eng-3');
    jest.useRealTimers();
  });

  test('throws via unwrapAxiosError on string body', async () => {
    axios.post.mockRejectedValueOnce({
      response: { status: 500, data: 'Internal server error' },
    });
    await expect(writeEngagementActivity({
      activity: { id: 1, activityTypeId: 1 }, contactId: 'c1', token: 't',
    })).rejects.toThrow(/HTTP 500: Internal server error/);
  });

  test('throws via unwrapAxiosError with errors array', async () => {
    axios.post.mockRejectedValueOnce({
      response: { status: 400, data: { errors: [{ code: 'X', message: 'bad' }, {}] } },
    });
    await expect(writeEngagementActivity({
      activity: { id: 1, activityTypeId: 1 }, contactId: 'c1', token: 't',
    })).rejects.toThrow(/X:bad/);
  });

  test('throws via unwrapAxiosError with data.message field', async () => {
    axios.post.mockRejectedValueOnce({
      response: { status: 400, data: { message: 'just-message' } },
    });
    await expect(writeEngagementActivity({
      activity: { id: 1, activityTypeId: 1 }, contactId: 'c1', token: 't',
    })).rejects.toThrow(/HTTP 400: just-message/);
  });

  test('throws via unwrapAxiosError with data.error.message field', async () => {
    axios.post.mockRejectedValueOnce({
      response: { status: 400, data: { error: { message: 'odata-bad' } } },
    });
    await expect(writeEngagementActivity({
      activity: { id: 1, activityTypeId: 1 }, contactId: 'c1', token: 't',
    })).rejects.toThrow(/odata-bad/);
  });

  test('parseRetryAfter ignores non-numeric headers', async () => {
    jest.useFakeTimers();
    axios.post
      .mockRejectedValueOnce({ response: { status: 429, headers: { 'retry-after': 'not-a-number' } } })
      .mockResolvedValueOnce({ data: { activityid: 'eng-4' }, headers: {} });
    const p = writeEngagementActivity({ activity: { id: 1, activityTypeId: 1 }, contactId: 'c1', token: 't' });
    await jest.runAllTimersAsync();
    const r = await p;
    expect(r.activityId).toBe('eng-4');
    jest.useRealTimers();
  });
});

describe('checkEngagementEntity — error paths', () => {
  test('returns ok=false reason=no-token when token missing', async () => {
    const r = await checkEngagementEntity(null);
    expect(r).toEqual({ ok: false, reason: 'no-token' });
  });

  test('returns no-resource-url when env not set', async () => {
    const { getConfig } = require('../../src/config/loader');
    getConfig.mockImplementation(async () => null);
    const r = await checkEngagementEntity('tok');
    expect(r).toEqual({ ok: false, reason: 'no-resource-url' });
  });

  test('returns ok=true on 200', async () => {
    axios.get.mockResolvedValueOnce({ data: {} });
    const r = await checkEngagementEntity('tok');
    expect(r.ok).toBe(true);
    expect(r.logicalName).toBe(DEFAULT_ENTITY_LOGICAL);
  });

  test('returns entity-missing on 404', async () => {
    axios.get.mockRejectedValueOnce({ response: { status: 404 } });
    const r = await checkEngagementEntity('tok');
    expect(r.reason).toBe('entity-missing');
  });

  test('returns check-failed on other errors', async () => {
    axios.get.mockRejectedValueOnce(new Error('connection-reset'));
    const r = await checkEngagementEntity('tok');
    expect(r.reason).toBe('check-failed');
  });

  test('uses configured entity-logical override', async () => {
    const { getConfig } = require('../../src/config/loader');
    getConfig.mockImplementation(async (k) => {
      if (k === 'DYNAMICS_RESOURCE_URL') return 'https://t.crm';
      if (k === 'DYNAMICS_ENGAGEMENT_ENTITY_LOGICAL') return 'custom_entity';
      return null;
    });
    axios.get.mockResolvedValueOnce({ data: {} });
    const r = await checkEngagementEntity('tok');
    expect(r.logicalName).toBe('custom_entity');
  });
});

describe('writeEngagementActivity — entity set override', () => {
  test('uses configured DYNAMICS_ENGAGEMENT_ENTITY_SET when present', async () => {
    const { getConfig } = require('../../src/config/loader');
    getConfig.mockImplementation(async (k) => {
      if (k === 'DYNAMICS_RESOURCE_URL') return 'https://t.crm';
      if (k === 'DYNAMICS_ENGAGEMENT_ENTITY_SET') return 'custom_set';
      return null;
    });
    axios.post.mockResolvedValueOnce({ data: { activityid: 'e' }, headers: {} });
    await writeEngagementActivity({
      activity: { id: 1, activityTypeId: 1 }, contactId: 'c1', token: 't',
    });
    expect(axios.post.mock.calls[0][0]).toContain('/custom_set');
  });
});

describe('writeEngagementActivity happy path', () => {
  test('POSTs to /ubt_marketingengagementactivities with dedicated fields + subject + regarding binding', async () => {
    axios.post.mockResolvedValueOnce({
      data: { activityid: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' },
      headers: {},
    });

    const activity = {
      id: 999, activityTypeId: 10,
      primaryAttributeValue: 'Spring Newsletter',
      activityDate: '2026-04-18T11:22:33Z',
      attributes: [
        { name: 'Campaign Name', value: 'Spring 2026' },
        { name: 'Subject Line',  value: 'Hello' },
      ],
    };

    const out = await writeEngagementActivity({
      activity,
      contactId: '11111111-1111-1111-1111-111111111111',
      token: 'tok',
    });

    expect(out.activityId).toBe('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');

    expect(axios.post).toHaveBeenCalledTimes(1);
    const [url, body, opts] = axios.post.mock.calls[0];
    expect(url).toBe(`https://t.crm.dynamics.com/api/data/v9.2/${DEFAULT_ENTITY_SET}`);
    // Subject still composed exactly as before.
    expect(body.subject).toBe('[Marketo: Email Open] Spring Newsletter');
    // Spec-defined dedicated fields.
    expect(body.ubt_engagementtype).toBe(TYPE_TO_OPTION[10]);
    expect(body.ubt_engagementdate).toBe('2026-04-18T11:22:33Z');
    expect(body.ubt_assetname).toBe('Spring Newsletter');
    expect(body.ubt_campaignname).toBe('Spring 2026');
    expect(body.ubt_sourcesystem).toBe('Marketo');
    expect(body.ubt_externalactivityid).toBe('999');
    // N:1 regarding binding carries over from the task-based writer.
    expect(body['regardingobjectid_contact@odata.bind']).toBe('/contacts(11111111-1111-1111-1111-111111111111)');
    // OOTB writers never emit a task-shaped URL any more.
    expect(url).not.toMatch(/\/tasks(\b|$)/);
    // Headers unchanged.
    expect(opts.headers.Authorization).toBe('Bearer tok');
    expect(opts.headers['OData-Version']).toBe('4.0');
    expect(opts.headers.Prefer).toBe('return=representation');
  });

  test('populates ubt_url from Link/Webpage URL attributes for web visits and clicks', () => {
    const body = _buildEngagementBody({
      activity: {
        id: 2, activityTypeId: 9, primaryAttributeValue: 'Pricing email',
        attributes: [{ name: 'Link', value: 'https://example.com/pricing' }],
      },
      contactId: 'cid',
    });
    expect(body.ubt_url).toBe('https://example.com/pricing');
    expect(body.ubt_engagementtype).toBe(TYPE_TO_OPTION[9]);
  });

  test('populates ubt_campaignstatus from New Status / Success / Reason (priority order)', () => {
    const base = (attrs) => _buildEngagementBody({
      activity: { id: 1, activityTypeId: 14, primaryAttributeValue: 'X', attributes: attrs },
      contactId: 'cid',
    });
    expect(base([{ name: 'New Status', value: 'Registered' }]).ubt_campaignstatus).toBe('Registered');
    expect(base([{ name: 'Success',    value: 'true' }]).ubt_campaignstatus).toBe('true');
    // New Status wins over Success when both are present.
    expect(base([
      { name: 'Success',    value: 'true' },
      { name: 'New Status', value: 'Attended' },
    ]).ubt_campaignstatus).toBe('Attended');
  });

  test('uses DYNAMICS_ENGAGEMENT_ENTITY_SET override when set in admin_config', async () => {
    const { getConfig } = require('../../src/config/loader');
    getConfig.mockImplementation(async (k) => {
      if (k === 'DYNAMICS_RESOURCE_URL') return 'https://t.crm.dynamics.com';
      if (k === 'DYNAMICS_API_VERSION')  return '9.2';
      if (k === 'DYNAMICS_ENGAGEMENT_ENTITY_SET') return 'my_customengagements';
      return null;
    });
    axios.post.mockResolvedValueOnce({ data: { activityid: 'x' }, headers: {} });
    await writeEngagementActivity({
      activity: { id: 1, activityTypeId: 7, primaryAttributeValue: 'Y', attributes: [] },
      contactId: 'cid',
      token: 'tok',
    });
    const [url] = axios.post.mock.calls[0];
    expect(url).toBe('https://t.crm.dynamics.com/api/data/v9.2/my_customengagements');
  });

  test('falls back to OData-EntityId header when body has no activityid', async () => {
    axios.post.mockResolvedValueOnce({
      data: {},
      headers: {
        'odata-entityid':
          `https://t.crm.dynamics.com/api/data/v9.2/${DEFAULT_ENTITY_SET}(bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb)`,
      },
    });
    const out = await writeEngagementActivity({
      activity: { id: 1, activityTypeId: 7, primaryAttributeValue: 'X', attributes: [] },
      contactId: '22222222-2222-2222-2222-222222222222',
      token: 'tok',
    });
    expect(out.activityId).toBe('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
  });
});

describe('writeEngagementActivity error handling', () => {
  test('unwraps axios 400 into a useful message', async () => {
    axios.post.mockRejectedValueOnce(Object.assign(new Error('Request failed'), {
      response: {
        status: 400, headers: {},
        data: { error: { message: 'A required field is missing.' } },
      },
    }));

    await expect(writeEngagementActivity({
      activity: { id: 1, activityTypeId: 7, primaryAttributeValue: 'X', attributes: [] },
      contactId: '22222222-2222-2222-2222-222222222222',
      token: 'tok',
    })).rejects.toThrow(/HTTP 400.*A required field/);
  });

  test('rejects with a clear message when contactId is missing', async () => {
    await expect(writeEngagementActivity({
      activity: { id: 1, activityTypeId: 7, attributes: [] },
      token: 'tok',
    })).rejects.toThrow(/contactId is required/);
    expect(axios.post).not.toHaveBeenCalled();
  });
});

describe('TYPE_LABELS / TYPE_TO_OPTION / _buildEngagementBody', () => {
  test('all 6 activity-type ids have a label', () => {
    for (const id of [1, 2, 7, 9, 10, 14]) {
      expect(typeof TYPE_LABELS[id]).toBe('string');
    }
  });

  test('all 6 activity-type ids map to a stable option-set value', () => {
    for (const id of [1, 2, 7, 9, 10, 14]) {
      expect(typeof TYPE_TO_OPTION[id]).toBe('number');
      // UBT convention — custom option-set values live in the 900000000+ space.
      expect(TYPE_TO_OPTION[id]).toBeGreaterThanOrEqual(900000000);
    }
  });

  test('option values are unique per type id', () => {
    const vals = [1, 2, 7, 9, 10, 14].map(id => TYPE_TO_OPTION[id]);
    expect(new Set(vals).size).toBe(vals.length);
  });

  test('_buildEngagementBody composes subject from label + asset, with fallback "(no asset)"', () => {
    const body = _buildEngagementBody({
      activity: { activityTypeId: 1, attributes: [], activityDate: 'd' },
      contactId: 'cid',
    });
    expect(body.subject).toBe('[Marketo: Web Visit] (no asset)');
    expect(body['regardingobjectid_contact@odata.bind']).toBe('/contacts(cid)');
    expect(body.ubt_sourcesystem).toBe('Marketo');
  });
});

describe('checkEngagementEntity boot check', () => {
  test('returns { ok: true } when EntityDefinitions returns 200', async () => {
    axios.get.mockResolvedValueOnce({ data: { LogicalName: DEFAULT_ENTITY_LOGICAL } });
    const out = await checkEngagementEntity('tok');
    expect(out.ok).toBe(true);
    expect(out.logicalName).toBe(DEFAULT_ENTITY_LOGICAL);
    const [url] = axios.get.mock.calls[0];
    expect(url).toBe(
      `https://t.crm.dynamics.com/api/data/v9.2/EntityDefinitions(LogicalName='${DEFAULT_ENTITY_LOGICAL}')?$select=LogicalName`,
    );
  });

  test('returns { ok: false, reason: "entity-missing" } when 404', async () => {
    axios.get.mockRejectedValueOnce(Object.assign(new Error('not found'), {
      response: { status: 404, headers: {}, data: {} },
    }));
    const out = await checkEngagementEntity('tok');
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('entity-missing');
    expect(out.logicalName).toBe(DEFAULT_ENTITY_LOGICAL);
  });

  test('returns { ok: false, reason: "no-token" } when token missing', async () => {
    const out = await checkEngagementEntity(null);
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('no-token');
    expect(axios.get).not.toHaveBeenCalled();
  });

  test('swallows non-404 errors and returns { ok: false, reason: "check-failed" }', async () => {
    axios.get.mockRejectedValueOnce(Object.assign(new Error('boom'), {
      response: { status: 500, headers: {}, data: {} },
    }));
    const out = await checkEngagementEntity('tok');
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('check-failed');
  });
});
