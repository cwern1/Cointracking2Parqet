import { describe, it, afterEach } from 'node:test';
import { expect, vi } from './helpers/expect.js';
import { parseLedger, parseTrades } from '../public/app/core/cointracking.js';
import { DEFAULT_OPTIONS, mapTrades, PriceBook } from '../public/app/core/mapping.js';
import { buildPlan } from '../public/app/core/plan.js';
import { ledgerResponse, SAMPLE, tradesResponse } from './fakes/fakeCoinTracking.js';
const mapAll = (fixtures = SAMPLE) => mapTrades(parseTrades(tradesResponse(fixtures)), new PriceBook('EUR', parseLedger(ledgerResponse(fixtures)).rows), {
    ...DEFAULT_OPTIONS,
    accountCurrency: 'EUR',
});
let n = 0;
const asExisting = (a) => ({
    id: `x${++n}`, externalId: a.externalId, type: a.type, symbol: a.symbol, shares: a.shares, datetime: a.datetime,
});
describe('sync plan', () => {
    it('creates everything on an empty portfolio, oldest first', () => {
        const plan = buildPlan(mapAll(), []);
        expect(plan.counts).toMatchObject({ new: 7, skipped: 4, changed: 0, unchanged: 0, orphaned: 0 });
        const times = plan.create.map((a) => a.datetime);
        expect(times).toEqual([...times].sort());
    });
    it('does nothing when everything is already there', () => {
        const mapped = mapAll();
        const existing = mapped.flatMap((m) => m.activities).map(asExisting);
        const plan = buildPlan(mapped, existing);
        expect(plan.create).toEqual([]);
        expect(plan.deleteChanged).toEqual([]);
        expect(plan.counts.unchanged).toBe(7);
    });
    it('replaces the activities of a changed transaction', () => {
        const existing = mapAll().flatMap((m) => m.activities).map(asExisting);
        const edited = SAMPLE.map((t) => (t.id === '1002' ? { ...t, buy: [12, 'ETH'] } : t));
        const plan = buildPlan(mapAll(edited), existing);
        expect(plan.counts.changed).toBe(1);
        expect(plan.create).toHaveLength(2);
        expect(plan.deleteChanged).toHaveLength(2);
    });
    it('reports transactions deleted in CoinTracking and ignores activities it did not create', () => {
        const existing = [
            ...mapAll().flatMap((m) => m.activities).map(asExisting),
            { id: 'manual', type: 'buy', symbol: 'BTC', shares: 1, datetime: '2020-01-01T00:00:00.000Z' },
            { id: 'other', externalId: 'bitpanda-123', type: 'buy', symbol: 'BTC', shares: 1, datetime: '2020-01-01T00:00:00.000Z' },
        ];
        const plan = buildPlan(mapAll(SAMPLE.filter((t) => t.id !== '1001')), existing);
        expect(plan.orphaned.map((a) => a.externalId?.split('-')[1])).toEqual(['1001']);
    });
});
