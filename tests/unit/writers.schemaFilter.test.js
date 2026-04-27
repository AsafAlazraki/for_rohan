'use strict';

/**
 * Unit-level proof of the lead-schema auto-filter in writers/marketo.js.
 *
 * The filter exists so a Lead push doesn't fail with Marketo error 1006
 * (`Field 'X' not found`) when the operator hasn't yet created custom
 * fields on the Marketo side. Behaviour:
 *   - Fetch /leads/describe.json once per process (1h cache).
 *   - Drop any payload key NOT in the schema.
 *   - WARN once per dropped field.
 *   - If schema fetch fails → don't filter (fail open, not closed).
 */

jest.mock('axios', () => ({ get: jest.fn(), post: jest.fn() }));

const axios = require('axios');
const {
  writeToMarketo,
  _resetLeadSchemaCache,
} = require('../../src/writers/marketo');

beforeEach(() => {
  jest.clearAllMocks();
  _resetLeadSchemaCache();
  process.env.MARKETO_BASE_URL = 'https://test.mktorest.com';
});
afterEach(() => {
  delete process.env.MARKETO_BASE_URL;
});

function schemaResponse(...names) {
  return {
    data: { success: true, result: names.map(n => ({ rest: { name: n } })) },
  };
}

it('drops payload keys NOT in the Marketo lead schema; keeps the ones that are', async () => {
  axios.get.mockResolvedValueOnce(schemaResponse('email', 'firstName', 'company'));
  axios.post.mockResolvedValueOnce({
    data: { success: true, result: [{ id: 42, status: 'created' }] },
  });

  await writeToMarketo({
    email:         'a@b.com',
    firstName:     'Alice',
    company:       'Acme',
    crmEntityType: 'contact', // NOT in schema → must be stripped
    crmContactId:  'c-1',     // NOT in schema → must be stripped
    industry:      'Tech',    // NOT in schema → must be stripped
  }, 'tok');

  const [, body] = axios.post.mock.calls[0];
  const sent = body.input[0];
  expect(sent).toEqual({
    email:     'a@b.com',
    firstName: 'Alice',
    company:   'Acme',
  });
  expect(sent).not.toHaveProperty('crmEntityType');
  expect(sent).not.toHaveProperty('crmContactId');
  expect(sent).not.toHaveProperty('industry');
});

it('keeps every payload key when ALL of them are in the schema', async () => {
  axios.get.mockResolvedValueOnce(
    schemaResponse('email', 'firstName', 'company', 'crmEntityType', 'crmContactId', 'industry'),
  );
  axios.post.mockResolvedValueOnce({
    data: { success: true, result: [{ id: 42, status: 'created' }] },
  });

  await writeToMarketo({
    email:         'a@b.com',
    firstName:     'Alice',
    company:       'Acme',
    crmEntityType: 'contact',
    crmContactId:  'c-1',
    industry:      'Tech',
  }, 'tok');

  const sent = axios.post.mock.calls[0][1].input[0];
  expect(sent).toMatchObject({
    email:         'a@b.com',
    firstName:     'Alice',
    company:       'Acme',
    crmEntityType: 'contact',
    crmContactId:  'c-1',
    industry:      'Tech',
  });
});

it('FAIL OPEN — if schema fetch fails, the payload is sent unchanged', async () => {
  axios.get.mockRejectedValueOnce(Object.assign(new Error('describe down'), {
    response: { status: 500 },
  }));
  axios.post.mockResolvedValueOnce({
    data: { success: true, result: [{ id: 42, status: 'created' }] },
  });

  await writeToMarketo({
    email:         'a@b.com',
    firstName:     'Alice',
    crmEntityType: 'contact',
  }, 'tok');

  const sent = axios.post.mock.calls[0][1].input[0];
  expect(sent).toMatchObject({
    email:         'a@b.com',
    firstName:     'Alice',
    crmEntityType: 'contact',
  });
});

it('caches the schema across calls — only one /leads/describe.json fetch in a burst', async () => {
  axios.get.mockResolvedValue(schemaResponse('email', 'firstName'));
  axios.post.mockResolvedValue({
    data: { success: true, result: [{ id: 1, status: 'created' }] },
  });

  await writeToMarketo({ email: 'a@b.com', firstName: 'A' }, 'tok');
  await writeToMarketo({ email: 'b@c.com', firstName: 'B' }, 'tok');
  await writeToMarketo({ email: 'c@d.com', firstName: 'C' }, 'tok');

  const describeCalls = axios.get.mock.calls.filter(
    ([url]) => /\/leads\/describe\.json/.test(url),
  );
  expect(describeCalls.length).toBe(1);
});

it('emits the WARN once per missing field across multiple pushes (deduped)', async () => {
  // Capture the logger to assert the warn is fired only once for the same key.
  const logger = require('../../src/audit/logger');
  const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});

  axios.get.mockResolvedValueOnce(schemaResponse('email', 'firstName'));
  axios.post.mockResolvedValue({
    data: { success: true, result: [{ id: 1, status: 'created' }] },
  });

  await writeToMarketo({ email: 'a', firstName: 'A', crmEntityType: 'contact' }, 't');
  await writeToMarketo({ email: 'b', firstName: 'B', crmEntityType: 'contact' }, 't');
  await writeToMarketo({ email: 'c', firstName: 'C', crmEntityType: 'contact', crmContactId: 'cc' }, 't');

  // crmEntityType warn fires once across three calls; crmContactId warn
  // fires once on the third call. So 2 distinct warns total for unknown
  // fields. Other warns from unrelated paths may exist; just check the
  // unknown-field ones are deduped.
  const unknownFieldWarns = warnSpy.mock.calls.filter(
    ([first]) => first && first.field,
  );
  expect(unknownFieldWarns.length).toBe(2);
  expect(unknownFieldWarns.map(c => c[0].field).sort()).toEqual(['crmContactId', 'crmEntityType']);

  warnSpy.mockRestore();
});
