'use strict';

jest.mock('axios', () => ({ get: jest.fn(), patch: jest.fn() }));

const axios = require('axios');
const { handleGlobalUnsubscribe } = require('../../src/engine/handlers/unsubscribe');

beforeEach(() => {
  jest.clearAllMocks();
  process.env.DYNAMICS_RESOURCE_URL = 'https://test.crm.dynamics.com';
  process.env.DYNAMICS_API_VERSION  = '9.2';
});

afterEach(() => {
  delete process.env.DYNAMICS_RESOURCE_URL;
  delete process.env.DYNAMICS_API_VERSION;
});

const activeContact = (id) => ({ data: { contactid: id, statecode: 0 } });
const emptyList  = () => ({ data: { value: [] } });
const contactHit = (id) => ({ data: { value: [{ contactid: id }] } });
const leadHit    = (id) => ({ data: { value: [{ leadid: id }] } });
const http404 = () => { const e = new Error('nf'); e.response = { status: 404 }; return e; };

describe('handleGlobalUnsubscribe', () => {
  it('patches exactly { donotbulkemail: true } when crmContactId resolves', async () => {
    axios.get.mockResolvedValueOnce(activeContact('c-guid-1'));
    axios.patch.mockResolvedValueOnce({ status: 204 });

    const res = await handleGlobalUnsubscribe({
      payload: { crmContactId: 'c-guid-1', email: 'a@b.com', unsubscribed: true },
      token:   'tok',
      job:     { id: 'J1' },
    });

    expect(res).toEqual({ status: 'success', targetId: 'c-guid-1' });
    expect(axios.patch).toHaveBeenCalledTimes(1);
    const [url, body] = axios.patch.mock.calls[0];
    expect(url).toContain('/contacts(c-guid-1)');
    expect(Object.keys(body)).toEqual(['donotbulkemail']);
    expect(body.donotbulkemail).toBe(true);
  });

  it('falls through to email when crmContactId stale, still patches donotbulkemail', async () => {
    axios.get.mockRejectedValueOnce(http404());          // contactId miss
    axios.get.mockResolvedValueOnce(contactHit('c-by-email'));
    axios.patch.mockResolvedValueOnce({ status: 204 });

    const res = await handleGlobalUnsubscribe({
      payload: { crmContactId: 'stale', email: 'a@b.com', unsubscribed: true },
      token:   'tok',
    });

    expect(res.status).toBe('success');
    expect(res.targetId).toBe('c-by-email');
    expect(axios.patch.mock.calls[0][1]).toEqual({ donotbulkemail: true });
  });

  it('skips with reason=contact-not-resolvable when nothing matches', async () => {
    axios.get.mockRejectedValueOnce(http404());          // contactId
    axios.get.mockResolvedValueOnce(emptyList());        // contacts-by-email (entityHint=contact short-circuits here)

    const res = await handleGlobalUnsubscribe({
      payload: { crmContactId: 'stale', email: 'nobody@nowhere.com', unsubscribed: true },
      token:   'tok',
    });

    expect(res).toEqual({ status: 'skipped', reason: 'contact-not-resolvable' });
    expect(axios.patch).not.toHaveBeenCalled();
  });

  it('skips when entityHint=contact yields only lead match (entityHint prevents lead resolve)', async () => {
    // No crmContactId, no email match on contacts (entityHint=contact short-circuits Lead fallback).
    axios.get.mockResolvedValueOnce(emptyList());        // contacts by email

    const res = await handleGlobalUnsubscribe({
      payload: { email: 'only-a-lead@acme.com', unsubscribed: true },
      token:   'tok',
    });

    expect(res).toEqual({ status: 'skipped', reason: 'contact-not-resolvable' });
    expect(axios.patch).not.toHaveBeenCalled();
  });

  it('throws without token', async () => {
    await expect(handleGlobalUnsubscribe({ payload: {} })).rejects.toThrow('token');
  });
});
