'use strict';

jest.mock('axios', () => ({ get: jest.fn() }));

const axios = require('axios');
const { resolveAccount } = require('../../src/engine/accountResolver');

beforeEach(() => {
  jest.clearAllMocks();
  process.env.DYNAMICS_RESOURCE_URL = 'https://test.crm.dynamics.com';
  process.env.DYNAMICS_API_VERSION  = '9.2';
  delete process.env.ACCOUNT_NETSUITE_FIELD;
});

afterEach(() => {
  delete process.env.DYNAMICS_RESOURCE_URL;
  delete process.env.DYNAMICS_API_VERSION;
  delete process.env.ACCOUNT_NETSUITE_FIELD;
});

const activeAcc  = (id) => ({ data: { accountid: id, statecode: 0 } });
const inactive   = (id) => ({ data: { accountid: id, statecode: 1 } });
const emptyList  = () => ({ data: { value: [] } });
const listHit    = (id) => ({ data: { value: [{ accountid: id }] } });
const http404    = () => { const e = new Error('nf'); e.response = { status: 404 }; return e; };

describe('resolveAccount — precedence table', () => {
  it('accountid hit short-circuits', async () => {
    axios.get.mockResolvedValueOnce(activeAcc('acc-1'));

    const r = await resolveAccount({
      ids:   { accountid: 'acc-1', accountnumber: 'AN-9', netsuiteId: 'NS', name: 'X' },
      token: 'tok',
    });

    expect(r).toEqual({ targetId: 'acc-1', matchedBy: 'accountid' });
    expect(axios.get).toHaveBeenCalledTimes(1);
  });

  it('falls to accountnumber when accountid 404s', async () => {
    axios.get.mockRejectedValueOnce(http404());
    axios.get.mockResolvedValueOnce(listHit('by-num'));

    const r = await resolveAccount({
      ids:   { accountid: 'stale', accountnumber: 'AN-42' },
      token: 'tok',
    });

    expect(r).toEqual({ targetId: 'by-num', matchedBy: 'accountnumber' });
    expect(axios.get.mock.calls[1][1].params.$filter).toContain("accountnumber eq 'AN-42'");
  });

  it('falls to NetSuite when accountnumber misses', async () => {
    axios.get.mockResolvedValueOnce(emptyList()); // accountnumber miss
    axios.get.mockResolvedValueOnce(listHit('by-ns'));

    const r = await resolveAccount({
      ids:   { accountnumber: 'AN-42', netsuiteId: 'NS-7' },
      token: 'tok',
    });

    expect(r).toEqual({ targetId: 'by-ns', matchedBy: 'netsuite' });
    expect(axios.get.mock.calls[1][1].params.$filter).toContain("cr_netsuiteid eq 'NS-7'");
  });

  it('respects ACCOUNT_NETSUITE_FIELD override', async () => {
    process.env.ACCOUNT_NETSUITE_FIELD = 'ubt_netsuiteid';
    axios.get.mockResolvedValueOnce(listHit('by-ns-2'));

    await resolveAccount({ ids: { netsuiteId: 'NS-9' }, token: 'tok' });

    expect(axios.get.mock.calls[0][1].params.$filter).toContain("ubt_netsuiteid eq 'NS-9'");
  });

  it('falls to name as last resort', async () => {
    axios.get.mockResolvedValueOnce(listHit('by-name'));

    const r = await resolveAccount({ ids: { name: 'Acme Ltd' }, token: 'tok' });

    expect(r).toEqual({ targetId: 'by-name', matchedBy: 'name' });
    expect(axios.get.mock.calls[0][1].params.$filter).toContain("name eq 'Acme Ltd'");
  });

  it('returns null miss when everything fails', async () => {
    axios.get.mockRejectedValueOnce(http404());          // accountid
    axios.get.mockResolvedValueOnce(emptyList());        // accountnumber
    axios.get.mockResolvedValueOnce(emptyList());        // netsuite
    axios.get.mockResolvedValueOnce(emptyList());        // name

    const r = await resolveAccount({
      ids: {
        accountid:     'stale',
        accountnumber: 'AN',
        netsuiteId:    'NS',
        name:          'Nope',
      },
      token: 'tok',
    });

    expect(r).toEqual({ targetId: null, matchedBy: null });
  });

  it('inactive accountid (statecode=1) falls through', async () => {
    axios.get.mockResolvedValueOnce(inactive('acc-1'));
    axios.get.mockResolvedValueOnce(listHit('active-by-num'));

    const r = await resolveAccount({
      ids:   { accountid: 'acc-1', accountnumber: 'AN-1' },
      token: 'tok',
    });

    expect(r.matchedBy).toBe('accountnumber');
    expect(r.targetId).toBe('active-by-num');
  });

  it('escapes single-quotes in accountnumber', async () => {
    axios.get.mockResolvedValueOnce(emptyList());

    await resolveAccount({ ids: { accountnumber: "AC'ME" }, token: 'tok' });

    expect(axios.get.mock.calls[0][1].params.$filter).toContain("accountnumber eq 'AC''ME'");
  });
});

describe('resolveAccount — validation', () => {
  it('throws without token', async () => {
    await expect(resolveAccount({ ids: { name: 'X' } })).rejects.toThrow('token');
  });

  it('no ids at all → null miss, no HTTP calls', async () => {
    const r = await resolveAccount({ ids: {}, token: 'tok' });
    expect(r).toEqual({ targetId: null, matchedBy: null });
    expect(axios.get).not.toHaveBeenCalled();
  });
});
