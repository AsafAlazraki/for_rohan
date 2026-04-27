'use strict';

// ── Mock pg before any require ─────────────────────────────────────────────────
const mockQuery = jest.fn();

jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation(() => ({ query: mockQuery })),
}));

// The outbound webhooks dispatcher is lazy-required from inside logEvent (to
// avoid a circular require). Stub it here so audit tests don't have to care
// about webhook side-effects.
jest.mock('../../src/webhooks/outboundDispatcher', () => ({
  dispatchEvent: jest.fn().mockResolvedValue(undefined),
}));

const { Pool }                           = require('pg');
const { logEvent, logSkip, getSyncStats, upsertSnapshot, loadSnapshot, _setPool } = require('../../src/audit/db');

beforeEach(() => {
  jest.clearAllMocks();
  // Inject a fresh mock pool for each test so singleton doesn't bleed
  _setPool({ query: mockQuery });
});

// ── logEvent ───────────────────────────────────────────────────────────────────
describe('logEvent()', () => {
  it('executes an INSERT and returns the new row id', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'uuid-1' }] });

    const row = await logEvent({
      source_system: 'dynamics',
      source_id:     'contact-123',
      target_system: 'marketo',
      payload:       { email: 'a@b.com' },
      status:        'success',
      job_id:        'job-1',
    });

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO sync_events/i);
    expect(params).toContain('dynamics');
    expect(params).toContain('contact-123');
    expect(params).toContain('marketo');
    expect(params).toContain('success');
    expect(row).toEqual({ id: 'uuid-1' });
  });

  it('uses defaults for optional fields', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'uuid-2' }] });

    await logEvent({
      source_system: 'marketo',
      source_id:     '42',
      target_system: 'dynamics',
      payload:       {},
    });

    const params = mockQuery.mock.calls[0][1];
    // source_type defaults to 'contact'
    expect(params).toContain('contact');
    // status defaults to 'success'
    expect(params).toContain('success');
  });

  it('serialises payload and error_detail to JSON strings', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'uuid-3' }] });

    await logEvent({
      source_system: 'dynamics',
      source_id:     '1',
      target_system: 'marketo',
      payload:       { key: 'val' },
      status:        'failed',
      error_message: 'oops',
      error_detail:  { stack: 'Error: oops\n  at ...' },
    });

    const params = mockQuery.mock.calls[0][1];
    // payload is stringified
    expect(params).toContain(JSON.stringify({ key: 'val' }));
    // error_detail is stringified
    expect(params).toContain(JSON.stringify({ stack: 'Error: oops\n  at ...' }));
  });

  it('coerces numeric source_id to string', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'uuid-4' }] });
    await logEvent({
      source_system: 'marketo',
      source_id:     12345,
      target_system: 'dynamics',
      payload:       {},
    });
    const params = mockQuery.mock.calls[0][1];
    expect(params).toContain('12345');
  });
});

// ── getSyncStats ───────────────────────────────────────────────────────────────
describe('getSyncStats()', () => {
  it('queries without WHERE when no filters are passed', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ status: 'success', count: '80' }, { status: 'failed', count: '5' }],
    });

    const rows = await getSyncStats();

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).not.toMatch(/WHERE/i);
    expect(params).toHaveLength(0);
    expect(rows).toHaveLength(2);
  });

  it('includes WHERE clause and parameterised values when filters are provided', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const from = new Date('2026-01-01');
    const to   = new Date('2026-04-01');
    await getSyncStats({ from, to, source_system: 'dynamics', status: 'failed' });

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/WHERE/i);
    expect(params).toContain(from);
    expect(params).toContain(to);
    expect(params).toContain('dynamics');
    expect(params).toContain('failed');
  });

  it('applies only the filters that are supplied', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getSyncStats({ source_system: 'marketo' });

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/source_system/i);
    expect(params).toEqual(['marketo']);
  });

  it('returns an empty array when no rows match', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const rows = await getSyncStats();
    expect(rows).toEqual([]);
  });
});

describe('logSkip()', () => {
  it('logs as skipped with composed error_message', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'skip-1' }] });
    await logSkip({
      job:    { id: 'job-9' },
      source: 'dynamics',
      sourceId:  'src-1',
      payload:   { foo: 'bar' },
      reason:    'unmatched',
      category:  'authority',
      criterion: 'crit-x',
    });
    const params = mockQuery.mock.calls[0][1];
    expect(params).toContain('skipped');
    expect(params).toContain('authority:unmatched');
    expect(params).toContain('crit-x');
  });

  it('defaults target to opposite of source when omitted', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'skip-2' }] });
    await logSkip({
      job: { id: 'j' },
      source: 'marketo',
      reason: 'r', category: 'c',
    });
    const params = mockQuery.mock.calls[0][1];
    expect(params).toContain('marketo');
    expect(params).toContain('dynamics');
  });

  it('falls back to job.id when sourceId not provided', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'skip-3' }] });
    await logSkip({
      job: { id: 'job-fallback' },
      source: 'dynamics',
      reason: 'r', category: 'c',
    });
    const params = mockQuery.mock.calls[0][1];
    expect(params).toContain('job-fallback');
  });
});

describe('upsertSnapshot()', () => {
  it('inserts/updates a snapshot row', async () => {
    mockQuery.mockResolvedValueOnce({});
    await upsertSnapshot({
      source_system: 'dynamics',
      source_id:     'guid',
      source_type:   'contact',
      payload:       { x: 1 },
    });
    const sql = mockQuery.mock.calls[0][0];
    expect(sql).toMatch(/INSERT INTO sync_snapshots/);
    expect(sql).toMatch(/ON CONFLICT.*DO UPDATE/);
  });

  it('throws when missing required fields', async () => {
    await expect(upsertSnapshot({})).rejects.toThrow(/required/);
  });

  it('serialises empty payload to JSON', async () => {
    mockQuery.mockResolvedValueOnce({});
    await upsertSnapshot({
      source_system: 'dynamics',
      source_id:     'guid',
      source_type:   'contact',
    });
    const params = mockQuery.mock.calls[0][1];
    expect(params).toContain('{}');
  });
});

describe('loadSnapshot()', () => {
  it('returns null when no rows', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const r = await loadSnapshot({ source_system: 'd', source_id: 'x' });
    expect(r).toBeNull();
  });

  it('parses string payload to object', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ source_type: 'contact', payload: '{"a":1}', updated_at: '2026-01-01' }],
    });
    const r = await loadSnapshot({ source_system: 'd', source_id: 'x' });
    expect(r.payload).toEqual({ a: 1 });
    expect(r.source_type).toBe('contact');
  });

  it('passes through object payload', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ source_type: 'lead', payload: { a: 2 }, updated_at: '2026-01-01' }],
    });
    const r = await loadSnapshot({ source_system: 'd', source_id: 'x' });
    expect(r.payload).toEqual({ a: 2 });
  });
});
