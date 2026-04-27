'use strict';

const {
  normalizeDynamicsWebhookPayload,
  isRemoteExecutionContext,
} = require('../../src/listeners/dynamicsPayload');

describe('isRemoteExecutionContext', () => {
  it('returns false for non-objects', () => {
    expect(isRemoteExecutionContext(null)).toBe(false);
    expect(isRemoteExecutionContext(undefined)).toBe(false);
    expect(isRemoteExecutionContext('hello')).toBe(false);
    expect(isRemoteExecutionContext(42)).toBe(false);
  });

  it('returns false when MessageName missing', () => {
    expect(isRemoteExecutionContext({ InputParameters: {} })).toBe(false);
  });

  it('returns false when InputParameters missing', () => {
    expect(isRemoteExecutionContext({ MessageName: 'Update' })).toBe(false);
  });

  it('returns true with both fields', () => {
    expect(isRemoteExecutionContext({ MessageName: 'Update', InputParameters: [] })).toBe(true);
  });
});

describe('normalizeDynamicsWebhookPayload — pass-through', () => {
  it('returns non-context payloads unchanged', () => {
    const p = { contactid: 'c1', emailaddress1: 'a@b.com' };
    expect(normalizeDynamicsWebhookPayload(p)).toBe(p);
  });

  it('returns null/undefined unchanged', () => {
    expect(normalizeDynamicsWebhookPayload(null)).toBe(null);
    expect(normalizeDynamicsWebhookPayload(undefined)).toBe(undefined);
  });
});

describe('normalizeDynamicsWebhookPayload — array form (DataContractSerializer)', () => {
  it('flattens entity from PostEntityImages array', () => {
    const out = normalizeDynamicsWebhookPayload({
      MessageName:       'Update',
      PrimaryEntityName: 'contact',
      PrimaryEntityId:   'c-guid',
      InputParameters:   [],
      PostEntityImages:  [{
        Key:   'PostImage',
        Value: {
          Attributes: [
            { Key: 'firstname', Value: 'Jane' },
            { Key: 'emailaddress1', Value: 'j@e.com' },
          ],
        },
      }],
    });
    expect(out.firstname).toBe('Jane');
    expect(out.emailaddress1).toBe('j@e.com');
    expect(out.type).toBe('contact');
  });

  it('falls back to InputParameters.Target when PostEntityImages absent', () => {
    const out = normalizeDynamicsWebhookPayload({
      MessageName:       'Create',
      PrimaryEntityName: 'lead',
      PrimaryEntityId:   'l-guid',
      InputParameters:   [{
        Key:   'Target',
        Value: { Attributes: [{ Key: 'lastname', Value: 'Doe' }] },
      }],
    });
    expect(out.lastname).toBe('Doe');
    expect(out.type).toBe('lead');
    expect(out.leadid).toBe('l-guid');
  });

  it('falls back to PreEntityImages when neither Post nor Target has attributes', () => {
    const out = normalizeDynamicsWebhookPayload({
      MessageName:       'Delete',
      PrimaryEntityName: 'account',
      PrimaryEntityId:   'a-guid',
      InputParameters:   [],
      PreEntityImages:   [{
        Key:   'PreImage',
        Value: { Attributes: [{ Key: 'name', Value: 'Acme' }] },
      }],
    });
    expect(out.name).toBe('Acme');
    expect(out.type).toBe('account');
    expect(out.accountid).toBe('a-guid');
  });

  it('unwraps EntityReference attribute as _<field>_value', () => {
    const out = normalizeDynamicsWebhookPayload({
      MessageName:       'Update',
      PrimaryEntityName: 'contact',
      PrimaryEntityId:   'c1',
      InputParameters:   [{
        Key:   'Target',
        Value: {
          Attributes: [
            { Key: 'parentcustomerid', Value: { LogicalName: 'account', Id: 'acc-1' } },
          ],
        },
      }],
    });
    expect(out._parentcustomerid_value).toBe('acc-1');
    expect(out.parentcustomerid).toBeUndefined();
  });

  it('unwraps OptionSetValue / Money to scalar', () => {
    const out = normalizeDynamicsWebhookPayload({
      MessageName:       'Update',
      PrimaryEntityName: 'lead',
      PrimaryEntityId:   'l1',
      InputParameters:   [{
        Key:   'Target',
        Value: {
          Attributes: [
            { Key: 'leadsourcecode', Value: { Value: 100000001 } },
          ],
        },
      }],
    });
    expect(out.leadsourcecode).toBe(100000001);
  });

  it('flattens FormattedValues with _label suffix', () => {
    const out = normalizeDynamicsWebhookPayload({
      MessageName:       'Update',
      PrimaryEntityName: 'contact',
      PrimaryEntityId:   'c1',
      InputParameters:   [{
        Key:   'Target',
        Value: {
          Attributes:      [{ Key: 'gendercode', Value: 1 }],
          FormattedValues: [{ Key: 'gendercode', Value: 'Male' }],
        },
      }],
    });
    expect(out.gendercode).toBe(1);
    expect(out.gendercode_label).toBe('Male');
  });
});

