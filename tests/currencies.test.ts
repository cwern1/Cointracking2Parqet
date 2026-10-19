import { describe, expect, it } from 'vitest';
import { PARQET_CURRENCIES } from '../src/core/currencies';
import { spec } from './fakes/openapi';

describe('currencies', () => {
  it('match the currency enum in the Parqet OpenAPI spec', () => {
    const text = JSON.stringify(spec);
    const m = /"currency":\{"type":"string","enum":(\[[^\]]+\])/.exec(text);
    expect(m).not.toBeNull();
    expect([...PARQET_CURRENCIES]).toEqual(JSON.parse(m![1]!));
  });
});
