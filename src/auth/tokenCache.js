'use strict';

/**
 * In-memory token cache with automatic expiry awareness.
 * Considers a token expired 60 seconds before its actual expiry
 * to avoid races at the boundary.
 */
class TokenCache {
  constructor(name) {
    this._name = name;
    this._token = null;
    this._expiry = 0; // epoch ms
  }

  /**
   * Returns true if the cached token exists and is not within the
   * 60-second pre-expiry window.
   */
  isValid() {
    return Boolean(this._token) && Date.now() < this._expiry - 60_000;
  }

  /**
   * Store a new token.
   * @param {string} token
   * @param {number} expiresInSeconds - lifetime reported by the auth server
   */
  set(token, expiresInSeconds) {
    if (!token) throw new Error(`[TokenCache:${this._name}] Cannot cache an empty token`);
    if (!expiresInSeconds || expiresInSeconds <= 0) {
      throw new Error(`[TokenCache:${this._name}] Invalid expiresIn: ${expiresInSeconds}`);
    }
    this._token = token;
    this._expiry = Date.now() + expiresInSeconds * 1000;
  }

  /** Return the cached token (may be null). */
  get() {
    return this._token;
  }

  /** Invalidate the cache (e.g. after a 401 response). */
  clear() {
    this._token = null;
    this._expiry = 0;
  }
}

module.exports = TokenCache;
