'use strict';

const crypto = require('crypto');

/**
 * Validate an HMAC-SHA256 webhook signature.
 *
 * Expected header format: `sha256=<lowercase_hex_digest>`
 * Uses timing-safe comparison to prevent timing attacks.
 *
 * @param {string}          secret          - Shared secret
 * @param {Buffer|string}   rawBody         - Raw request body (Buffer preferred)
 * @param {string|undefined} signatureHeader - Value of the signature header
 * @returns {boolean}
 */
function validateSignature(secret, rawBody, signatureHeader) {
  if (!signatureHeader) return false;

  const eqIdx = signatureHeader.indexOf('=');
  if (eqIdx === -1) return false;

  const prefix      = signatureHeader.slice(0, eqIdx);
  const receivedHex = signatureHeader.slice(eqIdx + 1);

  if (prefix !== 'sha256' || !receivedHex) return false;

  const computed   = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const computedBuf  = Buffer.from(computed, 'hex');
  const receivedBuf  = Buffer.from(receivedHex, 'hex');

  // Lengths must match before timingSafeEqual (it throws on mismatch)
  if (computedBuf.length !== receivedBuf.length) return false;

  return crypto.timingSafeEqual(computedBuf, receivedBuf);
}

/**
 * Validate the signature on an inbound Dynamics webhook request.
 * Reads secret from DYNAMICS_WEBHOOK_SECRET env var.
 * Signature is expected in the `x-dynamics-signature` header.
 */
function validateDynamicsSignature(rawBody, req) {
  const secret = process.env.DYNAMICS_WEBHOOK_SECRET;
  if (!secret) throw new Error('[validate] DYNAMICS_WEBHOOK_SECRET is not set');
  return validateSignature(secret, rawBody, req.headers['x-dynamics-signature']);
}

/**
 * Validate the signature on an inbound Marketo webhook request.
 * Reads secret from MARKETO_WEBHOOK_SECRET env var.
 * Signature is expected in the `x-marketo-signature` header.
 */
function validateMarketoSignature(rawBody, req) {
  const secret = process.env.MARKETO_WEBHOOK_SECRET;
  if (!secret) throw new Error('[validate] MARKETO_WEBHOOK_SECRET is not set');
  return validateSignature(secret, rawBody, req.headers['x-marketo-signature']);
}

module.exports = { validateSignature, validateDynamicsSignature, validateMarketoSignature };
