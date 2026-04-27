'use strict';

const axios = require('axios');
const TokenCache = require('./tokenCache');
const { getConfig } = require('../config/loader');

const cache = new TokenCache('marketo');

async function requireConfig(name) {
  const val = await getConfig(name);
  if (!val) throw new Error(`[auth/marketo] Missing required config: ${name}`);
  return val;
}

/**
 * Obtain a bearer token from the Marketo identity endpoint using
 * the client_credentials flow.
 * Returns a cached token if it is still valid.
 *
 * Credentials are pulled from admin_config (with 60 s cache) and
 * fall through to process.env if not present in DB.
 *
 * @returns {Promise<string>} access_token
 */
async function getMarketoToken() {
  if (cache.isValid()) return cache.get();

  const baseUrl      = await requireConfig('MARKETO_BASE_URL');
  const clientId     = await requireConfig('MARKETO_CLIENT_ID');
  const clientSecret = await requireConfig('MARKETO_CLIENT_SECRET');

  const { data } = await axios.get(`${baseUrl}/identity/oauth/token`, {
    params: {
      grant_type:    'client_credentials',
      client_id:     clientId,
      client_secret: clientSecret,
    },
  });

  if (data.error) {
    throw new Error(
      `[auth/marketo] Auth error: ${data.error} — ${data.error_description || '(no description)'}`,
    );
  }

  if (!data.access_token) {
    throw new Error(`[auth/marketo] No access_token in response (status: ${data.error || 'unknown'})`);
  }

  cache.set(data.access_token, data.expires_in);
  return data.access_token;
}

module.exports = { getMarketoToken, _cache: cache };
