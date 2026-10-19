import { describe, it, afterEach } from 'node:test';
import { expect, vi } from './helpers/expect.js';
import { CoinTrackingClient } from '../public/app/core/cointracking.js';
import { DEFAULT_OPTIONS } from '../public/app/core/mapping.js';
import { ParqetAuthError, ParqetClient } from '../public/app/core/parqet.js';
import { compareBalances, executePlan, explainDifference, fetchSource, makePlan, ownActivities, SyncError } from '../public/app/core/sync.js';
import { FakeCoinTracking, SAMPLE } from './fakes/fakeCoinTracking.js';
import { FakeParqet } from './fakes/fakeParqet.js';
function setup() {
    const ct = new FakeCoinTracking();
    const parqet = new FakeParqet();
    const token = parqet.issueToken();
    const ctClient = new CoinTrackingClient({ key: ct.key, secret: ct.secret }, { fetch: ct.fetch() });
    const pq = new ParqetClient(async () => token, { fetch: parqet.fetch(), sleep: async () => { } });
    const run = async (removeOrphans = false, options = DEFAULT_OPTIONS) => {
        const source = await fetchSource(ctClient);
        const plan = makePlan(source, await pq.listCryptoActivities('pf_main'), options);
        const result = await executePlan(pq, 'pf_main', plan, { removeOrphans });
        return { plan, result };
    };
    return { ct, parqet, pq, run };
}
describe('full sync against the fakes', () => {
    it('imports, is idempotent, and follows changes and deletions', async () => {
        const { ct, parqet, run } = setup();
        const first = await run();
        expect(first.result).toMatchObject({ created: 8, deleted: 0, failures: [] });
        expect(parqet.activities.get('pf_main')).toHaveLength(8);
        const second = await run();
        expect(second.plan.create).toEqual([]);
        expect(second.plan.counts.unchanged).toBe(7);
        ct.trades = ct.trades.map((t) => (t.id === '1003' ? { ...t, buy: [0.2, 'ETH'] } : t));
        const third = await run();
        expect(third.result).toMatchObject({ created: 1, deleted: 1 });
        const staking = parqet.activities.get('pf_main').filter((a) => a.externalId?.startsWith('ct-1003-'));
        expect(staking.map((a) => a.shares)).toEqual([0.2]);
        ct.trades = ct.trades.filter((t) => t.id !== '1001');
        const kept = await run(false);
        expect(kept.plan.counts.orphaned).toBe(1);
        expect(kept.result.deleted).toBe(0);
        const removed = await run(true);
        expect(removed.result.deleted).toBe(1);
        expect(parqet.activities.get('pf_main').some((a) => a.externalId?.startsWith('ct-1001-'))).toBe(false);
        expect(ct.calls.filter((c) => c === 'getTrades')).toHaveLength(5);
    });
    it('counts created activities correctly even when Parqet does not list them', async () => {
        const { parqet, run } = setup();
        parqet.omitCreatedList = true;
        parqet.unknownSymbols.add('ADA');
        const { result } = await run();
        expect(result.created).toBe(7);
        expect(result.failures.map((f) => f.activity.symbol)).toEqual(['ADA']);
    });
    it('breaks a balance difference down by CoinTracking type', async () => {
        const { ct, run, pq } = setup();
        await run();
        const { parseTrades } = await import('../public/app/core/cointracking.js');
        const { tradesResponse } = await import('./fakes/fakeCoinTracking.js');
        const rows = explainDifference('ETH', parseTrades(tradesResponse(ct.trades)), await pq.listCryptoActivities('pf_main'), {});
        // Rows with a difference come first.
        expect(rows[0].label).toBe('Fees on Withdrawal');
        expect(rows).toHaveLength(4);
        expect(rows).toEqual(expect.arrayContaining([
            { label: 'Trade', coinTracking: 10, parqet: 10 },
            { label: 'Staking', coinTracking: 0.1, parqet: 0.1 },
            { label: 'Withdrawal', coinTracking: -1, parqet: -1 },
            // Informational in CoinTracking, not deducted in Parqet: expected with "Already in amounts".
            { label: 'Fees on Withdrawal', coinTracking: -0.002, parqet: 0 },
        ]));
    });
    it('deletes replaced activities although the live API only accepts bare ids', async () => {
        const { ct, parqet, run } = setup();
        parqet.deleteNeedsBareId = true;
        await run();
        ct.trades = ct.trades.map((t) => (t.id === '1003' ? { ...t, buy: [0.2, 'ETH'] } : t));
        const { result } = await run();
        expect(result).toMatchObject({ created: 1, deleted: 1, notDeleted: 0 });
        expect(parqet.activities.get('pf_main').filter((a) => a.externalId?.startsWith('ct-1003-'))).toHaveLength(1);
        expect((await run()).plan.deleteChanged).toHaveLength(0);
    });
    it('reports activities Parqet silently refused to delete', async () => {
        const { ct, parqet, pq, run } = setup();
        await run();
        const realDelete = pq.deleteActivities.bind(pq);
        pq.deleteActivities = async () => 0; // a server that ignores every id
        ct.trades = ct.trades.map((t) => (t.id === '1003' ? { ...t, buy: [0.2, 'ETH'] } : t));
        const { result } = await run();
        expect(result).toMatchObject({ created: 1, deleted: 0, notDeleted: 1 });
        pq.deleteActivities = realDelete;
        expect(parqet.activities.get('pf_main').filter((a) => a.externalId?.startsWith('ct-1003-'))).toHaveLength(2);
    });
    it('ignores one-satoshi rounding dust in the balance check', () => {
        const rows = compareBalances(new Map([['BTC', 0.00000001], ['ETH', -0.00000001], ['HEX', 1]]), [], {});
        expect(rows.map((r) => [r.symbol, r.difference])).toEqual([['BTC', 0], ['ETH', 0], ['HEX', -1]]);
    });
    it('keeps old activities when their replacement is rejected', async () => {
        const { ct, parqet, run } = setup();
        await run();
        parqet.unknownSymbols.add('ETH');
        ct.trades = ct.trades.map((t) => (t.id === '1003' ? { ...t, buy: [0.3, 'ETH'] } : t));
        const { result } = await run();
        expect(result.failures.map((f) => [f.activity.symbol, f.code])).toEqual([['ETH', 'asset_not_found']]);
        expect(result.keptBecauseOfFailure).toBe(1);
        expect(parqet.activities.get('pf_main').filter((a) => a.externalId?.startsWith('ct-1003-'))).toHaveLength(1);
    });
    it('pages through more activities than fit one response and batches large imports', async () => {
        const { ct, parqet, run, pq } = setup();
        parqet.pageSize = 37;
        const many = Array.from({ length: 250 }, (_, i) => ({
            id: String(5000 + i), type: 'Staking', buy: [0.01, 'DOT'], time: 1_700_000_000 + i, prices: { DOT: 5 },
        }));
        ct.trades = [...SAMPLE, ...many];
        const { result } = await run();
        expect(result.created).toBe(258);
        const posts = parqet.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/activities'));
        expect(posts).toHaveLength(3);
        expect((await pq.listCryptoActivities('pf_main')).length).toBe(258);
        expect((await run()).plan.create).toHaveLength(0);
    });
    it('compares balances and shows what was skipped', async () => {
        const { ct, parqet, run, pq } = setup();
        await run();
        const rows = compareBalances(new Map(Object.entries(ct.derivedBalances())), ownActivities(await pq.listCryptoActivities('pf_main')), {});
        const bySymbol = Object.fromEntries(rows.map((r) => [r.symbol, r.difference]));
        expect(bySymbol).toEqual({ ADA: 0, BTC: 0, ETH: 0, FOO: -1000, USDC: -500 });
        expect(parqet.activities.get('pf_main')).toHaveLength(8);
    });
    it('refuses account currencies Parqet does not support', async () => {
        const { ct, run } = setup();
        ct.accountCurrency = 'UAH';
        await expect(run()).rejects.toBeInstanceOf(SyncError);
    });
    it('reports an expired Parqet session as such', async () => {
        const { parqet, pq } = setup();
        parqet.revokeAll();
        await expect(pq.listPortfolios()).rejects.toBeInstanceOf(ParqetAuthError);
    });
    it('creates a portfolio', async () => {
        const { pq } = setup();
        const id = await pq.createPortfolio('CT Sync (Test)');
        expect((await pq.listPortfolios()).map((p) => p.name)).toContain('CT Sync (Test)');
        expect(id).toMatch(/^pf_/);
    });
});
