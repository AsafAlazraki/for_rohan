'use strict';

jest.mock('../../src/config/loader', () => ({ getConfig: jest.fn() }));

const { getConfig } = require('../../src/config/loader');
const {
  getSyncDirection,
  shouldSkipByDirection,
  VALID,
  DEFAULT,
} = require('../../src/engine/syncDirection');

beforeEach(() => jest.clearAllMocks());

describe('getSyncDirection', () => {
  it('returns bidirectional when SYNC_DIRECTION is unset', async () => {
    getConfig.mockResolvedValueOnce(null);
    expect(await getSyncDirection()).toBe('bidirectional');
  });

  it('lowercases and trims valid values', async () => {
    getConfig.mockResolvedValueOnce(' DYNAMICS-TO-MARKETO ');
    expect(await getSyncDirection()).toBe('dynamics-to-marketo');
  });

  it('falls back to default on unknown value', async () => {
    getConfig.mockResolvedValueOnce('weird-value');
    expect(await getSyncDirection()).toBe('bidirectional');
  });
});

describe('shouldSkipByDirection', () => {
  it('bidirectional → never skips', () => {
    expect(shouldSkipByDirection('dynamics', 'bidirectional')).toEqual({ skip: false });
    expect(shouldSkipByDirection('marketo',  'bidirectional')).toEqual({ skip: false });
  });

  it('dynamics-to-marketo → skips marketo source', () => {
    const r = shouldSkipByDirection('marketo', 'dynamics-to-marketo');
    expect(r.skip).toBe(true);
    expect(r.reason).toMatch(/Dynamics → Marketo/);
  });

  it('dynamics-to-marketo → allows dynamics source', () => {
    expect(shouldSkipByDirection('dynamics', 'dynamics-to-marketo')).toEqual({ skip: false });
  });

  it('marketo-to-dynamics → skips dynamics source', () => {
    const r = shouldSkipByDirection('dynamics', 'marketo-to-dynamics');
    expect(r.skip).toBe(true);
    expect(r.reason).toMatch(/Marketo → Dynamics/);
  });

  it('marketo-to-dynamics → allows marketo source', () => {
    expect(shouldSkipByDirection('marketo', 'marketo-to-dynamics')).toEqual({ skip: false });
  });

  it('treats unknown direction as bidirectional', () => {
    expect(shouldSkipByDirection('marketo', 'gibberish')).toEqual({ skip: false });
  });

  it('handles undefined source by treating as empty/non-matching', () => {
    const r = shouldSkipByDirection(undefined, 'dynamics-to-marketo');
    expect(r.skip).toBe(true);
  });
});

describe('exports', () => {
  it('VALID contains all 3 modes', () => {
    expect(VALID.has('bidirectional')).toBe(true);
    expect(VALID.has('dynamics-to-marketo')).toBe(true);
    expect(VALID.has('marketo-to-dynamics')).toBe(true);
  });

  it('DEFAULT is bidirectional', () => {
    expect(DEFAULT).toBe('bidirectional');
  });
});