describe('normalizeDynamicsWebhookPayload — object form (Dapr-flattened)', () => {
  it('handles plain-object PostEntityImages and Attributes', () => {
    const out = normalizeDynamicsWebhookPayload({
      MessageName:       'Update',
      PrimaryEntityName: 'contact',
      PrimaryEntityId:   'c-9',
      InputParameters:   {},
      PostEntityImages:  {
        PostImage: {
          attributes:      { firstname: 'Carol', mobilephone: '555' },
          formattedValues: { mobilephone: '5-5-5' },
        },
      },
    });
    expect(out.firstname).toBe('Carol');
    expect(out.mobilephone).toBe('555');
    expect(out.mobilephone_label).toBe('5-5-5');
    expect(out.contactid).toBe('c-9');
  });

  it('keeps existing id field if attributes provide one', () => {
    const out = normalizeDynamicsWebhookPayload({
      MessageName:       'Update',
      PrimaryEntityName: 'contact',
      PrimaryEntityId:   'fallback',
      InputParameters:   [],
      PostEntityImages:  [{
        Key: 'p', Value: { Attributes: [{ Key: 'contactid', Value: 'attr-id' }] },
      }],
    });
    expect(out.contactid).toBe('attr-id');
  });
});

describe('normalizeDynamicsWebhookPayload — edge cases', () => {
  it('returns object with only type when no entity image is present', () => {
    const out = normalizeDynamicsWebhookPayload({
      MessageName:       'Update',
      PrimaryEntityName: 'contact',
      InputParameters:   [],
    });
    expect(out).toEqual({ type: 'contact' });
  });

  it('skips array entries with missing keys', () => {
    const out = normalizeDynamicsWebhookPayload({
      MessageName:       'Update',
      PrimaryEntityName: 'lead',
      PrimaryEntityId:   'l1',
      InputParameters:   [{
        Key:   'Target',
        Value: {
          Attributes: [{ Key: null, Value: 'x' }, { Key: 'firstname', Value: 'OK' }],
        },
      }],
    });
    expect(out.firstname).toBe('OK');
  });

  it('skips toMap entries that are null/falsy', () => {
    const out = normalizeDynamicsWebhookPayload({
      MessageName:       'Update',
      PrimaryEntityName: 'contact',
      PrimaryEntityId:   'c1',
      InputParameters:   [null, { Key: 'Target', Value: { Attributes: [{ Key: 'firstname', Value: 'X' }] } }],
    });
    expect(out.firstname).toBe('X');
  });

  it('handles empty primaryEntityName (no type set, no id mapped)', () => {
    const out = normalizeDynamicsWebhookPayload({
      MessageName:     'Create',
      InputParameters: [{ Key: 'Target', Value: { Attributes: [{ Key: 'foo', Value: 'bar' }] } }],
    });
    expect(out.foo).toBe('bar');
    expect(out.type).toBeUndefined();
  });

  it('skips id stamp if PrimaryEntityId not provided', () => {
    const out = normalizeDynamicsWebhookPayload({
      MessageName:       'Update',
      PrimaryEntityName: 'contact',
      InputParameters:   [{ Key: 'Target', Value: { Attributes: [{ Key: 'firstname', Value: 'A' }] } }],
    });
    expect(out.contactid).toBeUndefined();
  });

  it('toMap returns null for non-object/non-array values', () => {
    const out = normalizeDynamicsWebhookPayload({
      MessageName:       'Update',
      PrimaryEntityName: 'contact',
      PrimaryEntityId:   'c1',
      PostEntityImages:  'not-a-collection',
      InputParameters:   [{ Key: 'Target', Value: { Attributes: [{ Key: 'firstname', Value: 'F' }] } }],
    });
    expect(out.firstname).toBe('F');
  });

  it('toMap accepts kv objects with lowercase key/value', () => {
    const out = normalizeDynamicsWebhookPayload({
      MessageName:       'Update',
      PrimaryEntityName: 'contact',
      PrimaryEntityId:   'c1',
      InputParameters:   [{ key: 'Target', value: { attributes: [{ key: 'firstname', value: 'L' }] } }],
    });
    expect(out.firstname).toBe('L');
  });
});
