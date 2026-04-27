'use strict';

jest.mock('axios', () => ({ get: jest.fn() }));

const axios = require('axios');
const { resolvePerson } = require('../../src/engine/personResolver');

beforeEach(() => {
  jest.clearAllMocks();
  process.env.DYNAMICS_RESOURCE_URL = 'https://test.crm.dynamics.com';
  process.env.DYNAMICS_API_VERSION  = '9.2';
});

afterEach(() => {
  delete process.env.DYNAMICS_RESOURCE_URL;
  delete process.env.DYNAMICS_API_VERSION;
});

// Helpers
function activeRecord(idField, id) {
  return { data: { [idField]: id, statecode: 0 } };
}
function emptyList()        { return { data: { value: [] } }; }
function listHit(idField, id) { return { data: { value: [{ [idField]: id }] } }; }
function http404() {
  const err = new Error('not found');
  err.response = { status: 404 };
  return err;
}

describe('resolvePerson — crmContactId primary', () => {
  it('returns contact hit when crmContactId resolves active', async () => {
    axios.get.mockResolvedValueOnce(activeRecord('contactid', 'contact-guid-1'));

    const r = await resolvePerson({
      ids:   { crmContactId: 'contact-guid-1' },
      email: 'a@b.com',
      token: 'tok',
    });

    expect(r).toEqual({
      action: 'update', entity: 'contact', targetId: 'contact-guid-1', matchedBy: 'id',
    });
    expect(axios.get).toHaveBeenCalledTimes(1);
    expect(axios.get.mock.calls[0][0]).toContain('/contacts(contact-guid-1)');
  });

  it('falls through to email when crmContactId 404s', async () => {
    axios.get.mockRejectedValueOnce(http404());
    axios.get.mockResolvedValueOnce(listHit('contactid', 'email-hit-guid'));

    const r = await resolvePerson({
      ids:   { crmContactId: 'stale-id' },
      email: 'a@b.com',
      token: 'tok',
    });

    expect(r).toEqual({
      action: 'update', entity: 'contact', targetId: 'email-hit-guid', matchedBy: 'email',
    });
    expect(axios.get).toHaveBeenCalledTimes(2);
  });

  it('falls through when crmContactId returns inactive (statecode=1)', async () => {
    axios.get.mockResolvedValueOnce({ data: { contactid: 'inactive', statecode: 1 } });
    axios.get.mockResolvedValueOnce(listHit('contactid', 'active-guid'));

    const r = await resolvePerson({
      ids:   { crmContactId: 'inactive' },
      email: 'x@y.com',
      token: 'tok',
    });

    expect(r.targetId).toBe('active-guid');
    expect(r.matchedBy).toBe('email');
  });
});

describe('resolvePerson — crmLeadId path', () => {
  it('returns lead hit when crmLeadId resolves active', async () => {
    axios.get.mockResolvedValueOnce(activeRecord('leadid', 'lead-guid-2'));

    const r = await resolvePerson({
      ids:   { crmLeadId: 'lead-guid-2' },
      email: 'l@b.com',
      token: 'tok',
    });

    expect(r).toEqual({
      action: 'update', entity: 'lead', targetId: 'lead-guid-2', matchedBy: 'id',
    });
    expect(axios.get.mock.calls[0][0]).toContain('/leads(lead-guid-2)');
  });

  it('checks contact ID first, then lead ID, before falling back to email', async () => {
    // contactId → 404
    axios.get.mockRejectedValueOnce(http404());
    // leadId → hit
    axios.get.mockResolvedValueOnce(activeRecord('leadid', 'lead-ok'));

    const r = await resolvePerson({
      ids:   { crmContactId: 'stale', crmLeadId: 'lead-ok' },
      email: 'x@y.com',
      token: 'tok',
    });

    expect(r.entity).toBe('lead');
    expect(r.targetId).toBe('lead-ok');
    expect(r.matchedBy).toBe('id');
    expect(axios.get).toHaveBeenCalledTimes(2); // did not fall through to email
  });
});

describe('resolvePerson — email fallback', () => {
  it('hits Contact via email when no IDs supplied', async () => {
    axios.get.mockResolvedValueOnce(listHit('contactid', 'c-by-email'));

    const r = await resolvePerson({ email: 'a@b.com', token: 'tok' });

    expect(r).toEqual({
      action: 'update', entity: 'contact', targetId: 'c-by-email', matchedBy: 'email',
    });
    expect(axios.get.mock.calls[0][1].params.$filter).toContain("emailaddress1 eq 'a@b.com'");
  });

  it('falls through to Lead search when email misses on Contacts', async () => {
    axios.get.mockResolvedValueOnce(emptyList());
    axios.get.mockResolvedValueOnce(listHit('leadid', 'l-by-email'));

    const r = await resolvePerson({ email: 'only@lead.com', token: 'tok' });

    expect(r).toEqual({
      action: 'update', entity: 'lead', targetId: 'l-by-email', matchedBy: 'email',
    });
  });

  it('returns create when both miss', async () => {
    axios.get.mockResolvedValueOnce(emptyList());
    axios.get.mockResolvedValueOnce(emptyList());

    const r = await resolvePerson({ email: 'new@nobody.com', token: 'tok' });

    expect(r).toEqual({
      action: 'create', entity: null, targetId: null, matchedBy: null,
    });
  });

  it('entityHint=contact skips the Lead fallback', async () => {
    axios.get.mockResolvedValueOnce(emptyList());

    const r = await resolvePerson({
      email:      'x@y.com',
      entityHint: 'contact',
      token:      'tok',
    });

    expect(r.matchedBy).toBeNull();
    expect(axios.get).toHaveBeenCalledTimes(1);
  });
});

describe('resolvePerson — ubt_marketoid tier', () => {
  it('uses marketoId after ID miss, before email', async () => {
    axios.get.mockResolvedValueOnce(listHit('contactid', 'by-mkto'));

    const r = await resolvePerson({
      marketoId: 987654,
      email:     'a@b.com',
      token:     'tok',
    });

    expect(r).toEqual({
      action: 'update', entity: 'contact', targetId: 'by-mkto', matchedBy: 'marketoId',
    });
    expect(axios.get.mock.calls[0][1].params.$filter).toContain("ubt_marketoid eq '987654'");
  });

  it('falls through to email when marketoId misses on both contact and lead', async () => {
    axios.get.mockResolvedValueOnce(emptyList()); // contacts by marketoId
    axios.get.mockResolvedValueOnce(emptyList()); // leads by marketoId
    axios.get.mockResolvedValueOnce(listHit('contactid', 'by-email'));

    const r = await resolvePerson({
      marketoId: '987',
      email:     'x@y.com',
      token:     'tok',
    });

    expect(r.matchedBy).toBe('email');
  });
});

describe('resolvePerson — validation', () => {
  it('throws without token', async () => {
    await expect(resolvePerson({ email: 'a@b.com' })).rejects.toThrow('token');
  });

  it('throws on unsupported targetSystem', async () => {
    await expect(resolvePerson({ email: 'a@b.com', token: 't', targetSystem: 'marketo' }))
      .rejects.toThrow('unsupported targetSystem');
  });
});
