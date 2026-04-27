'use strict';

/**
 * Unit tests for src/engagement/marketoActivities.js — wraps Marketo's
 * /pagingtoken, /activities and /leads endpoints.
 *
 * Same testing style as tests/unit/marketoLists.test.js — mock axios.request,
 * mock the config loader so MARKETO_BASE_URL resolves without DB access.
 */

jest.mock('axios', () => ({ request: jest.fn() }));
jest.mock('../../src/audit/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(),
}));
jest.mock('../../src/config/loader', () => ({
  getConfig: jest.fn(async (k) => (k === 'MARKETO_BASE_URL' ? 'https://test.mktorest.com' : null)),
}));

const axios = require('axios');
const {
  getPagingToken,
  getActivityTypes,
  fetchActivities,
  fetchLeadEmails,
} = require('../../src/engagement/marketoActivities');

function make429(retryAfterSecs = 0) {
  return Object.assign(new Error('Too Many Requests'), {
    response: { status: 429, headers: { 'retry-after': String(retryAfterSecs) } },
  });
}

beforeEach(() => { jest.clearAllMocks(); });

describe('getPagingToken', () => {
  test('POSTs to pagingtoken.json with sinceDatetime + returns nextPageToken', async () => {
    axios.request.mockResolvedValueOnce({
      data: { success: true, nextPageToken: 'TOKEN-123' },
    });

    const out = await getPagingToken('2026-04-18T00:00:00.000Z', 'tok');

    expect(out).toEqual({ nextPageToken: 'TOKEN-123' });
    expect(axios.request).toHaveBeenCalledTimes(1);
    const cfg = axios.request.mock.calls[0][0];
    expect(cfg.method).toBe('GET');
    expect(cfg.url).toContain('/rest/v1/activities/pagingtoken.json?sinceDatetime=');
    expect(cfg.url).toContain(encodeURIComponent('2026-04-18T00:00:00.000Z'));
    expect(cfg.headers.Authorization).toBe('Bearer tok');
  });

  test('throws when success is false', async () => {
    axios.request.mockResolvedValueOnce({
      data: { success: false, errors: [{ code: '601', message: 'Bad' }] },
    });
    await expect(getPagingToken('2026-04-18T00:00:00Z', 'tok'))
      .rejects.toThrow(/getPagingToken failed/);
  });
});

describe('fetchActivities', () => {
  test('happy path: returns shape { success, result, nextPageToken, moreResult }', async () => {
    axios.request.mockResolvedValueOnce({
      data: {
        success: true,
        result: [{ id: 1, activityTypeId: 7, leadId: 100, primaryAttributeValue: 'Email A' }],
        nextPageToken: 'NEXT-1',
        moreResult: false,
      },
    });

    const out = await fetchActivities({
      nextPageToken:   'TOKEN-123',
      activityTypeIds: [7, 10, 9],
      token:           'tok',
    });

    expect(out.success).toBe(true);
    expect(out.result).toHaveLength(1);
    expect(out.nextPageToken).toBe('NEXT-1');
    expect(out.moreResult).toBe(false);
    const cfg = axios.request.mock.calls[0][0];
    expect(cfg.method).toBe('GET');
    expect(cfg.url).toContain('/rest/v1/activities.json?nextPageToken=');
    expect(cfg.url).toContain('activityTypeIds=');
    expect(decodeURIComponent(cfg.url.split('activityTypeIds=')[1])).toBe('7,10,9');
  });

  test('paging continuation: caller can re-call with returned nextPageToken until moreResult=false', async () => {
    axios.request
      .mockResolvedValueOnce({ data: { success: true, result: [{ id: 1 }], nextPageToken: 'P2', moreResult: true } })
      .mockResolvedValueOnce({ data: { success: true, result: [{ id: 2 }], nextPageToken: 'P3', moreResult: false } });

    const p1 = await fetchActivities({ nextPageToken: 'P1', activityTypeIds: [7], token: 'tok' });
    expect(p1.moreResult).toBe(true);
    expect(p1.nextPageToken).toBe('P2');

    const p2 = await fetchActivities({ nextPageToken: p1.nextPageToken, activityTypeIds: [7], token: 'tok' });
    expect(p2.moreResult).toBe(false);
    expect(p2.result[0].id).toBe(2);

    expect(axios.request).toHaveBeenCalledTimes(2);
    expect(axios.request.mock.calls[1][0].url).toContain('nextPageToken=P2');
  });

  test('throws when nextPageToken is missing', async () => {
    await expect(fetchActivities({ activityTypeIds: [7], token: 'tok' }))
      .rejects.toThrow(/nextPageToken required/);
  });
});

