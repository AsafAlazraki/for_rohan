'use strict';

const mockQuery = jest.fn();

jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation(() => ({ query: mockQuery })),
}));

const { logEvent, logSkip, _setPool } = require('../../src/audit/db');

beforeEach(() => {
  jest.clearAllMocks();
  _setPool({ query: mockQuery });
  mockQuery.mockResolvedValue({ rows: [{ id: 'uuid-skip' }] });
});

describe('logEvent() — new reason_category/reason_criterion columns', () => {
  it('passes reason_category and reason_criterion through to the INSERT params', async () => {
    await logEvent({
      source_system:    'marketo',
      source_id:        'MKTO-1',
      target_system:    'dynamics',
      payload:          {},
      status:           'skipped',
      reason_category:  'authority',
      reason_criterion: 'marketo-cannot-update-contact-nonconsent',
    });

    const params = mockQuery.mock.calls[0][1];
    expect(params).toContain('authority');
    expect(params).toContain('marketo-cannot-update-contact-nonconsent');
  });

  it('defaults reason_category/reason_criterion to null', async () => {
    await logEvent({
      source_system: 'dynamics',
      source_id:     'D1',
      target_system: 'marketo',
      payload:       {},
    });

    const params = mockQuery.mock.calls[0][1];
    // Inserted as NULL — count two nulls past the status/error slots.
    const nullCount = params.filter(p => p === null).length;
    expect(nullCount).toBeGreaterThanOrEqual(2);
  });
});

describe('logSkip()', () => {
  it('writes status=skipped with category/criterion and a composite error_message', async () => {
    const job = { id: 'job-xyz' };

    await logSkip({
      job,
      source:     'marketo',
      sourceType: 'contact',
      sourceId:   'MKTO-99',
      payload:    { email: 'a@b.com' },
      reason:     'marketo-cannot-update-existing-lead',
      category:   'authority',
      criterion:  'marketo-cannot-update-existing-lead',
    });

    const params = mockQuery.mock.calls[0][1];
    // status
    expect(params).toContain('skipped');
    // composite message
    expect(params).toContain('authority:marketo-cannot-update-existing-lead');
    // category
    expect(params).toContain('authority');
    // job_id coerced
    expect(params).toContain('job-xyz');
  });

  it('derives target from source when not provided', async () => {
    await logSkip({
      job:      { id: 'J1' },
      source:   'marketo',
      reason:   'r',
      category: 'authority',
    });

    const params = mockQuery.mock.calls[0][1];
    expect(params).toContain('dynamics'); // target_system
  });

  it('does not require payload or criterion', async () => {
    await logSkip({
      job:      { id: 'J' },
      source:   'dynamics',
      reason:   'no-change',
      category: 'no-change',
    });

    const params = mockQuery.mock.calls[0][1];
    expect(params).toContain('no-change:no-change'); // error_message
  });
});
