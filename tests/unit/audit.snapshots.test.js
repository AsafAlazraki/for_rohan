'use strict';

const mockQuery = jest.fn();

jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation(() => ({ query: mockQuery })),
}));

const { upsertSnapshot, loadSnapshot, _setPool } = require('../../src/audit/db');

beforeEach(() => {
  jest.clearAllMocks();
  _setPool({ query: mockQuery });
});

describe('upsertSnapshot()', () => {
  it('issues an INSERT ... ON CONFLICT DO UPDATE with stringified JSONB', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    await upsertSnapshot({
      source_system: 'dynamics',
      source_id:     'acc-1',
      source_type:   'account',
      payload:       { name: 'Acme', emailaddress1: 'a@b.com' },
    });

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO sync_snapshots/i);
    expect(sql).toMatch(/ON CONFLICT.*DO UPDATE/is);
    expect(params).toEqual([
      'dynamics',
      'acc-1',
      'account',
      JSON.stringify({ name: 'Acme', emailaddress1: 'a@b.com' }),
    ]);
  });

  it('coerces numeric source_id to string', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    await upsertSnapshot({
      source_system: 'marketo',
      source_id:     12345,
      source_type:   'contact',
      payload:       {},
    });
    expect(mockQuery.mock.calls[0][1][1]).toBe('12345');
  });

  it('throws when required keys are missing', async () => {
    await expect(upsertSnapshot({ payload: {} })).rejects.toThrow(
      'source_system, source_id, source_type required',
    );
  });
});

describe('loadSnapshot()', () => {
  it('returns null when no row exists', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await loadSnapshot({ source_system: 'dynamics', source_id: 'x' });

    expect(res).toBeNull();
  });

  it('parses JSONB string payloads transparently', async () => {
    const storedAt = new Date('2026-04-19T12:00:00Z');
    mockQuery.mockResolvedValueOnce({
      rows: [{
        source_type: 'contact',
        payload:     '{"firstname":"Jane"}',
        updated_at:  storedAt,
      }],
    });

    const res = await loadSnapshot({ source_system: 'dynamics', source_id: 'c1' });

    expect(res).toEqual({
      source_type: 'contact',
      payload:     { firstname: 'Jane' },
      updated_at:  storedAt,
    });
  });

  it('passes through already-object payloads (pg JSONB default)', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        source_type: 'account',
        payload:     { name: 'Acme' },
        updated_at:  new Date(),
      }],
    });
    const res = await loadSnapshot({ source_system: 'dynamics', source_id: 'a1' });
    expect(res.payload).toEqual({ name: 'Acme' });
  });
});

describe('round-trip', () => {
  it('upsertSnapshot then loadSnapshot returns the same payload', async () => {
    const payload = { firstname: 'Jane', emailaddress1: 'jane@example.com' };

    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    await upsertSnapshot({
      source_system: 'dynamics',
      source_id:     'c-guid',
      source_type:   'contact',
      payload,
    });

    // Simulate pg round-trip returning payload as a JS object (JSONB default)
    mockQuery.mockResolvedValueOnce({
      rows: [{
        source_type: 'contact',
        payload,
        updated_at:  new Date(),
      }],
    });

    const loaded = await loadSnapshot({
      source_system: 'dynamics',
      source_id:     'c-guid',
    });

    expect(loaded.payload).toEqual(payload);
  });
});
