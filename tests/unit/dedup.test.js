'use strict';

jest.mock('axios', () => ({
  get: jest.fn(),
}));

const axios = require('axios');
const { resolveAction, resolveAccountAction } = require('../../src/engine/dedup');

beforeEach(() => {
  jest.clearAllMocks();
  process.env.MARKETO_BASE_URL     = 'https://test.mktorest.com';
  process.env.DYNAMICS_RESOURCE_URL = 'https://test.crm.dynamics.com';
  process.env.DYNAMICS_API_VERSION  = '9.2';
});

afterEach(() => {
  delete process.env.MARKETO_BASE_URL;
  delete process.env.DYNAMICS_RESOURCE_URL;
  delete process.env.DYNAMICS_API_VERSION;
});

// ── Marketo ────────────────────────────────────────────────────────────────────
describe('resolveAction() — targetSystem=marketo', () => {
  it('returns action=update when Marketo finds an existing lead', async () => {
    axios.get.mockResolvedValueOnce({
      data: { success: true, result: [{ id: 101, email: 'alice@example.com' }] },
    });

    const result = await resolveAction('alice@example.com', 'marketo', 'tok-abc');

    expect(result).toEqual({ action: 'update', targetId: '101' });
    expect(axios.get).toHaveBeenCalledTimes(1);
    expect(axios.get.mock.calls[0][0]).toContain('/rest/v1/leads.json');
    expect(axios.get.mock.calls[0][1].params.filterValues).toBe('alice@example.com');
  });

  it('returns action=create when Marketo returns an empty result', async () => {
    axios.get.mockResolvedValueOnce({
      data: { success: true, result: [] },
    });

    const result = await resolveAction('new@example.com', 'marketo', 'tok-abc');
    expect(result).toEqual({ action: 'create', targetId: null });
  });

  it('returns action=create when Marketo result is undefined', async () => {
    axios.get.mockResolvedValueOnce({
      data: { success: true },
    });

    const result = await resolveAction('new@example.com', 'marketo', 'tok-abc');
    expect(result).toEqual({ action: 'create', targetId: null });
  });

  it('throws when Marketo returns success=false', async () => {
    axios.get.mockResolvedValueOnce({
      data: { success: false, errors: [{ code: '603', message: 'Lead not found' }] },
    });

    await expect(resolveAction('x@y.com', 'marketo', 'tok')).rejects.toThrow(
      'Marketo search failed',
    );
  });

  it('sends the Bearer token in the Authorization header', async () => {
    axios.get.mockResolvedValueOnce({ data: { success: true, result: [] } });
    await resolveAction('a@b.com', 'marketo', 'my-token');

    expect(axios.get.mock.calls[0][1].headers.Authorization).toBe('Bearer my-token');
  });

  it('throws when MARKETO_BASE_URL is not set', async () => {
    delete process.env.MARKETO_BASE_URL;
    await expect(resolveAction('a@b.com', 'marketo', 'tok')).rejects.toThrow(
      'MARKETO_BASE_URL',
    );
  });
});

// ── Dynamics ───────────────────────────────────────────────────────────────────
describe('resolveAction() — targetSystem=dynamics', () => {
  it('returns action=update when Dynamics finds an existing contact', async () => {
    axios.get.mockResolvedValueOnce({
      data: {
        value: [{ contactid: 'guid-123', emailaddress1: 'alice@example.com' }],
      },
    });

    const result = await resolveAction('alice@example.com', 'dynamics', 'tok-dyn');

    expect(result).toEqual({ action: 'update', targetId: 'guid-123' });
    expect(axios.get.mock.calls[0][0]).toContain('/contacts');
  });

  it('returns action=create when Dynamics value array is empty', async () => {
    axios.get.mockResolvedValueOnce({ data: { value: [] } });

    const result = await resolveAction('new@example.com', 'dynamics', 'tok-dyn');
    expect(result).toEqual({ action: 'create', targetId: null });
  });

  it('returns action=create when Dynamics value key is absent', async () => {
    axios.get.mockResolvedValueOnce({ data: {} });

    const result = await resolveAction('new@example.com', 'dynamics', 'tok-dyn');
    expect(result).toEqual({ action: 'create', targetId: null });
  });

  it('escapes single-quotes in email for OData injection prevention', async () => {
    axios.get.mockResolvedValueOnce({ data: { value: [] } });
    await resolveAction("o'malley@evil.com", 'dynamics', 'tok');

    const filter = axios.get.mock.calls[0][1].params.$filter;
    expect(filter).toContain("o''malley@evil.com"); // OData escaping
  });

  it('throws when DYNAMICS_RESOURCE_URL is not set', async () => {
    delete process.env.DYNAMICS_RESOURCE_URL;
    await expect(resolveAction('a@b.com', 'dynamics', 'tok')).rejects.toThrow(
      'DYNAMICS_RESOURCE_URL',
    );
  });
});

