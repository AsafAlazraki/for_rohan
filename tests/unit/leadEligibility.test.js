'use strict';

jest.mock('../../src/writers/dynamics', () => ({
  writeDynamicsAccount: jest.fn(),
}));

jest.mock('../../src/audit/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(),
}));

const { evaluateEligibility } = require('../../src/engine/leadEligibility');
const { writeDynamicsAccount } = require('../../src/writers/dynamics');

function validPayload(overrides = {}) {
  return {
    isLead:        true,
    firstName:     'Jane',
    lastName:      'Doe',
    email:         'jane@acme.com',
    company:       'Acme Ltd',
    accountNumber: 'AN-100',
    ...overrides,
  };
}

function resolver(targetId) {
  return {
    resolveAccount: jest.fn().mockResolvedValue({
      targetId,
      matchedBy: targetId ? 'accountnumber' : null,
    }),
  };
}

beforeEach(() => {
  jest.resetAllMocks();
  delete process.env.LEAD_COUNTRY_ALLOWLIST;
  delete process.env.LEAD_LIFECYCLE_MIN;
  delete process.env.LEAD_SOURCE_ALLOWLIST;
});

describe('evaluateEligibility — happy path', () => {
  it('ok=true when all hard criteria pass and flags are off', async () => {
    const res = await evaluateEligibility(validPayload(), {
      token:           'tok',
      accountResolver: resolver('acc-guid'),
    });

    expect(res.ok).toBe(true);
    expect(res.failures).toEqual([]);
    expect(res.resolvedAccountId).toBe('acc-guid');
  });
});

describe('evaluateEligibility — hard criteria', () => {
  it('fails personType when isLead is not true', async () => {
    const res = await evaluateEligibility(
      validPayload({ isLead: false }),
      { token: 'tok', accountResolver: resolver('a') },
    );
    expect(res.ok).toBe(false);
    expect(res.failures.find(f => f.criterion === 'personType')).toBeDefined();
  });

  it('fails personType when crmLeadId already set', async () => {
    const res = await evaluateEligibility(
      validPayload({ crmLeadId: 'L1' }),
      { token: 'tok', accountResolver: resolver('a') },
    );
    expect(res.failures.some(f => f.criterion === 'personType')).toBe(true);
  });

  it('passes personType when type=lead (Marketo-native type field, no isLead flag)', async () => {
    const { isLead: _omit, ...rest } = validPayload();
    const res = await evaluateEligibility(
      { ...rest, type: 'lead' },
      { token: 'tok', accountResolver: resolver('a') },
    );
    expect(res.failures.some(f => f.criterion === 'personType')).toBe(false);
  });

  it('fails emailValid for malformed email', async () => {
    const res = await evaluateEligibility(
      validPayload({ email: 'not-an-email' }),
      { token: 'tok', accountResolver: resolver('a') },
    );
    expect(res.failures.some(f => f.criterion === 'emailValid')).toBe(true);
  });

  it('fails consent when unsubscribed=true', async () => {
    const res = await evaluateEligibility(
      validPayload({ unsubscribed: true }),
      { token: 'tok', accountResolver: resolver('a') },
    );
    expect(res.failures.some(f => f.criterion === 'consent')).toBe(true);
  });

  it('fails dataCompleteness when firstName missing', async () => {
    const res = await evaluateEligibility(
      validPayload({ firstName: '' }),
      { token: 'tok', accountResolver: resolver('a') },
    );
    const fc = res.failures.find(f => f.criterion === 'dataCompleteness');
    expect(fc).toBeDefined();
    expect(fc.detail).toContain('firstName');
  });

  it('auto-creates account when resolver returns null and company is provided', async () => {
    writeDynamicsAccount.mockResolvedValueOnce({ targetId: 'auto-1' });
    const res = await evaluateEligibility(
      validPayload(),
      { token: 'tok', accountResolver: resolver(null) },
    );
    expect(res.failures.some(f => f.criterion === 'companyExists')).toBe(false);
    expect(res.resolvedAccountId).toBe('auto-1');
  });

  it('passes companyExists when no company is provided (company is optional)', async () => {
    const res = await evaluateEligibility(
      validPayload({ company: '', accountNumber: '' }),
      { token: 'tok', accountResolver: resolver(null) },
    );
    // Company is optional — criterion passes, no account linkage
    expect(res.failures.some(f => f.criterion === 'companyExists')).toBe(false);
  });

  it('collects every failure (does not short-circuit)', async () => {
    writeDynamicsAccount.mockResolvedValueOnce({ targetId: null });
    const res = await evaluateEligibility(
      { email: '', firstName: '', lastName: '', company: '', unsubscribed: true },
      { token: 'tok', accountResolver: resolver(null) },
    );
    const names = res.failures.map(f => f.criterion).sort();
    // company is optional, so companyExists should NOT appear
    expect(names).toEqual(
      ['consent', 'dataCompleteness', 'emailValid', 'personType'].sort(),
    );
  });
});

