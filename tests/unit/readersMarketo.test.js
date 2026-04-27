'use strict';

jest.mock('axios', () => ({ post: jest.fn(), get: jest.fn() }));
jest.mock('../../src/config/loader', () => ({ getConfig: jest.fn() }));
jest.mock('../../src/auth/marketo', () => ({ getMarketoToken: jest.fn() }));

const axios = require('axios');
const { getConfig } = require('../../src/config/loader');
const { getMarketoToken } = require('../../src/auth/marketo');
const { readMarketo } = require('../../src/readers/marketo');

beforeEach(() => {
  jest.clearAllMocks();
  // Avoid real timers slowing down bulk-export polling tests.
  jest.useFakeTimers();
  jest.spyOn(global, 'setTimeout').mockImplementation((cb) => {
    if (typeof cb === 'function') cb();
    return 0;
  });
  getMarketoToken.mockResolvedValue('mkto-tok');
});

afterEach(() => {
  global.setTimeout.mockRestore?.();
  jest.useRealTimers();
});

function configMap(map) {
  getConfig.mockImplementation((k) => Promise.resolve(map[k] ?? null));
}

describe('readMarketo — config gates', () => {
  it('throws when MARKETO_BASE_URL is missing', async () => {
    configMap({});
    await expect(readMarketo({ entity: 'lead' })).rejects.toThrow('MARKETO_BASE_URL');
  });

  it('returns informational note when MARKETO_DEMO_LIST_ID missing', async () => {
    configMap({ MARKETO_BASE_URL: 'https://m' });
    const r = await readMarketo({ entity: 'lead' });
    expect(r.rows).toEqual([]);
    expect(r.nextCursor).toBeNull();
    expect(r.note).toMatch(/No demo list/);
  });
});

describe('readMarketo — static-list happy path (lead)', () => {
  it('fetches a page with batchSize and field selection, returns rows + nextCursor', async () => {
    configMap({ MARKETO_BASE_URL: 'https://m', MARKETO_DEMO_LIST_ID: '123' });
    axios.get.mockResolvedValueOnce({
      data: {
        success: true,
        result: [{ id: 1, email: 'a@b.com' }],
        moreResult: true,
        nextPageToken: 'tok-2',
      },
    });

    const r = await readMarketo({ entity: 'lead', limit: 20 });
    expect(r.rows).toEqual([{ id: 1, email: 'a@b.com' }]);
    expect(r.nextCursor).toBe('tok-2');
    const [url, opts] = axios.get.mock.calls[0];
    expect(url).toContain('/rest/v1/list/123/leads.json');
    expect(opts.params.batchSize).toBe('20');
    expect(opts.headers.Authorization).toBe('Bearer mkto-tok');
  });

  it('passes nextPageToken when given a non-numeric cursor', async () => {
    configMap({ MARKETO_BASE_URL: 'https://m', MARKETO_DEMO_LIST_ID: '123' });
    axios.get.mockResolvedValueOnce({ data: { success: true, result: [], moreResult: false } });

    await readMarketo({ entity: 'lead', cursor: 'abc-tok' });
    expect(axios.get.mock.calls[0][1].params.nextPageToken).toBe('abc-tok');
  });

  it('omits nextPageToken when cursor is numeric (offset for bulk)', async () => {
    configMap({ MARKETO_BASE_URL: 'https://m', MARKETO_DEMO_LIST_ID: '123' });
    axios.get.mockResolvedValueOnce({ data: { success: true, result: [], moreResult: false } });

    await readMarketo({ entity: 'lead', cursor: '50' });
    expect(axios.get.mock.calls[0][1].params.nextPageToken).toBeUndefined();
  });

  it('returns nextCursor=null when moreResult=false', async () => {
    configMap({ MARKETO_BASE_URL: 'https://m', MARKETO_DEMO_LIST_ID: '123' });
    axios.get.mockResolvedValueOnce({ data: { success: true, result: [{ id: 1 }], moreResult: false } });

    const r = await readMarketo({ entity: 'lead' });
    expect(r.nextCursor).toBeNull();
  });

  it('throws on non-1013 list error', async () => {
    configMap({ MARKETO_BASE_URL: 'https://m', MARKETO_DEMO_LIST_ID: '123' });
    axios.get.mockResolvedValueOnce({
      data: { success: false, errors: [{ code: '500', message: 'bad' }] },
    });
    await expect(readMarketo({ entity: 'lead' })).rejects.toThrow(/list read failed/);
  });
});

