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
  checkConnectionRoles,
  EXPECTED_ROLES,
  _resetCache,
} = require('../../src/engine/relationships');

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

describe('checkConnectionRoles', () => {
  it('issues one GET /connectionroles per expected role', async () => {
    // All roles present.
    axios.get.mockImplementation(() =>
      Promise.resolve({ data: { value: [{ connectionroleid: 'role-id', name: 'x' }] } }),
    );

    const res = await checkConnectionRoles('tok');

    expect(res).toEqual({ checked: true, missing: [] });
    expect(axios.get).toHaveBeenCalledTimes(EXPECTED_ROLES.length);

    // Every call targets /connectionroles.
    for (const call of axios.get.mock.calls) {
      expect(call[0]).toContain('/connectionroles');
    }
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('logs WARN for each missing role and never throws', async () => {
    // Roles KAM + Finance present, others missing.
    axios.get.mockImplementation((_url, opts) => {
      const filter = opts?.params?.$filter || '';
      if (filter.includes("'KAM'") || filter.includes("'Finance'")) {
        return Promise.resolve({ data: { value: [{ connectionroleid: 'x' }] } });
      }
      return Promise.resolve({ data: { value: [] } });
    });

    const res = await checkConnectionRoles('tok');

    const expectedMissing = EXPECTED_ROLES.filter(r => r !== 'KAM' && r !== 'Finance');
    expect(res.checked).toBe(true);
    expect(res.missing.sort()).toEqual(expectedMissing.sort());
    expect(logger.warn).toHaveBeenCalledTimes(expectedMissing.length);
  });

  it('swallows per-role errors — never throws', async () => {
    // Every lookup rejects.
    axios.get.mockRejectedValue(new Error('network down'));

    await expect(checkConnectionRoles('tok')).resolves.toEqual({
      checked: true,
      missing: [],
    });
    // Each role gets a WARN about the failure.
    expect(logger.warn).toHaveBeenCalledTimes(EXPECTED_ROLES.length);
  });

  it('skips entirely when no token is provided and logs INFO', async () => {
    const res = await checkConnectionRoles(null);
    expect(res).toEqual({ checked: false, missing: [] });
    expect(axios.get).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledTimes(1);
  });
});
