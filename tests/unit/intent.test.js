'use strict';

const { INTENT } = require('../../src/engine/intent');

describe('INTENT constants', () => {
  it('exposes the four spec-driven intent values', () => {
    expect(INTENT).toEqual({
      GLOBAL_UNSUBSCRIBE: 'global_unsubscribe',
      NEW_LEAD:           'new_lead',
      CRM_TO_MARKETO:     'crm_to_marketo',
      UNAUTHORIZED:       'unauthorized',
    });
  });

  it('is frozen — values cannot be reassigned', () => {
    expect(Object.isFrozen(INTENT)).toBe(true);
    expect(() => {
      'use strict';
      INTENT.GLOBAL_UNSUBSCRIBE = 'mutated';
    }).toThrow(TypeError);
  });

  it('is frozen — keys cannot be added', () => {
    expect(() => {
      'use strict';
      INTENT.NEW_KEY = 'x';
    }).toThrow(TypeError);
  });
});