describe('readMarketo — smart-list bulk fallback', () => {
  function mockBulkSuccess(leads = [], headerSpec = 'id,Email Address,First Name,Company Name') {
    // create.json
    axios.post.mockResolvedValueOnce({ data: { success: true, result: [{ exportId: 'EX1' }] } });
    // enqueue.json
    axios.post.mockResolvedValueOnce({ data: { success: true } });
    // status poll → Completed
    axios.get.mockResolvedValueOnce({ data: { success: true, result: [{ status: 'Completed' }] } });
    // file.json (CSV)
    const headers = headerSpec.split(',');
    const apiKeys = ['id','email','firstName','company'];
    const rows = leads.map(l => apiKeys.map(k => l[k] ?? '').join(','));
    const csv = [headers.join(','), ...rows].join('\n');
    axios.get.mockResolvedValueOnce({ data: csv });
  }

  it('falls back to bulk when 1013 (smart list)', async () => {
    configMap({ MARKETO_BASE_URL: 'https://m', MARKETO_DEMO_LIST_ID: '999' });
    // Static-list call → 1013 not found
    axios.get.mockResolvedValueOnce({
      data: { success: false, errors: [{ code: '1013', message: 'not found' }] },
    });
    mockBulkSuccess([
      { id: 1, email: 'a@b.com', firstName: 'A', company: 'X' },
      { id: 2, email: 'c@d.com', firstName: 'C', company: 'Y' },
    ]);

    const r = await readMarketo({ entity: 'lead', limit: 1 });
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].email).toBe('a@b.com');
    expect(r.nextCursor).toBe('1');
  });

  it('paginates the bulk results via numeric cursor', async () => {
    configMap({ MARKETO_BASE_URL: 'https://m', MARKETO_DEMO_LIST_ID: '999' });
    axios.get.mockResolvedValueOnce({
      data: { success: false, errors: [{ code: '1013' }] },
    });
    mockBulkSuccess([
      { id: 1, email: 'a@b.com' },
      { id: 2, email: 'b@b.com' },
    ]);

    const r = await readMarketo({ entity: 'lead', limit: 5, cursor: '1' });
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].email).toBe('b@b.com');
    expect(r.nextCursor).toBeNull();
  });

  it('throws when bulk export create fails', async () => {
    configMap({ MARKETO_BASE_URL: 'https://m', MARKETO_DEMO_LIST_ID: '999' });
    axios.get.mockResolvedValueOnce({ data: { success: false, errors: [{ code: '1013' }] } });
    axios.post.mockResolvedValueOnce({ data: { success: false, errors: [{ code: 'X' }] } });

    await expect(readMarketo({ entity: 'lead' })).rejects.toThrow(/export create failed/);
  });

  it('throws on Failed export status', async () => {
    configMap({ MARKETO_BASE_URL: 'https://m', MARKETO_DEMO_LIST_ID: '999' });
    axios.get.mockResolvedValueOnce({ data: { success: false, errors: [{ code: '1013' }] } });
    axios.post.mockResolvedValueOnce({ data: { success: true, result: [{ exportId: 'EX' }] } });
    axios.post.mockResolvedValueOnce({ data: { success: true } });
    axios.get.mockResolvedValueOnce({
      data: { success: true, result: [{ status: 'Failed' }] },
    });
    await expect(readMarketo({ entity: 'lead' })).rejects.toThrow(/bulk export failed/);
  });

  it('throws on Cancelled export status', async () => {
    configMap({ MARKETO_BASE_URL: 'https://m', MARKETO_DEMO_LIST_ID: '999' });
    axios.get.mockResolvedValueOnce({ data: { success: false, errors: [{ code: '1013' }] } });
    axios.post.mockResolvedValueOnce({ data: { success: true, result: [{ exportId: 'EX' }] } });
    axios.post.mockResolvedValueOnce({ data: { success: true } });
    axios.get.mockResolvedValueOnce({
      data: { success: true, result: [{ status: 'Cancelled' }] },
    });
    await expect(readMarketo({ entity: 'lead' })).rejects.toThrow(/bulk export cancelled/);
  });

  it('keeps polling on transient unsuccessful status responses, then completes', async () => {
    configMap({ MARKETO_BASE_URL: 'https://m', MARKETO_DEMO_LIST_ID: '999' });
    axios.get.mockResolvedValueOnce({ data: { success: false, errors: [{ code: '1013' }] } });
    axios.post.mockResolvedValueOnce({ data: { success: true, result: [{ exportId: 'EX' }] } });
    axios.post.mockResolvedValueOnce({ data: { success: true } });
    // First poll: success=false (continue), second: completed
    axios.get.mockResolvedValueOnce({ data: { success: false } });
    axios.get.mockResolvedValueOnce({ data: { success: true, result: [{ status: 'Queued' }] } });
    axios.get.mockResolvedValueOnce({ data: { success: true, result: [{ status: 'Completed' }] } });
    axios.get.mockResolvedValueOnce({ data: 'id\n1' });

    const r = await readMarketo({ entity: 'lead' });
    expect(r.rows).toHaveLength(1);
  });

  it('throws on poll timeout (20 attempts without completion)', async () => {
    configMap({ MARKETO_BASE_URL: 'https://m', MARKETO_DEMO_LIST_ID: '999' });
    axios.get.mockResolvedValueOnce({ data: { success: false, errors: [{ code: '1013' }] } });
    axios.post.mockResolvedValueOnce({ data: { success: true, result: [{ exportId: 'EX' }] } });
    axios.post.mockResolvedValueOnce({ data: { success: true } });
    // Always Queued → never completes
    axios.get.mockResolvedValue({ data: { success: true, result: [{ status: 'Queued' }] } });

    await expect(readMarketo({ entity: 'lead' })).rejects.toThrow(/timed out/);
  });
});