// ── Input validation ───────────────────────────────────────────────────────────
describe('resolveAction() — input validation', () => {
  it('throws when email is empty', async () => {
    await expect(resolveAction('', 'marketo', 'tok')).rejects.toThrow('email is required');
  });

  it('throws when token is empty', async () => {
    await expect(resolveAction('a@b.com', 'marketo', '')).rejects.toThrow('token is required');
  });

  it('throws when targetSystem is empty', async () => {
    await expect(resolveAction('a@b.com', '', 'tok')).rejects.toThrow('targetSystem is required');
  });

  it('throws on unknown targetSystem', async () => {
    await expect(resolveAction('a@b.com', 'salesforce', 'tok')).rejects.toThrow(
      'unknown targetSystem',
    );
  });
});

describe('resolveAccountAction()', () => {
  it('throws when name missing', async () => {
    await expect(resolveAccountAction('', 'marketo', 'tok')).rejects.toThrow('name is required');
  });

  it('throws when token missing', async () => {
    await expect(resolveAccountAction('Acme', 'marketo', '')).rejects.toThrow('token is required');
  });

  it('Marketo: returns update on hit', async () => {
    axios.get.mockResolvedValueOnce({ data: { success: true, result: [{ id: 7, company: 'Acme' }] } });
    const r = await resolveAccountAction('Acme', 'marketo', 'tok');
    expect(r).toEqual({ action: 'update', targetId: '7' });
    expect(axios.get.mock.calls[0][0]).toContain('/rest/v1/companies.json');
    expect(axios.get.mock.calls[0][1].params.filterValues).toBe('Acme');
  });

  it('Marketo: returns create on empty hit', async () => {
    axios.get.mockResolvedValueOnce({ data: { success: true, result: [] } });
    const r = await resolveAccountAction('NoOne', 'marketo', 'tok');
    expect(r).toEqual({ action: 'create', targetId: null });
  });

  it('Marketo: returns create on success=false (no-results sentinel)', async () => {
    axios.get.mockResolvedValueOnce({ data: { success: false, errors: [] } });
    const r = await resolveAccountAction('Mystery', 'marketo', 'tok');
    expect(r).toEqual({ action: 'create', targetId: null });
  });

  it('Marketo: throws when MARKETO_BASE_URL not set', async () => {
    delete process.env.MARKETO_BASE_URL;
    await expect(resolveAccountAction('Acme', 'marketo', 'tok')).rejects.toThrow('MARKETO_BASE_URL');
  });

  it('Dynamics: returns update on hit', async () => {
    axios.get.mockResolvedValueOnce({ data: { value: [{ accountid: 'a-1', name: 'Acme' }] } });
    const r = await resolveAccountAction('Acme', 'dynamics', 'tok');
    expect(r).toEqual({ action: 'update', targetId: 'a-1' });
    const filter = axios.get.mock.calls[0][1].params.$filter;
    expect(filter).toContain("name eq 'Acme'");
  });

  it('Dynamics: returns create on empty value', async () => {
    axios.get.mockResolvedValueOnce({ data: { value: [] } });
    const r = await resolveAccountAction('Nope', 'dynamics', 'tok');
    expect(r).toEqual({ action: 'create', targetId: null });
  });

  it('Dynamics: returns create when value is absent', async () => {
    axios.get.mockResolvedValueOnce({ data: {} });
    const r = await resolveAccountAction('Nope', 'dynamics', 'tok');
    expect(r).toEqual({ action: 'create', targetId: null });
  });

  it('Dynamics: escapes single-quotes in name', async () => {
    axios.get.mockResolvedValueOnce({ data: { value: [] } });
    await resolveAccountAction("AC'ME", 'dynamics', 'tok');
    expect(axios.get.mock.calls[0][1].params.$filter).toContain("name eq 'AC''ME'");
  });

  it('Dynamics: throws when DYNAMICS_RESOURCE_URL not set', async () => {
    delete process.env.DYNAMICS_RESOURCE_URL;
    await expect(resolveAccountAction('Acme', 'dynamics', 'tok')).rejects.toThrow('DYNAMICS_RESOURCE_URL');
  });

  it('throws on unknown targetSystem', async () => {
    await expect(resolveAccountAction('Acme', 'salesforce', 'tok')).rejects.toThrow('unknown targetSystem');
  });
});