describe('evaluateEligibility — optional flag gates', () => {
  it('countryScope passes when flag is disabled', async () => {
    const res = await evaluateEligibility(
      validPayload({ country: 'Mars' }),
      { token: 'tok', accountResolver: resolver('a') },
    );
    expect(res.failures.find(f => f.criterion === 'countryScope')).toBeUndefined();
  });

  it('countryScope fails when flag enabled and country not in list', async () => {
    process.env.LEAD_COUNTRY_ALLOWLIST = 'US,NZ';
    const res = await evaluateEligibility(
      validPayload({ country: 'FR' }),
      { token: 'tok', accountResolver: resolver('a') },
    );
    expect(res.failures.some(f => f.criterion === 'countryScope')).toBe(true);
  });

  it('lifecycleGate fails when score below threshold', async () => {
    process.env.LEAD_LIFECYCLE_MIN = '50';
    const res = await evaluateEligibility(
      validPayload({ leadScore: 10 }),
      { token: 'tok', accountResolver: resolver('a') },
    );
    expect(res.failures.some(f => f.criterion === 'lifecycleGate')).toBe(true);
  });

  it('lifecycleGate passes at-or-above threshold', async () => {
    process.env.LEAD_LIFECYCLE_MIN = '50';
    const res = await evaluateEligibility(
      validPayload({ leadScore: 60 }),
      { token: 'tok', accountResolver: resolver('a') },
    );
    expect(res.ok).toBe(true);
  });

  it('sourceChannelScope fails when flag enabled and source missing', async () => {
    process.env.LEAD_SOURCE_ALLOWLIST = 'webform,event';
    const res = await evaluateEligibility(
      validPayload(),
      { token: 'tok', accountResolver: resolver('a') },
    );
    expect(res.failures.some(f => f.criterion === 'sourceChannelScope')).toBe(true);
  });

  it('sourceChannelScope passes when source is in allowlist', async () => {
    process.env.LEAD_SOURCE_ALLOWLIST = 'webform,event';
    const res = await evaluateEligibility(
      validPayload({ source: 'webform' }),
      { token: 'tok', accountResolver: resolver('a') },
    );
    expect(res.failures.some(f => f.criterion === 'sourceChannelScope')).toBe(false);
  });

  it('sourceChannelScope fails when source not in allowlist', async () => {
    process.env.LEAD_SOURCE_ALLOWLIST = 'webform,event';
    const res = await evaluateEligibility(
      validPayload({ source: 'cold-call' }),
      { token: 'tok', accountResolver: resolver('a') },
    );
    expect(res.failures.some(f => f.criterion === 'sourceChannelScope')).toBe(true);
  });

  it('countryScope passes when country is in allowlist', async () => {
    process.env.LEAD_COUNTRY_ALLOWLIST = 'NZ,US';
    const res = await evaluateEligibility(
      validPayload({ country: 'NZ' }),
      { token: 'tok', accountResolver: resolver('a') },
    );
    expect(res.failures.some(f => f.criterion === 'countryScope')).toBe(false);
  });

  it('countryScope fails when country missing and flag enabled', async () => {
    process.env.LEAD_COUNTRY_ALLOWLIST = 'NZ';
    const res = await evaluateEligibility(
      validPayload({ country: '' }),
      { token: 'tok', accountResolver: resolver('a') },
    );
    expect(res.failures.some(f => f.criterion === 'countryScope')).toBe(true);
  });

  it('lifecycleGate fails when leadScore is absent (non-numeric)', async () => {
    process.env.LEAD_LIFECYCLE_MIN = '50';
    const res = await evaluateEligibility(
      validPayload(), // no leadScore
      { token: 'tok', accountResolver: resolver('a') },
    );
    const fc = res.failures.find(f => f.criterion === 'lifecycleGate');
    expect(fc).toBeDefined();
    expect(fc.detail).toMatch(/leadScore absent/);
  });
});

describe('evaluateEligibility — auto-create account', () => {
  it('auto-creates account when resolver misses, sets resolvedAccountId', async () => {
    writeDynamicsAccount.mockResolvedValueOnce({ targetId: 'new-acc-guid', action: 'create' });
    const res = await evaluateEligibility(
      validPayload(),
      { token: 'tok', accountResolver: resolver(null) },
    );
    expect(res.ok).toBe(true);
    expect(res.resolvedAccountId).toBe('new-acc-guid');
    expect(writeDynamicsAccount).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'create', name: 'Acme Ltd', accountnumber: 'AN-100' }),
      'tok',
    );
  });

  it('uses accountnumber as company name when company missing', async () => {
    writeDynamicsAccount.mockResolvedValueOnce({ targetId: 'a-2' });
    const res = await evaluateEligibility(
      validPayload({ company: '' }),
      { token: 'tok', accountResolver: resolver(null) },
    );
    expect(res.resolvedAccountId).toBe('a-2');
    expect(writeDynamicsAccount.mock.calls[0][0].name).toBe('AN-100');
  });

  it('fails companyExists when auto-create returns no targetId', async () => {
    writeDynamicsAccount.mockResolvedValueOnce({ targetId: null });
    const res = await evaluateEligibility(
      validPayload(),
      { token: 'tok', accountResolver: resolver(null) },
    );
    const fc = res.failures.find(f => f.criterion === 'companyExists');
    expect(fc).toBeDefined();
    expect(fc.detail).toMatch(/failed to auto-create/);
  });

  it('fails companyExists when auto-create throws', async () => {
    writeDynamicsAccount.mockRejectedValueOnce(new Error('write failed'));
    const res = await evaluateEligibility(
      validPayload(),
      { token: 'tok', accountResolver: resolver(null) },
    );
    const fc = res.failures.find(f => f.criterion === 'companyExists');
    expect(fc).toBeDefined();
    expect(fc.detail).toMatch(/auto-create account error/);
  });
});

describe('evaluateEligibility — validation', () => {
  it('throws without token in ctx', async () => {
    await expect(evaluateEligibility(validPayload(), {})).rejects.toThrow('token');
  });

  it('empty payload fails all hard criteria', async () => {
    const res = await evaluateEligibility({}, {
      token: 'tok',
      accountResolver: resolver(null),
    });
    expect(res.ok).toBe(false);
    const names = res.failures.map(f => f.criterion);
    // company is optional, so companyExists should NOT appear for empty payload
    expect(names).toEqual(expect.arrayContaining([
      'personType', 'emailValid', 'dataCompleteness',
    ]));
  });
});