describe('readMarketo — account derivation', () => {
  it('derives accounts from leads (unique by company)', async () => {
    configMap({ MARKETO_BASE_URL: 'https://m', MARKETO_DEMO_LIST_ID: '999' });
    axios.post.mockResolvedValueOnce({ data: { success: true, result: [{ exportId: 'EX' }] } });
    axios.post.mockResolvedValueOnce({ data: { success: true } });
    axios.get.mockResolvedValueOnce({ data: { success: true, result: [{ status: 'Completed' }] } });
    axios.get.mockResolvedValueOnce({
      data: 'id,Email Address,Company Name,City\n1,a@b.com,Acme,Auckland\n2,c@d.com,Acme,Wellington\n3,e@f.com,,X\n4,g@h.com,null,Y\n5,i@j.com,Beta,Z',
    });

    const r = await readMarketo({ entity: 'account', limit: 10 });
    expect(r.rows).toHaveLength(2);
    expect(r.rows.map(x => x.name).sort()).toEqual(['Acme', 'Beta']);
    expect(r.nextCursor).toBeNull();
  });

  it('paginates derived accounts when more than limit', async () => {
    configMap({ MARKETO_BASE_URL: 'https://m', MARKETO_DEMO_LIST_ID: '999' });
    axios.post.mockResolvedValueOnce({ data: { success: true, result: [{ exportId: 'EX' }] } });
    axios.post.mockResolvedValueOnce({ data: { success: true } });
    axios.get.mockResolvedValueOnce({ data: { success: true, result: [{ status: 'Completed' }] } });
    axios.get.mockResolvedValueOnce({
      data: 'id,Email Address,Company Name\n1,a@b.com,A\n2,c@d.com,B\n3,e@f.com,C',
    });

    const r = await readMarketo({ entity: 'account', limit: 2, cursor: '1' });
    expect(r.rows).toHaveLength(2);
    expect(r.nextCursor).toBeNull();
  });
});

describe('readMarketo — CSV parser edges', () => {
  it('handles quoted fields and "null" literal', async () => {
    configMap({ MARKETO_BASE_URL: 'https://m', MARKETO_DEMO_LIST_ID: '999' });
    axios.get.mockResolvedValueOnce({ data: { success: false, errors: [{ code: '1013' }] } });
    axios.post.mockResolvedValueOnce({ data: { success: true, result: [{ exportId: 'EX' }] } });
    axios.post.mockResolvedValueOnce({ data: { success: true } });
    axios.get.mockResolvedValueOnce({ data: { success: true, result: [{ status: 'Completed' }] } });
    axios.get.mockResolvedValueOnce({
      data: 'id,First Name,Company Name\n1,"Jane, Q.",null',
    });

    const r = await readMarketo({ entity: 'lead' });
    expect(r.rows[0].firstName).toBe('Jane, Q.');
    expect(r.rows[0].company).toBe('');
  });

  it('returns empty when CSV has fewer than 2 lines', async () => {
    configMap({ MARKETO_BASE_URL: 'https://m', MARKETO_DEMO_LIST_ID: '999' });
    axios.get.mockResolvedValueOnce({ data: { success: false, errors: [{ code: '1013' }] } });
    axios.post.mockResolvedValueOnce({ data: { success: true, result: [{ exportId: 'EX' }] } });
    axios.post.mockResolvedValueOnce({ data: { success: true } });
    axios.get.mockResolvedValueOnce({ data: { success: true, result: [{ status: 'Completed' }] } });
    axios.get.mockResolvedValueOnce({ data: 'id' });

    const r = await readMarketo({ entity: 'lead' });
    expect(r.rows).toEqual([]);
  });

  it('preserves unknown header names verbatim', async () => {
    configMap({ MARKETO_BASE_URL: 'https://m', MARKETO_DEMO_LIST_ID: '999' });
    axios.get.mockResolvedValueOnce({ data: { success: false, errors: [{ code: '1013' }] } });
    axios.post.mockResolvedValueOnce({ data: { success: true, result: [{ exportId: 'EX' }] } });
    axios.post.mockResolvedValueOnce({ data: { success: true } });
    axios.get.mockResolvedValueOnce({ data: { success: true, result: [{ status: 'Completed' }] } });
    axios.get.mockResolvedValueOnce({ data: 'CustomCol\nval' });

    const r = await readMarketo({ entity: 'lead' });
    expect(r.rows[0].CustomCol).toBe('val');
  });
});