describe('fetchLeadEmails', () => {
  test('returns [] without HTTP when leadIds is empty', async () => {
    const out = await fetchLeadEmails([], 'tok');
    expect(out).toEqual([]);
    expect(axios.request).not.toHaveBeenCalled();
  });

  test('batches leadIds into chunks of 300 and concatenates results', async () => {
    const ids = Array.from({ length: 650 }, (_, i) => i + 1);
    axios.request.mockResolvedValue({
      data: { success: true, result: [{ id: 999, email: 'x@y' }] },
    });

    const out = await fetchLeadEmails(ids, 'tok');

    expect(axios.request).toHaveBeenCalledTimes(3); // 300 + 300 + 50
    expect(out).toHaveLength(3);
    // Spot-check one of the URLs to ensure filterValues uses comma-separated ids
    const firstUrl = axios.request.mock.calls[0][0].url;
    expect(firstUrl).toContain('/rest/v1/leads.json?filterType=id&filterValues=');
    expect(firstUrl).toContain('fields=id,email,firstName,lastName');
  });

  test('throws when Marketo returns success:false', async () => {
    axios.request.mockResolvedValueOnce({
      data: { success: false, errors: [{ code: '1003', message: 'Bad' }] },
    });
    await expect(fetchLeadEmails([1, 2, 3], 'tok'))
      .rejects.toThrow(/fetchLeadEmails failed/);
  });
});

describe('callMarketo cross-cutting: 429 backoff', () => {
  test('retries on 429 then succeeds', async () => {
    jest.useFakeTimers();
    try {
      axios.request
        .mockRejectedValueOnce(make429(0))
        .mockResolvedValueOnce({ data: { success: true, nextPageToken: 'OK' } });

      const p = getPagingToken('2026-04-18T00:00:00Z', 'tok');
      p.catch(() => {});
      await jest.runAllTimersAsync();
      const out = await p;

      expect(out).toEqual({ nextPageToken: 'OK' });
      expect(axios.request).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  test('unwrapAxiosError surfaces errors array detail', async () => {
    axios.request.mockRejectedValueOnce({
      response: { status: 401, data: { errors: [{ code: '601', message: 'Token invalid' }] } },
    });
    await expect(getPagingToken('2026-01-01T00:00Z', 'tok'))
      .rejects.toThrow(/HTTP 401: 601:Token invalid/);
  });

  test('unwrapAxiosError surfaces data.message detail', async () => {
    axios.request.mockRejectedValueOnce({
      response: { status: 500, data: { message: 'server-died' } },
    });
    await expect(getPagingToken('2026-01-01T00:00Z', 'tok'))
      .rejects.toThrow(/HTTP 500: server-died/);
  });

  test('unwrapAxiosError surfaces string body', async () => {
    axios.request.mockRejectedValueOnce({
      response: { status: 502, data: 'Bad gateway' },
    });
    await expect(getPagingToken('2026-01-01T00:00Z', 'tok'))
      .rejects.toThrow(/HTTP 502: Bad gateway/);
  });

  test('unwrapAxiosError handles null body', async () => {
    axios.request.mockRejectedValueOnce({
      response: { status: 503, data: null },
    });
    await expect(getPagingToken('2026-01-01T00:00Z', 'tok'))
      .rejects.toThrow(/HTTP 503/);
  });

  test('throws when MARKETO_BASE_URL not set', async () => {
    const { getConfig } = require('../../src/config/loader');
    getConfig.mockResolvedValueOnce(null);
    await expect(getPagingToken('2026-01-01T00:00Z', 'tok'))
      .rejects.toThrow('MARKETO_BASE_URL');
  });

  test('parseRetryAfter falls back to default on non-numeric header', async () => {
    jest.useFakeTimers();
    try {
      axios.request
        .mockRejectedValueOnce({ response: { status: 429, headers: { 'retry-after': 'abc' } } })
        .mockResolvedValueOnce({ data: { success: true, nextPageToken: 'OK' } });
      const p = getPagingToken('2026-01-01T00:00Z', 'tok');
      p.catch(() => {});
      await jest.runAllTimersAsync();
      await p;
      expect(axios.request).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('fetchActivities — input validation', () => {
  test('throws when activityTypeIds missing/empty', async () => {
    await expect(fetchActivities({ nextPageToken: 't', activityTypeIds: [], token: 'tok' }))
      .rejects.toThrow(/activityTypeIds/);
    await expect(fetchActivities({ nextPageToken: 't', token: 'tok' }))
      .rejects.toThrow(/activityTypeIds/);
  });

  test('returns nextPageToken from response or fallback', async () => {
    axios.request.mockResolvedValueOnce({
      data: { success: true, result: [], moreResult: false },
    });
    const r = await fetchActivities({ nextPageToken: 'orig', activityTypeIds: [1], token: 'tok' });
    expect(r.nextPageToken).toBe('orig');
  });
});

describe('getActivityTypes', () => {
  test('returns the result array', async () => {
    axios.request.mockResolvedValueOnce({
      data: { success: true, result: [{ id: 1, name: 'Web Visit' }] },
    });
    const out = await getActivityTypes('tok');
    expect(out).toEqual([{ id: 1, name: 'Web Visit' }]);
  });

  test('returns [] when result is missing', async () => {
    axios.request.mockResolvedValueOnce({ data: { success: true } });
    const out = await getActivityTypes('tok');
    expect(out).toEqual([]);
  });

  test('throws when Marketo returns success=false', async () => {
    axios.request.mockResolvedValueOnce({
      data: { success: false, errors: [{ code: '601', message: 'auth' }] },
    });
    await expect(getActivityTypes('tok')).rejects.toThrow(/getActivityTypes failed/);
  });
});
