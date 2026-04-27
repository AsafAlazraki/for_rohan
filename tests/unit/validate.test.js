'use strict';

const crypto = require('crypto');
const { validateSignature, validateDynamicsSignature, validateMarketoSignature } = require('../../src/listeners/validate');

const SECRET  = 'super-secret-key';
const BODY    = Buffer.from('{"id":"123","type":"contact"}');

function makeSignature(secret, body) {
  const hex = crypto.createHmac('sha256', secret).update(body).digest('hex');
  return `sha256=${hex}`;
}

// ── validateSignature ─────────────────────────────────────────────────────────
describe('validateSignature()', () => {
  it('returns true for a correct signature', () => {
    const sig = makeSignature(SECRET, BODY);
    expect(validateSignature(SECRET, BODY, sig)).toBe(true);
  });

  it('returns false when the signature is incorrect', () => {
    const sig = makeSignature('wrong-secret', BODY);
    expect(validateSignature(SECRET, BODY, sig)).toBe(false);
  });

  it('returns false when the body is tampered', () => {
    const sig = makeSignature(SECRET, BODY);
    const tampered = Buffer.from('{"id":"999","type":"contact"}');
    expect(validateSignature(SECRET, tampered, sig)).toBe(false);
  });

  it('returns false when signatureHeader is undefined', () => {
    expect(validateSignature(SECRET, BODY, undefined)).toBe(false);
  });

  it('returns false when signatureHeader is empty string', () => {
    expect(validateSignature(SECRET, BODY, '')).toBe(false);
  });

  it('returns false when prefix is not "sha256"', () => {
    const hex = crypto.createHmac('sha256', SECRET).update(BODY).digest('hex');
    expect(validateSignature(SECRET, BODY, `sha512=${hex}`)).toBe(false);
  });

  it('returns false when there is no "=" separator', () => {
    expect(validateSignature(SECRET, BODY, 'invalidsignature')).toBe(false);
  });

  it('returns false when the hex part is empty', () => {
    expect(validateSignature(SECRET, BODY, 'sha256=')).toBe(false);
  });

  it('works with a string body as well as a Buffer', () => {
    const strBody = BODY.toString('utf8');
    const sig = makeSignature(SECRET, strBody);
    expect(validateSignature(SECRET, strBody, sig)).toBe(true);
  });
});

// ── validateDynamicsSignature ─────────────────────────────────────────────────
describe('validateDynamicsSignature()', () => {
  beforeEach(() => {
    process.env.DYNAMICS_WEBHOOK_SECRET = SECRET;
  });
  afterEach(() => {
    delete process.env.DYNAMICS_WEBHOOK_SECRET;
  });

  it('returns true when x-dynamics-signature is valid', () => {
    const sig = makeSignature(SECRET, BODY);
    const req = { headers: { 'x-dynamics-signature': sig } };
    expect(validateDynamicsSignature(BODY, req)).toBe(true);
  });

  it('returns false when x-dynamics-signature is missing', () => {
    const req = { headers: {} };
    expect(validateDynamicsSignature(BODY, req)).toBe(false);
  });

  it('returns false when signature is wrong', () => {
    const sig = makeSignature('wrong', BODY);
    const req = { headers: { 'x-dynamics-signature': sig } };
    expect(validateDynamicsSignature(BODY, req)).toBe(false);
  });

  it('throws when DYNAMICS_WEBHOOK_SECRET env var is missing', () => {
    delete process.env.DYNAMICS_WEBHOOK_SECRET;
    const req = { headers: {} };
    expect(() => validateDynamicsSignature(BODY, req)).toThrow('DYNAMICS_WEBHOOK_SECRET');
  });
});

// ── validateMarketoSignature ──────────────────────────────────────────────────
describe('validateMarketoSignature()', () => {
  beforeEach(() => {
    process.env.MARKETO_WEBHOOK_SECRET = SECRET;
  });
  afterEach(() => {
    delete process.env.MARKETO_WEBHOOK_SECRET;
  });

  it('returns true when x-marketo-signature is valid', () => {
    const sig = makeSignature(SECRET, BODY);
    const req = { headers: { 'x-marketo-signature': sig } };
    expect(validateMarketoSignature(BODY, req)).toBe(true);
  });

  it('returns false when x-marketo-signature is missing', () => {
    const req = { headers: {} };
    expect(validateMarketoSignature(BODY, req)).toBe(false);
  });

  it('throws when MARKETO_WEBHOOK_SECRET env var is missing', () => {
    delete process.env.MARKETO_WEBHOOK_SECRET;
    const req = { headers: {} };
    expect(() => validateMarketoSignature(BODY, req)).toThrow('MARKETO_WEBHOOK_SECRET');
  });
});
