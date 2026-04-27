'use strict';

const TokenCache = require('../../src/auth/tokenCache');

describe('TokenCache', () => {
  let cache;

  beforeEach(() => {
    cache = new TokenCache('test');
  });

  describe('initial state', () => {
    it('isValid() returns false when empty', () => {
      expect(cache.isValid()).toBe(false);
    });

    it('get() returns null when empty', () => {
      expect(cache.get()).toBeNull();
    });
  });

  describe('set()', () => {
    it('stores token and marks as valid for a long-lived token', () => {
      cache.set('tok-abc', 3600);
      expect(cache.isValid()).toBe(true);
      expect(cache.get()).toBe('tok-abc');
    });

    it('throws on empty token', () => {
      expect(() => cache.set('', 3600)).toThrow('Cannot cache an empty token');
    });

    it('throws on zero expiresIn', () => {
      expect(() => cache.set('tok', 0)).toThrow('Invalid expiresIn');
    });

    it('throws on negative expiresIn', () => {
      expect(() => cache.set('tok', -1)).toThrow('Invalid expiresIn');
    });
  });

  describe('isValid() expiry logic', () => {
    it('returns false when token expires within the 60-second buffer', () => {
      // Expires in 30 seconds → within the 60s buffer → not valid
      cache.set('tok-short', 30);
      expect(cache.isValid()).toBe(false);
    });

    it('returns false when token expires in exactly 60 seconds', () => {
      cache.set('tok-boundary', 60);
      expect(cache.isValid()).toBe(false);
    });

    it('returns true when token expires in 61+ seconds', () => {
      cache.set('tok-long', 120);
      expect(cache.isValid()).toBe(true);
    });

    it('returns false after clear()', () => {
      cache.set('tok', 3600);
      cache.clear();
      expect(cache.isValid()).toBe(false);
      expect(cache.get()).toBeNull();
    });
  });

  describe('cache hit — no re-fetch needed', () => {
    it('get() returns the same token after multiple isValid() calls', () => {
      cache.set('tok-xyz', 3600);
      expect(cache.isValid()).toBe(true);
      expect(cache.isValid()).toBe(true); // idempotent
      expect(cache.get()).toBe('tok-xyz');
    });

    it('second set() overwrites the first', () => {
      cache.set('tok-v1', 3600);
      cache.set('tok-v2', 7200);
      expect(cache.get()).toBe('tok-v2');
    });
  });
});
