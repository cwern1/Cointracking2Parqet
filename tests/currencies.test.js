import { describe, it, afterEach } from 'node:test';
import { expect, vi } from './helpers/expect.js';
import { PARQET_CURRENCIES } from '../public/app/core/currencies.js';
import { spec } from './fakes/openapi.js';
describe('currencies', () => {
    it('match the currency enum in the Parqet OpenAPI spec', () => {
        const text = JSON.stringify(spec);
        const m = /"currency":\{"type":"string","enum":(\[[^\]]+\])/.exec(text);
        expect(m).not.toBeNull();
        expect([...PARQET_CURRENCIES]).toEqual(JSON.parse(m[1]));
    });
});
