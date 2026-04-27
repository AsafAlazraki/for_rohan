'use strict';

const axios = require('axios');
const TokenCache = require('./tokenCache');
const { getConfig } = require('../config/loader');

const cache = new TokenCache('dynamics');

async function requireConfig(name) {
  const val = await getConfig(name);
  if (!val) throw new Error(`[auth/dynamics] Missing required config: ${name}`);
  return val;
}

/**
 * Obtain a bearer token from Azure AD using the client_credentials flow.
 * Returns a cached token if it is still valid.
 *
 * Credentials are pulled from PostgreSQL admin_config (with 60 s cache) and
 * fall through to process.env when PostgreSQL is not configured.
 *
 * @returns {Promise<string>} access_token
 */
async function getDynamicsToken() {
  if (cache.isValid()) return cache.get();

  const tenantId     = await requireConfig('DYNAMICS_TENANT_ID');
  const clientId     = await requireConfig('DYNAMICS_CLIENT_ID');
  const clientSecret = await requireConfig('DYNAMICS_CLIENT_SECRET');
  const resourceUrl  = await requireConfig('DYNAMICS_RESOURCE_URL');

  const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;

  const body = new URLSearchParams({
    grant_type:    'client_credentials',
    client_id:     clientId,
    client_secret: clientSecret,
    scope:         `${resourceUrl}/.default`,
  });

  const { data } = await axios.post(tokenUrl, body.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  if (!data.access_token) {
    throw new Error(`[auth/dynamics] No access_token in response (status: ${data.error || 'unknown'})`);
  }

  cache.set(data.access_token, data.expires_in);
  return data.access_token;
}

module.exports = { getDynamicsToken, _cache: cache };
