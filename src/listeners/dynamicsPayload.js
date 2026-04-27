'use strict';

// Unwraps a Dataverse RemoteExecutionContext webhook body (MessageName +
// InputParameters at the top level) into a flat entity object matching the
// shape readers/dynamics.js produces, so the worker can read fields like
// emailaddress1 directly. Returns non-context payloads unchanged.

const ENTITY_ID_FIELD = {
  contact: 'contactid',
  lead:    'leadid',
  account: 'accountid',
};

function isRemoteExecutionContext(p) {
  return !!(p
    && typeof p === 'object'
    && typeof p.MessageName === 'string'
    && p.InputParameters);
}

// Dataverse serializes ParameterCollection / EntityImageCollection as an
// array of { Key, Value } pairs (DataContractSerializer default). Some Dapr
// wrappers re-emit them as plain objects. Accept both.
function toMap(collectionLike) {
  if (!collectionLike) return null;
  if (Array.isArray(collectionLike)) {
    const out = {};
    for (const kv of collectionLike) {
      if (!kv) continue;
      const k = kv.Key != null ? kv.Key : kv.key;
      const v = kv.Value !== undefined ? kv.Value : kv.value;
      if (k != null) out[k] = v;
    }
    return out;
  }
  if (typeof collectionLike === 'object') return collectionLike;
  return null;
}

function hasAttributes(e) {
  return !!(e && (e.Attributes || e.attributes));
}

function findEntity(ctx) {
  const post = toMap(ctx.PostEntityImages);
  if (post) {
    for (const v of Object.values(post)) {
      if (hasAttributes(v)) return v;
    }
  }
  const inputs = toMap(ctx.InputParameters);
  const target = inputs && inputs.Target;
  if (hasAttributes(target)) return target;
  const pre = toMap(ctx.PreEntityImages);
  if (pre) {
    for (const v of Object.values(pre)) {
      if (hasAttributes(v)) return v;
    }
  }
  return null;
}

function flattenAttributes(attrs, out) {
  if (!attrs) return;
  const pairs = Array.isArray(attrs)
    ? attrs.map(kv => [kv.Key != null ? kv.Key : kv.key, kv.Value !== undefined ? kv.Value : kv.value])
    : Object.entries(attrs);
  for (const [k, raw] of pairs) {
    if (!k) continue;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      // EntityReference → surface as _<field>_value (matches readDynamics shape)
      if ('LogicalName' in raw && 'Id' in raw) {
        out[`_${k}_value`] = raw.Id;
        continue;
      }
      // OptionSetValue / Money → unwrap to the scalar
      if ('Value' in raw && typeof raw.Value !== 'object') {
        out[k] = raw.Value;
        continue;
      }
    }
    out[k] = raw;
  }
}

function flattenFormattedValues(fvs, out) {
  if (!fvs) return;
  const pairs = Array.isArray(fvs)
    ? fvs.map(kv => [kv.Key != null ? kv.Key : kv.key, kv.Value !== undefined ? kv.Value : kv.value])
    : Object.entries(fvs);
  for (const [k, v] of pairs) {
    if (!k) continue;
    out[`${k}_label`] = v;
  }
}

function normalizeDynamicsWebhookPayload(payload) {
  if (!isRemoteExecutionContext(payload)) return payload;

  const entity = findEntity(payload);
  const flat = {};
  if (entity) {
    flattenAttributes(entity.Attributes || entity.attributes, flat);
    flattenFormattedValues(entity.FormattedValues || entity.formattedValues, flat);
  }

  const primaryName = String(payload.PrimaryEntityName || '').toLowerCase();
  if (primaryName) flat.type = primaryName;
  const idField = ENTITY_ID_FIELD[primaryName];
  if (idField && !flat[idField] && payload.PrimaryEntityId) {
    flat[idField] = payload.PrimaryEntityId;
  }

  return flat;
}

module.exports = { normalizeDynamicsWebhookPayload, isRemoteExecutionContext };
