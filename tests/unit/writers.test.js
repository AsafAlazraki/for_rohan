'use strict';

jest.mock('axios', () => ({ post: jest.fn(), patch: jest.fn() }));
jest.mock('../../src/audit/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(),
}));

const axios = require('axios');

// ─────────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────────
function make429(retryAfterSecs = 0) {
  return Object.assign(new Error('Too Many Requests'), {
    response: { status: 429, headers: { 'retry-after': String(retryAfterSecs) } },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// writeToMarketo
// ─────────────────────────────────────────────────────────────────────────────
describe('writeToMarketo()', () => {
  let writeToMarketo;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    process.env.MARKETO_BASE_URL = 'https://test.mktorest.com';
    // fresh module so internal retry counter resets
    jest.resetModules();
    jest.mock('axios', () => ({ post: jest.fn(), patch: jest.fn() }));
    jest.mock('../../src/audit/logger', () => ({
      info: jest.fn(), warn: jest.fn(), error: jest.fn(),
    }));
    ({ writeToMarketo } = require('../../src/writers/marketo'));
  });

  afterEach(() => {
    jest.useRealTimers();
    delete process.env.MARKETO_BASE_URL;
  });

  it('POSTs to /rest/v1/leads/push.json and returns targetId + status', async () => {
    const ax = require('axios');
    ax.post.mockResolvedValueOnce({
      data: { success: true, result: [{ id: 42, status: 'created' }] },
    });

    const result = await writeToMarketo({ email: 'a@b.com', firstName: 'A' }, 'tok');

    expect(ax.post).toHaveBeenCalledTimes(1);
    const [url, body, cfg] = ax.post.mock.calls[0];
    expect(url).toContain('/rest/v1/leads.json');
    expect(body).toMatchObject({ action: 'createOrUpdate', lookupField: 'email' });
    expect(cfg.headers.Authorization).toBe('Bearer tok');
    expect(result).toEqual({ targetId: '42', status: 'created' });
  });

  it('throws when success=false', async () => {
    const ax = require('axios');
    ax.post.mockResolvedValueOnce({
      data: { success: false, errors: [{ code: '1001', message: 'Partition error' }] },
    });
    await expect(writeToMarketo({ email: 'a@b.com' }, 'tok')).rejects.toThrow('Push failed');
  });

  it('retries on 429 and returns the successful result', async () => {
    const ax = require('axios');
    ax.post
      .mockRejectedValueOnce(make429(0))
      .mockResolvedValueOnce({
        data: { success: true, result: [{ id: 5, status: 'updated' }] },
      });

    const promise = writeToMarketo({ email: 'a@b.com' }, 'tok');
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(ax.post).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ targetId: '5', status: 'updated' });
  });

  it('throws after exceeding MAX_429_RETRIES', async () => {
    const ax = require('axios');
    ax.post.mockRejectedValue(make429(0));

    const promise = writeToMarketo({ email: 'a@b.com' }, 'tok');
    // Suppress "unhandled rejection" warning that fires while the loop is
    // running timers but before we attach the expect().rejects handler below.
    promise.catch(() => {});

    // Flush each retry's 0-ms sleep timer (1 original + up to 3 retries)
    for (let i = 0; i < 5; i++) await jest.runAllTimersAsync();

    await expect(promise).rejects.toMatchObject({ response: { status: 429 } });
    // 1 original + 3 retries = 4 calls max
    expect(ax.post.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it('does not retry on non-429 errors', async () => {
    const ax = require('axios');
    ax.post.mockRejectedValueOnce(
      Object.assign(new Error('500'), { response: { status: 500 } }),
    );
    await expect(writeToMarketo({ email: 'a@b.com' }, 'tok')).rejects.toThrow('500');
    expect(ax.post).toHaveBeenCalledTimes(1);
  });

  it('throws when MARKETO_BASE_URL is missing', async () => {
    delete process.env.MARKETO_BASE_URL;
    await expect(writeToMarketo({}, 'tok')).rejects.toThrow('MARKETO_BASE_URL');
  });

  it('throws when result is empty', async () => {
    const ax = require('axios');
    ax.post.mockResolvedValueOnce({ data: { success: true, result: [] } });
    await expect(writeToMarketo({ email: 'a@b.com' }, 'tok')).rejects.toThrow(/empty result/);
  });

  it('throws on per-record skipped status with reasons', async () => {
    const ax = require('axios');
    ax.post.mockResolvedValueOnce({
      data: { success: true, result: [{ status: 'skipped', reasons: [{ code: 1004, message: 'Not found' }] }] },
    });
    await expect(writeToMarketo({ email: 'a@b.com' }, 'tok'))
      .rejects.toThrow(/skipped: 1004:Not found/);
  });

  it('throws on per-record failed status without reasons', async () => {
    const ax = require('axios');
    ax.post.mockResolvedValueOnce({
      data: { success: true, result: [{ status: 'failed' }] },
    });
    await expect(writeToMarketo({ email: 'a@b.com' }, 'tok'))
      .rejects.toThrow(/failed: no reason given/);
  });

  it('returns targetId=null when result has no id', async () => {
    const ax = require('axios');
    ax.post.mockResolvedValueOnce({
      data: { success: true, result: [{ status: 'created' }] },
    });
    const r = await writeToMarketo({ email: 'a@b.com' }, 'tok');
    expect(r.targetId).toBeNull();
  });

  it('unwraps Axios error with errors array', async () => {
    const ax = require('axios');
    ax.post.mockRejectedValueOnce({
      response: { status: 401, data: { errors: [{ code: 601, message: 'Token invalid' }] } },
      isAxiosError: true,
    });
    await expect(writeToMarketo({ email: 'a@b.com' }, 'tok'))
      .rejects.toThrow(/HTTP 401: 601:Token invalid/);
  });

  it('unwraps Axios error with message field', async () => {
    const ax = require('axios');
    ax.post.mockRejectedValueOnce({
      response: { status: 500, data: { message: 'server boom' } },
    });
    await expect(writeToMarketo({ email: 'a@b.com' }, 'tok'))
      .rejects.toThrow(/HTTP 500: server boom/);
  });

  it('unwraps Axios error with string body', async () => {
    const ax = require('axios');
    ax.post.mockRejectedValueOnce({
      response: { status: 502, data: 'Bad gateway' },
    });
    await expect(writeToMarketo({ email: 'a@b.com' }, 'tok'))
      .rejects.toThrow(/HTTP 502: Bad gateway/);
  });

  it('unwraps Axios error with no useful body', async () => {
    const ax = require('axios');
    ax.post.mockRejectedValueOnce({
      response: { status: 503, data: null },
    });
    await expect(writeToMarketo({ email: 'a@b.com' }, 'tok'))
      .rejects.toThrow(/HTTP 503/);
  });
});

describe('writeMarketoCompany()', () => {
  let writeMarketoCompany;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    process.env.MARKETO_BASE_URL = 'https://test.mktorest.com';
    jest.resetModules();
    jest.mock('axios', () => ({ post: jest.fn(), patch: jest.fn() }));
    jest.mock('../../src/audit/logger', () => ({
      info: jest.fn(), warn: jest.fn(), error: jest.fn(),
    }));
    ({ writeMarketoCompany } = require('../../src/writers/marketo'));
  });

  afterEach(() => {
    jest.useRealTimers();
    delete process.env.MARKETO_BASE_URL;
  });

  it('POSTs to /companies/sync.json with createOrUpdate', async () => {
    const ax = require('axios');
    ax.post.mockResolvedValueOnce({
      data: { success: true, result: [{ id: 11, status: 'created' }] },
    });
    const r = await writeMarketoCompany({ company: 'Acme' }, 'tok');
    expect(ax.post.mock.calls[0][0]).toContain('/companies/sync.json');
    expect(r).toEqual({ targetId: '11', status: 'created' });
  });

  it('throws when success=false', async () => {
    const ax = require('axios');
    ax.post.mockResolvedValueOnce({ data: { success: false, errors: [{ code: 1, message: 'x' }] } });
    await expect(writeMarketoCompany({ company: 'A' }, 'tok')).rejects.toThrow(/Company push failed/);
  });

  it('throws on empty result', async () => {
    const ax = require('axios');
    ax.post.mockResolvedValueOnce({ data: { success: true, result: [] } });
    await expect(writeMarketoCompany({ company: 'A' }, 'tok')).rejects.toThrow(/empty result/);
  });

  it('throws on skipped/failed status', async () => {
    const ax = require('axios');
    ax.post.mockResolvedValueOnce({
      data: { success: true, result: [{ status: 'skipped', reasons: [{ code: 9, message: 'why' }] }] },
    });
    await expect(writeMarketoCompany({ company: 'A' }, 'tok')).rejects.toThrow(/Company skipped: 9:why/);
  });

  it('retries on 429', async () => {
    const ax = require('axios');
    ax.post
      .mockRejectedValueOnce(make429(0))
      .mockResolvedValueOnce({ data: { success: true, result: [{ id: 7, status: 'updated' }] } });
    const p = writeMarketoCompany({ company: 'A' }, 'tok');
    await jest.runAllTimersAsync();
    const r = await p;
    expect(r.targetId).toBe('7');
  });

  it('throws when MARKETO_BASE_URL missing', async () => {
    delete process.env.MARKETO_BASE_URL;
    await expect(writeMarketoCompany({ company: 'A' }, 'tok'))
      .rejects.toThrow('MARKETO_BASE_URL');
  });

  it('returns targetId=null when no id', async () => {
    const ax = require('axios');
    ax.post.mockResolvedValueOnce({
      data: { success: true, result: [{ status: 'updated' }] },
    });
    const r = await writeMarketoCompany({ company: 'A' }, 'tok');
    expect(r.targetId).toBeNull();
  });

  it('failed status without reasons array', async () => {
    const ax = require('axios');
    ax.post.mockResolvedValueOnce({
      data: { success: true, result: [{ status: 'failed' }] },
    });
    await expect(writeMarketoCompany({ company: 'A' }, 'tok'))
      .rejects.toThrow(/Company failed: no reason/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// writeToDynamics
// ─────────────────────────────────────────────────────────────────────────────
describe('writeToDynamics()', () => {
  let writeToDynamics;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    process.env.DYNAMICS_RESOURCE_URL  = 'https://test.crm.dynamics.com';
    process.env.DYNAMICS_API_VERSION   = '9.2';
    jest.resetModules();
    jest.mock('axios', () => ({ post: jest.fn(), patch: jest.fn() }));
    jest.mock('../../src/audit/logger', () => ({
      info: jest.fn(), warn: jest.fn(), error: jest.fn(),
    }));
    ({ writeToDynamics } = require('../../src/writers/dynamics'));
  });

  afterEach(() => {
    jest.useRealTimers();
    delete process.env.DYNAMICS_RESOURCE_URL;
    delete process.env.DYNAMICS_API_VERSION;
  });

  it('POSTs to create a new contact and returns the new id', async () => {
    const ax = require('axios');
    ax.post.mockResolvedValueOnce({
      data:    { contactid: 'new-guid' },
      headers: {},
    });

    const result = await writeToDynamics(
      { emailaddress1: 'a@b.com', action: 'create', targetId: null },
      'tok',
    );

    expect(ax.post).toHaveBeenCalledTimes(1);
    const [url] = ax.post.mock.calls[0];
    expect(url).toContain('/contacts');
    expect(result).toEqual({ targetId: 'new-guid', action: 'create' });
  });

  it('extracts id from odata-entityid header when body is empty', async () => {
    const ax = require('axios');
    ax.post.mockResolvedValueOnce({
      data:    {},
      headers: { 'odata-entityid': 'https://test.crm/api/data/v9.2/contacts(header-guid)' },
    });

    const result = await writeToDynamics({ emailaddress1: 'a@b.com', action: 'create' }, 'tok');
    expect(result.targetId).toBe('header-guid');
  });

  it('PATCHes to update an existing contact', async () => {
    const ax = require('axios');
    ax.patch.mockResolvedValueOnce({ data: {}, headers: {} });

    const result = await writeToDynamics(
      { emailaddress1: 'a@b.com', action: 'update', targetId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' },
      'tok',
    );

    expect(ax.patch).toHaveBeenCalledTimes(1);
    const [url] = ax.patch.mock.calls[0];
    expect(url).toContain('contacts(a1b2c3d4-e5f6-7890-abcd-ef1234567890)');
    expect(result).toEqual({ targetId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', action: 'update' });
  });

  it('sends the Bearer token in Authorization header', async () => {
    const ax = require('axios');
    ax.post.mockResolvedValueOnce({ data: { contactid: 'g' }, headers: {} });
    await writeToDynamics({ action: 'create' }, 'my-dyn-token');
    expect(ax.post.mock.calls[0][2].headers.Authorization).toBe('Bearer my-dyn-token');
  });

  it('retries on 429 and succeeds on the second attempt', async () => {
    const ax = require('axios');
    ax.post
      .mockRejectedValueOnce(make429(0))
      .mockResolvedValueOnce({ data: { contactid: 'retry-guid' }, headers: {} });

    const promise = writeToDynamics({ action: 'create' }, 'tok');
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(ax.post).toHaveBeenCalledTimes(2);
    expect(result.targetId).toBe('retry-guid');
  });

  it('throws when DYNAMICS_RESOURCE_URL is missing', async () => {
    delete process.env.DYNAMICS_RESOURCE_URL;
    await expect(writeToDynamics({ action: 'create' }, 'tok')).rejects.toThrow(
      'DYNAMICS_RESOURCE_URL',
    );
  });

  it('throws on update with invalid UUID format', async () => {
    await expect(writeToDynamics(
      { action: 'update', targetId: 'not-a-uuid' },
      'tok',
    )).rejects.toThrow(/Invalid targetId/);
  });

  it('extracts id from OData-EntityId header (PascalCase variant)', async () => {
    const ax = require('axios');
    ax.post.mockResolvedValueOnce({
      data: {},
      headers: { 'OData-EntityId': 'https://test.crm/api/data/v9.2/contacts(pascal-guid)' },
    });
    const result = await writeToDynamics({ action: 'create' }, 'tok');
    expect(result.targetId).toBe('pascal-guid');
  });

  it('does not retry on non-429 errors', async () => {
    const ax = require('axios');
    ax.post.mockRejectedValueOnce(Object.assign(new Error('500'), { response: { status: 500 } }));
    await expect(writeToDynamics({ action: 'create' }, 'tok')).rejects.toThrow('500');
  });

  it('uses default API version when DYNAMICS_API_VERSION not set', async () => {
    delete process.env.DYNAMICS_API_VERSION;
    const ax = require('axios');
    ax.post.mockResolvedValueOnce({ data: { contactid: 'g' }, headers: {} });
    await writeToDynamics({ action: 'create' }, 'tok');
    expect(ax.post.mock.calls[0][0]).toContain('/v9.2/');
  });

  it('uses default Retry-After when header missing', async () => {
    const ax = require('axios');
    ax.post
      .mockRejectedValueOnce({ response: { status: 429, headers: {} } })
      .mockResolvedValueOnce({ data: { contactid: 'g' }, headers: {} });
    const p = writeToDynamics({ action: 'create' }, 'tok');
    await jest.runAllTimersAsync();
    const r = await p;
    expect(r.targetId).toBe('g');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// writeDynamicsAccount
// ─────────────────────────────────────────────────────────────────────────────
describe('writeDynamicsAccount()', () => {
  let writeDynamicsAccount;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    process.env.DYNAMICS_RESOURCE_URL = 'https://test.crm.dynamics.com';
    process.env.DYNAMICS_API_VERSION  = '9.2';
    jest.resetModules();
    jest.mock('axios', () => ({ post: jest.fn(), patch: jest.fn() }));
    jest.mock('../../src/audit/logger', () => ({
      info: jest.fn(), warn: jest.fn(), error: jest.fn(),
    }));
    ({ writeDynamicsAccount } = require('../../src/writers/dynamics'));
  });

  afterEach(() => {
    jest.useRealTimers();
    delete process.env.DYNAMICS_RESOURCE_URL;
    delete process.env.DYNAMICS_API_VERSION;
  });

  it('POSTs to /accounts on create', async () => {
    const ax = require('axios');
    ax.post.mockResolvedValueOnce({
      data: { accountid: 'acc-guid' }, headers: {},
    });
    const r = await writeDynamicsAccount({ name: 'Acme', action: 'create' }, 'tok');
    expect(ax.post.mock.calls[0][0]).toContain('/accounts');
    expect(r).toEqual({ targetId: 'acc-guid', action: 'create' });
  });

  it('extracts account id from response header on create', async () => {
    const ax = require('axios');
    ax.post.mockResolvedValueOnce({
      data: {},
      headers: { 'OData-EntityId': '/accounts(hdr-acc-id)' },
    });
    const r = await writeDynamicsAccount({ name: 'Acme', action: 'create' }, 'tok');
    expect(r.targetId).toBe('hdr-acc-id');
  });

  it('PATCHes /accounts({id}) on update', async () => {
    const ax = require('axios');
    ax.patch.mockResolvedValueOnce({ data: {}, headers: {} });
    const goodGuid = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    const r = await writeDynamicsAccount(
      { name: 'Acme', action: 'update', targetId: goodGuid }, 'tok',
    );
    expect(ax.patch.mock.calls[0][0]).toContain(`/accounts(${goodGuid})`);
    expect(r).toEqual({ targetId: goodGuid, action: 'update' });
  });

  it('throws on update with non-UUID targetId', async () => {
    await expect(writeDynamicsAccount(
      { action: 'update', targetId: 'bogus' }, 'tok',
    )).rejects.toThrow(/Invalid account targetId/);
  });

  it('retries on 429', async () => {
    const ax = require('axios');
    ax.post
      .mockRejectedValueOnce(make429(0))
      .mockResolvedValueOnce({ data: { accountid: 'a-g' }, headers: {} });
    const p = writeDynamicsAccount({ name: 'A', action: 'create' }, 'tok');
    await jest.runAllTimersAsync();
    const r = await p;
    expect(r.targetId).toBe('a-g');
  });

  it('throws when DYNAMICS_RESOURCE_URL missing', async () => {
    delete process.env.DYNAMICS_RESOURCE_URL;
    await expect(writeDynamicsAccount({ action: 'create' }, 'tok'))
      .rejects.toThrow('DYNAMICS_RESOURCE_URL');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// stampMarketoIdOnContact
// ─────────────────────────────────────────────────────────────────────────────
describe('stampMarketoIdOnContact()', () => {
  let stampMarketoIdOnContact;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.DYNAMICS_RESOURCE_URL = 'https://test.crm.dynamics.com';
    process.env.DYNAMICS_API_VERSION  = '9.2';
    jest.resetModules();
    jest.mock('axios', () => ({ post: jest.fn(), patch: jest.fn() }));
    ({ stampMarketoIdOnContact } = require('../../src/writers/dynamics'));
  });

  afterEach(() => {
    delete process.env.DYNAMICS_RESOURCE_URL;
    delete process.env.DYNAMICS_API_VERSION;
  });

  const guid = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

  it('PATCHes ubt_marketoid onto the contact', async () => {
    const ax = require('axios');
    ax.patch.mockResolvedValueOnce({});
    await stampMarketoIdOnContact({ contactId: guid, marketoId: 9876, token: 'tok' });
    expect(ax.patch).toHaveBeenCalledWith(
      expect.stringContaining(`/contacts(${guid})`),
      { ubt_marketoid: '9876' },
      expect.objectContaining({ headers: expect.any(Object) }),
    );
  });

  it('throws when contactId is not a UUID', async () => {
    await expect(stampMarketoIdOnContact({ contactId: 'bad', marketoId: 1, token: 'tok' }))
      .rejects.toThrow(/contactId must be a GUID/);
  });

  it('no-ops when marketoId is empty', async () => {
    const ax = require('axios');
    await stampMarketoIdOnContact({ contactId: guid, marketoId: '', token: 'tok' });
    expect(ax.patch).not.toHaveBeenCalled();
  });

  it('throws when DYNAMICS_RESOURCE_URL missing', async () => {
    delete process.env.DYNAMICS_RESOURCE_URL;
    await expect(stampMarketoIdOnContact({ contactId: guid, marketoId: 1, token: 'tok' }))
      .rejects.toThrow('DYNAMICS_RESOURCE_URL');
  });
});
