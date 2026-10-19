import { describe, it, afterEach } from 'node:test';
import { expect, vi } from './helpers/expect.js';
import { parseLedger, parseTrades } from '../public/app/core/cointracking.js';
import { DEFAULT_OPTIONS, EXTERNAL_ID_RE, mapTrade, PriceBook, round, TYPE_RULES } from '../public/app/core/mapping.js';
import { ledgerResponse, SAMPLE, tradesResponse } from './fakes/fakeCoinTracking.js';
const opts = { ...DEFAULT_OPTIONS, accountCurrency: 'EUR' };
function load(fixtures = SAMPLE) {
    const trades = parseTrades(tradesResponse(fixtures));
    const { rows } = parseLedger(ledgerResponse(fixtures));
    return { trades: new Map(trades.map((t) => [t.id, t])), prices: new PriceBook('EUR', rows) };
}
const { trades, prices } = load();
const map = (id, o = {}) => mapTrade(trades.get(id), prices, { ...opts, ...o });
const brief = (id, o = {}) => map(id, o).activities.map((a) => [a.type, a.symbol, a.shares, a.price, a.fee ?? 0]);
describe('mapping CoinTracking transactions to Parqet activities', () => {
    it('fiat to crypto trade becomes a buy with the fiat fee attached', () => {
        expect(brief('1001')).toEqual([['buy', 'BTC', 0.5, 20000, 10]]);
        expect(map('1001').activities[0]).toMatchObject({ broker: 'kraken', currency: 'EUR', datetime: '2023-11-14T22:13:20.000Z' });
    });
    it('crypto to crypto trade becomes a sell and a buy, the crypto fee only adds to the cost', () => {
        expect(brief('1002')).toEqual([
            ['sell', 'BTC', 0.4, 20000, 0],
            ['buy', 'ETH', 10, 800, 20],
        ]);
    });
    it('can deduct crypto fees separately for accounts that book them that way', () => {
        expect(brief('1002', { cryptoFees: 'separate' })).toEqual([
            ['sell', 'BTC', 0.4, 20000, 0],
            ['buy', 'ETH', 10, 800, 0],
            ['transfer_out', 'BTC', 0.001, 20000, 0],
        ]);
        expect(brief('1010', { cryptoFees: 'separate' })).toEqual([
            ['buy', 'ADA', 100, 0.5, 0],
            ['transfer_out', 'BNB', 0.5, 200, 0],
        ]);
    });
    it('staking income is a transfer in by default and a buy on request', () => {
        expect(brief('1003')).toEqual([['transfer_in', 'ETH', 0.1, 810, 0]]);
        expect(brief('1003', { incomeAs: 'buy' })).toEqual([['buy', 'ETH', 0.1, 810, 0]]);
    });
    it('crypto withdrawal is a transfer out with its fee value', () => {
        expect(brief('1004')).toEqual([['transfer_out', 'ETH', 1, 820, 1.64]]);
    });
    it('fiat deposits, margin trades and loans are skipped with a reason', () => {
        expect(map('1005').skipped).toMatch(/Fiat deposit/);
        expect(map('1007').skipped).toMatch(/Margin Trade is not imported/);
        expect(map('1008').skipped).toMatch(/loans and liquidity/);
    });
    it('loans become transfers when enabled', () => {
        expect(brief('1008', { defiAsTransfers: true })).toEqual([['transfer_in', 'USDC', 500, 0.93, 0]]);
    });
    it('crypto sold for a foreign fiat currency is a sell priced in the account currency', () => {
        expect(brief('1006')).toEqual([['sell', 'BTC', 0.05, 21000, 0]]);
    });
    it('skips income without any known price', () => {
        expect(map('1009').skipped).toBe('No fiat price for FOO');
    });
    it('fee in a third coin is valued with that coin\'s price', () => {
        expect(brief('1010')).toEqual([['buy', 'ADA', 100, 0.5, 100]]);
    });
    it('fee transactions reduce the coin balance', () => {
        expect(brief('1011')).toEqual([['transfer_out', 'BTC', 0.0001, 20500, 0]]);
    });
    it('falls back to the counter side when the ledger has no price', () => {
        const { trades: t, prices: p } = load([{ id: '9', type: 'Trade', buy: [2, 'SOL'], sell: [50, 'EUR'], time: 1, prices: { SOL: null } }]);
        expect(mapTrade(t.get('9'), p, opts).activities[0]).toMatchObject({ type: 'buy', price: 25 });
    });
    it('applies the symbol map and the skip list', () => {
        const { trades: t, prices: p } = load([
            { id: '9', type: 'Trade', buy: [10, 'IOTA'], sell: [1, 'ETH'], time: 1, prices: { IOTA: 0.3, ETH: 3 } },
        ]);
        const mapped = mapTrade(t.get('9'), p, { ...opts, symbolMap: { IOTA: 'MIOTA' }, skipSymbols: ['ETH'] });
        expect(mapped.activities.map((a) => [a.type, a.symbol])).toEqual([['buy', 'MIOTA']]);
        expect(mapped.notes).toContain('ETH is on the skip list');
    });
    it('builds stable external ids that change when the transaction changes', () => {
        const a = map('1002').activities.map((x) => x.externalId);
        expect(a.every((id) => EXTERNAL_ID_RE.test(id))).toBe(true);
        expect(new Set(a).size).toBe(2);
        expect(map('1002', { cryptoFees: 'separate' }).activities[0].externalId).not.toBe(a[0]);
        expect(map('1002').activities.map((x) => x.externalId)).toEqual(a);
        const changed = { ...trades.get('1002'), buyAmount: 11 };
        expect(mapTrade(changed, prices, opts).activities.map((x) => x.externalId)).not.toEqual(a);
        expect(map('1003', { incomeAs: 'buy' }).activities[0].externalId).not.toBe(map('1003').activities[0].externalId);
        // Options only touch the transactions they apply to.
        expect(map('1002', { incomeAs: 'buy', defiAsTransfers: true }).activities.map((x) => x.externalId)).toEqual(a);
    });
    it('sanitises CoinTracking ids that contain characters Parqet rejects', () => {
        const { trades: t, prices: p } = load([{ id: 'ab.c/1', type: 'Staking', buy: [1, 'DOT'], time: 1, prices: { DOT: 5 } }]);
        expect(mapTrade(t.get('ab.c/1'), p, opts).activities[0].externalId).toMatch(/^ct-ab_c_1-i-[0-9a-f]{8}$/);
    });
    it('knows every type listed in the CoinTracking docs', () => {
        const documented = `Trade | Deposit | Withdrawal | Income | Mining | Gift/Tip(In) | Spend | Donation | Gift(Out) | Stolen | Lost | Airdrop | Staking | Masternode | Minting | Dividends Income | Lending Income | Interest Income | Reward / Bonus | Mining (commercial) | Margin Profit | Derivatives / Futures Profit | LP Rewards | Other Income | Income (non taxable) | Other Income (non taxable) | Airdrop (non taxable) | Receive Loan | Receive Collateral | Remove Liquidity | Receive LP Token | Margin Loss | Margin Fee | Borrowing Fee | Settlement Fee | Derivatives / Futures Loss | Other Fee | Provide Liquidity | Return LP Token | Other Expense | Expense (non taxable) | Send Collateral | Repay Loan | Liquidation | Margin Trade | Derivatives / Futures Trade | Swap (non taxable)`.split(' | ');
        expect(documented.filter((t) => !TYPE_RULES.has(t))).toEqual([]);
    });
    it('rounds away float noise but keeps tiny prices', () => {
        expect(round(0.1 + 0.2)).toBe(0.3);
        expect(round(0.000000012345678901234)).toBe(0.0000000123456789012);
    });
});
describe('rename suggestions', () => {
    it('flags CoinTracking duplicate tickers like SOL2 but not real tickers', async () => {
        const { suggestRenames } = await import('../public/app/core/mapping.js');
        expect(suggestRenames(['SOL2', 'BTC', 'API3', 'LUNA3', 'ETH', 'SOL2'], {})).toEqual([
            { from: 'LUNA3', to: 'LUNA' },
            { from: 'SOL2', to: 'SOL' },
        ]);
        expect(suggestRenames(['SOL2'], { SOL2: 'SOL' })).toEqual([]);
    });
});
