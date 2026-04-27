'use strict';

const { shouldSkip } = require('../../src/engine/loopGuard');

describe('shouldSkip()', () => {
  // ── Safe passthrough cases ─────────────────────────────────────────────────
  describe('returns skip=false (safe to process)', () => {
    it('when syncSource is absent from payload', () => {
      expect(shouldSkip({ payload: { email: 'a@b.com' } }, 'marketo')).toEqual({ skip: false });
    });

    it('when payload is an empty object', () => {
      expect(shouldSkip({ payload: {} }, 'dynamics')).toEqual({ skip: false });
    });

    it('when syncSource equals the OTHER system (not the target)', () => {
      // Record came from dynamics, target is marketo → safe to write to marketo
      const event = { payload: { syncSource: 'dynamics' } };
      expect(shouldSkip(event, 'marketo')).toEqual({ skip: false });
    });

    it('when cr_syncsource equals the OTHER system', () => {
      const event = { payload: { cr_syncsource: 'marketo' } };
      expect(shouldSkip(event, 'dynamics')).toEqual({ skip: false });
    });

    it('when event is null', () => {
      expect(shouldSkip(null, 'marketo')).toEqual({ skip: false });
    });

    it('when targetSystem is falsy', () => {
      expect(shouldSkip({ payload: { syncSource: 'marketo' } }, '')).toEqual({ skip: false });
    });
  });

  // ── Loop-guard triggers ───────────────────────────────────────────────────
  describe('returns skip=true (loop detected)', () => {
    it('when syncSource matches target system (marketo → marketo)', () => {
      const event = { payload: { syncSource: 'marketo' } };
      const result = shouldSkip(event, 'marketo');
      expect(result.skip).toBe(true);
      expect(result.reason).toMatch(/marketo/i);
    });

    it('when cr_syncsource matches target system (dynamics → dynamics)', () => {
      const event = { payload: { cr_syncsource: 'dynamics' } };
      const result = shouldSkip(event, 'dynamics');
      expect(result.skip).toBe(true);
      expect(result.reason).toMatch(/dynamics/i);
    });

    it('is case-insensitive (MARKETO matches marketo)', () => {
      const event = { payload: { syncSource: 'MARKETO' } };
      expect(shouldSkip(event, 'marketo').skip).toBe(true);
    });

    it('ignores leading/trailing whitespace in syncSource', () => {
      const event = { payload: { syncSource: '  dynamics  ' } };
      expect(shouldSkip(event, 'dynamics').skip).toBe(true);
    });
  });

  // ── Nested attributes (Dynamics OData style) ──────────────────────────────
  describe('reads from nested attributes field', () => {
    it('detects loop via attributes.syncSource', () => {
      const event = { payload: { attributes: { syncSource: 'marketo' } } };
      expect(shouldSkip(event, 'marketo').skip).toBe(true);
    });

    it('detects loop via attributes.cr_syncsource', () => {
      const event = { payload: { attributes: { cr_syncsource: 'dynamics' } } };
      expect(shouldSkip(event, 'dynamics').skip).toBe(true);
    });

    it('passes through safely via attributes when source differs', () => {
      const event = { payload: { attributes: { cr_syncsource: 'dynamics' } } };
      expect(shouldSkip(event, 'marketo')).toEqual({ skip: false });
    });
  });

  // ── Event is the payload itself (no wrapper) ──────────────────────────────
  it('works when event object IS the payload (no .payload wrapper)', () => {
    const event = { syncSource: 'marketo' };
    expect(shouldSkip(event, 'marketo').skip).toBe(true);
  });
});
