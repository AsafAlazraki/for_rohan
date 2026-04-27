'use strict';

jest.mock('axios', () => ({ get: jest.fn(), post: jest.fn() }));

const axios = require('axios');
const { handleNewLead } = require('../../src/engine/handlers/newLead');
const fieldmap          = require('../../src/config/fieldmap.json');

beforeEach(() => {
  jest.clearAllMocks();
  process.env.DYNAMICS_RESOURCE_URL = 'https://test.crm.dynamics.com';
  process.env.DYNAMICS_API_VERSION  = '9.2';
});

afterEach(() => {
  delete process.env.DYNAMICS_RESOURCE_URL;
  delete process.env.DYNAMICS_API_VERSION;
  delete process.env.LEAD_COUNTRY_ALLOWLIST;
  delete process.env.LEAD_LIFECYCLE_MIN;
  delete process.env.LEAD_SOURCE_ALLOWLIST;
});

const emptyList    = () => ({ data: { value: [] } });
const contactHit   = (id) => ({ data: { value: [{ contactid: id }] } });
const accountHit   = (id) => ({ data: { value: [{ accountid: id }] } });
const leadCreated  = (id) => ({ data: { leadid: id }, headers: {} });

function validLeadPayload(overrides = {}) {
  return {
    id:            'MKTO-42',
    isLead:        true,
    firstName:     'Jane',
    lastName:      'Doe',
    email:         'jane@acme.com',
    phone:         '+1-555',
    title:         'Engineer',
    company:       'Acme Ltd',
    accountNumber: 'AN-100',
    city:          'Auckland',
    ...overrides,
  };
}

// ── Test helper: queue the pre-check GETs for a miss scenario ────────────────
// With entityHint='contact' in the pre-check, resolvePerson calls:
//   GET /contacts (by ubt_marketoid, when payload.id is set)
//   GET /contacts (by email)
// Then eligibility calls accountResolver:
//   GET /accounts?$filter=accountnumber eq '...'
function queueMissesThenAccountHit(accountId) {
  axios.get.mockResolvedValueOnce(emptyList());       // contacts by marketoId
  axios.get.mockResolvedValueOnce(emptyList());       // contacts by email
  axios.get.mockResolvedValueOnce(accountHit(accountId)); // account lookup
}

describe('handleNewLead — pre-check', () => {
  it('skips when Person resolves to an existing Contact', async () => {
    axios.get.mockResolvedValueOnce(contactHit('c-existing'));

    const res = await handleNewLead({
      payload: validLeadPayload(),
      token:   'tok',
      job:     { id: 'J1' },
    });

    expect(res).toEqual({
      status: 'skipped',
      reason: 'person-resolves-to-existing-contact',
    });
    expect(axios.post).not.toHaveBeenCalled();
  });
});

describe('handleNewLead — eligibility', () => {
  it('skips with ineligible reason listing every failure', async () => {
    // pre-check miss (entityHint=contact → only contacts table queried)
    axios.get.mockResolvedValueOnce(emptyList());  // contacts by marketoId
    axios.get.mockResolvedValueOnce(emptyList());  // contacts by email
    // eligibility: accountResolver → miss
    axios.get.mockResolvedValueOnce(emptyList());  // accountnumber
    axios.get.mockResolvedValueOnce(emptyList());  // name

    axios.post.mockRejectedValueOnce(new Error('auto-create failed')); // Fail auto-create

    const res = await handleNewLead({
      payload: { ...validLeadPayload(), email: 'bad-email', accountNumber: 'AN-X' },
      token:   'tok',
    });

    expect(res.status).toBe('skipped');
    expect(res.reason).toContain('ineligible:');
    expect(res.reason).toContain('emailValid');
    expect(res.reason).toContain('companyExists');
    expect(axios.post).toHaveBeenCalledTimes(1);
  });
});

describe('handleNewLead — happy path', () => {
  it('POSTs /leads with mapped fields + parentaccountid bind', async () => {
    queueMissesThenAccountHit('acc-resolved');
    axios.post.mockResolvedValueOnce(leadCreated('new-lead-id'));

    const res = await handleNewLead({
      payload: validLeadPayload(),
      token:   'tok',
    });

    expect(res).toEqual({ status: 'success', targetId: 'new-lead-id' });
    expect(axios.post).toHaveBeenCalledTimes(1);

    const [url, body] = axios.post.mock.calls[0];
    expect(url).toContain('/leads');
    expect(body.firstname).toBe('Jane');
    expect(body.lastname).toBe('Doe');
    expect(body.emailaddress1).toBe('jane@acme.com');
    expect(body.companyname).toBe('Acme Ltd');
    expect(body['parentaccountid@odata.bind']).toBe('/accounts(acc-resolved)');
  });

  it('non-bind keys are a subset of marketoToCrm.lead targets + the bind', async () => {
    queueMissesThenAccountHit('acc-1');
    axios.post.mockResolvedValueOnce(leadCreated('L1'));

    await handleNewLead({
      payload: validLeadPayload({
        // Add fields NOT in the whitelist — they must not leak into the body.
        donotbulkemail:  true,
        leadScore:       42,
        ubt_accounttype: 'Reseller',
      }),
      token: 'tok',
    });

    const [, body] = axios.post.mock.calls[0];
    const allowed = new Set([
      ...Object.keys(fieldmap.marketoToCrm.lead),
      'parentaccountid@odata.bind',
    ]);
    for (const key of Object.keys(body)) {
      expect(allowed.has(key)).toBe(true);
    }
  });

  it('omits parentaccountid bind when account not resolved (company absent)', async () => {
    // Pre-check miss: no payload.id so the marketoId tier is skipped → only
    // the email-on-contacts GET fires.
    axios.get.mockResolvedValueOnce(emptyList()); // contacts by email
    axios.post.mockResolvedValueOnce(leadCreated('new-lead-no-company'));

    const res = await handleNewLead({
      payload: { isLead: true, firstName: 'J', lastName: 'D', email: 'j@a.com' },
      token:   'tok',
    });
    
    expect(res.status).toBe('success');
    expect(axios.post).toHaveBeenCalledTimes(1);
    const [, body] = axios.post.mock.calls[0];
    expect(body['parentaccountid@odata.bind']).toBeUndefined();
  });
});

describe('handleNewLead — validation', () => {
  it('throws without token', async () => {
    await expect(handleNewLead({ payload: {} })).rejects.toThrow('token');
  });
});
