import { describe, it, afterEach } from 'node:test';
import { expect, vi } from './helpers/expect.js';
import { formatSymbolMap, parseSymbolList, parseSymbolMap } from '../public/app/prefs.js';
describe('option parsing', () => {
    it('reads symbol maps in several notations and ignores junk', () => {
        expect(parseSymbolMap('iota=miota\nBTC2 -> BTC\nfoo\n  ETH2 → ETH ')).toEqual({ IOTA: 'MIOTA', BTC2: 'BTC', ETH2: 'ETH' });
        expect(parseSymbolMap(formatSymbolMap({ A: 'B', C: 'D' }))).toEqual({ A: 'B', C: 'D' });
    });
    it('reads skip lists', () => {
        expect(parseSymbolList(' foo, bar\nFOO  baz ')).toEqual(['FOO', 'BAR', 'BAZ']);
    });
});
