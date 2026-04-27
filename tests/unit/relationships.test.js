'use strict';

jest.mock('axios', () => ({
  get:   jest.fn(),
  post:  jest.fn(),
  patch: jest.fn(),
}));
jest.mock('../../src/audit/logger', () => ({
  info:  jest.fn(),
  warn:  jest.fn(),
  error: jest.fn(),
}));

const axios  = require('axios');
const logger = require('../../src/audit/logger');
const {
  setRelationship,
  clearRelationship,
  _resetCache,
} = require('../../src/engine/relationships');

const ROLE_ID    = '11111111-1111-1111-1111-111111111111';
const ACC_ID     = '22222222-2222-2222-2222-222222222222';
const CON_ID     = '33333333-3333-3333-3333-333333333333';
const CONN_ID    = '44444444-4444-4444-4444-444444444444';
const TOKEN      = 'tok';

beforeEach(() => {
  jest.clearAllMocks();
  _resetCache();
  process.env.DYNAMICS_RESOURCE_URL = 'https://test.crm.dynamics.com';
  process.env.DYNAMICS_API_VERSION  = '9.2';
});

afterEach(() => {
  delete process.env.DYNAMICS_RESOURCE_URL;
  delete process.env.DYNAMICS_API_VERSION;
});

function roleFoundResponse() {
  return { data: { value: [{ connectionroleid: ROLE_ID, name: 'KAM' }] } };
}
function roleMissingResponse() {
  return { data: { value: [] } };
}
function connectionFoundResponse() {
  return { data: { value: [{ connectionid: CONN_ID }] } };
}
function connectionMissingResponse() {
  return { data: { value: [] } };
}

describe('setRelationship', () => {
  it('is a no-op when the connection already exists (idempotent)', async () => {
    axios.get
      .mockResolvedValueOnce(roleFoundResponse())         // role lookup
      .mockResolvedValueOnce(connectionFoundResponse()); // existing connection

    const res = await setRelationship({
      accountId: ACC_ID,
      contactId: CON_ID,
      roleName:  'KAM',
      token:     TOKEN,
    });

    expect(res).toEqual({ created: false, connectionId: CONN_ID, roleId: ROLE_ID });
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('POSTs /connections with the correct bind body when no connection exists', async () => {
    axios.get
      .mockResolvedValueOnce(roleFoundResponse())
      .mockResolvedValueOnce(connectionMissingResponse());
    axios.post.mockResolvedValueOnce({
      data:    { connectionid: CONN_ID },
      headers: {},
    });

    const res = await setRelationship({
      accountId: ACC_ID,
      contactId: CON_ID,
      roleName:  'KAM',
      token:     TOKEN,
    });

    expect(res).toEqual({ created: true, connectionId: CONN_ID, roleId: ROLE_ID });
    expect(axios.post).toHaveBeenCalledTimes(1);

    const [url, body, opts] = axios.post.mock.calls[0];
    expect(url).toContain('/connections');
    expect(body).toEqual({
      'record1id_account@odata.bind': `/accounts(${ACC_ID})`,
      'record2id_contact@odata.bind': `/contacts(${CON_ID})`,
      'record1roleid@odata.bind':     `/connectionroles(${ROLE_ID})`,
    });
    expect(opts.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('skips gracefully with a reason + WARN when the role is missing (does not throw)', async () => {
    axios.get.mockResolvedValueOnce(roleMissingResponse());

    const res = await setRelationship({
      accountId: ACC_ID,
      contactId: CON_ID,
      roleName:  'Technology',
      token:     TOKEN,
    });

    expect(res).toEqual({ skipped: true, reason: 'connection-role-missing:Technology' });
    expect(axios.post).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toEqual({ roleName: 'Technology' });
  });

  it('caches role lookups across successive calls for the same role', async () => {
    axios.get
      // first call — role lookup then "connection already exists"
      .mockResolvedValueOnce(roleFoundResponse())
      .mockResolvedValueOnce(connectionFoundResponse())
      // second call — ONLY the connection query; cache should skip role lookup
      .mockResolvedValueOnce(connectionFoundResponse());

    await setRelationship({
      accountId: ACC_ID, contactId: CON_ID, roleName: 'KAM', token: TOKEN,
    });
    await setRelationship({
      accountId: ACC_ID, contactId: CON_ID, roleName: 'KAM', token: TOKEN,
    });

    // 3 GETs total: role (cached after first), conn (x2)
    expect(axios.get).toHaveBeenCalledTimes(3);
    const roleHits = axios.get.mock.calls.filter(c => c[0].includes('/connectionroles'));
    expect(roleHits).toHaveLength(1);
  });
});

describe('clearRelationship', () => {
  it('PATCHes statecode=1 when an active connection exists', async () => {
    axios.get
      .mockResolvedValueOnce(roleFoundResponse())
      .mockResolvedValueOnce(connectionFoundResponse());
    axios.patch.mockResolvedValueOnce({ data: {} });

    const res = await clearRelationship({
      accountId: ACC_ID,
      contactId: CON_ID,
      roleName:  'KAM',
      token:     TOKEN,
    });

    expect(res).toEqual({ cleared: true, connectionId: CONN_ID });
    expect(axios.patch).toHaveBeenCalledTimes(1);

    const [url, body] = axios.patch.mock.calls[0];
    expect(url).toContain(`/connections(${CONN_ID})`);
    expect(body).toEqual({ statecode: 1, statuscode: 2 });
  });

  it('returns cleared=false with not-found when no active connection exists', async () => {
    axios.get
      .mockResolvedValueOnce(roleFoundResponse())
      .mockResolvedValueOnce(connectionMissingResponse());

    const res = await clearRelationship({
      accountId: ACC_ID,
      contactId: CON_ID,
      roleName:  'KAM',
      token:     TOKEN,
    });

    expect(res).toEqual({ cleared: false, reason: 'not-found' });
    expect(axios.patch).not.toHaveBeenCalled();
  });

  it('skips with reason when the role is missing', async () => {
    axios.get.mockResolvedValueOnce(roleMissingResponse());

    const res = await clearRelationship({
      accountId: ACC_ID,
      contactId: CON_ID,
      roleName:  'Finance',
      token:     TOKEN,
    });

    expect(res).toEqual({ skipped: true, reason: 'connection-role-missing:Finance' });
    expect(axios.patch).not.toHaveBeenCalled();
  });
});
