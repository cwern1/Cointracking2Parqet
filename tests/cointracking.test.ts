import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildPostData, CoinTrackingClient, CoinTrackingError, hmacSha512Hex, nextNonce, parseBalance, parseLedger, parseTrades,
} from '../src/core/cointracking';
import { FakeCoinTracking } from './fakes/fakeCoinTracking';

describe('signing', () => {
  it('matches an independent HMAC-SHA512 implementation', async () => {
    const body = buildPostData('getTrades', { limit: 200, order: 'DESC' }, 1700000000123);
    expect(body).toBe('limit=200&order=DESC&method=getTrades&nonce=1700000000123');
    const expected = createHmac('sha512', 'abcdefghij').update(body).digest('hex');
    expect(await hmacSha512Hex('abcdefghij', body)).toBe(expected);
  });

  it('handles non-ASCII secrets and encodes like http_build_query', async () => {
    const body = buildPostData('getTrades', { comment: 'a b&c' }, 1);
    expect(body).toBe('comment=a+b%26c&method=getTrades&nonce=1');
    expect(await hmacSha512Hex('sëcret', body)).toBe(createHmac('sha512', 'sëcret').update(body).digest('hex'));
  });

  it('produces strictly increasing nonces even within one millisecond', () => {
    const a = nextNonce(5_000_000_000_000);
    const b = nextNonce(5_000_000_000_000);
    const c = nextNonce(4_000_000_000_000);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });
});

describe('parsing', () => {
  it('reads the getTrades example from the CoinTracking docs', () => {
    const trades = parseTrades({
      success: 1,
      method: 'getTrades',
      '574025': {
        buy_amount: '0.50000000', buy_currency: 'BTC', sell_amount: '900.20000000', sell_currency: 'USD',
        fee_amount: '4.50000000', fee_currency: 'USD', type: 'Trade', exchange: 'Kraken', group: '',
        comment: 'This is a Kraken Trade', imported_from: 'kraken', time: '1320442867', imported_time: '1391037169', trade_id: '43250',
      },
      '574024': {
        buy_amount: '1', buy_currency: 'BTC', sell_amount: '', sell_currency: '', fee_amount: '', fee_currency: '',
        type: 'Deposit', exchange: 'Bittrex', group: 'My Bittrex Deposits', comment: 'This is a Bittrex Deposit',
        imported_from: 'job_bittrex', time: '1320506675', imported_time: '1391037169', trade_id: 'fe9ois82msma91d821a',
      },
    });
    expect(trades).toHaveLength(2);
    // JS orders integer-like keys numerically, so look rows up by id.
    const byId = new Map(trades.map((t) => [t.id, t]));
    expect(byId.get('574025')).toMatchObject({ id: '574025', buyAmount: 0.5, buyCurrency: 'BTC', sellAmount: 900.2, feeCurrency: 'USD', time: 1320442867 });
    expect(byId.get('574024')).toMatchObject({ id: '574024', sellAmount: null, sellCurrency: null, feeAmount: null, group: 'My Bittrex Deposits' });
  });

  it('reads the getLedger example, including fee rows and empty prices', () => {
    const { accountCurrency, rows } = parseLedger({
      success: 1, method: 'getLedger', account_currency: 'USD',
      '62560': { id: '62560', sub_id: '0', type: 'Airdrop', amount: '0.20000000', currency: 'LTC', value_at_transaction: '5.00', price: '25.00000000' },
      '62561F': { id: '62561', sub_id: '3', type: 'Fee', amount: '0.00100000', currency: 'LTC', value_at_transaction: '', price: '' },
    });
    expect(accountCurrency).toBe('USD');
    expect(rows).toEqual([
      { id: '62560', type: 'Airdrop', amount: 0.2, currency: 'LTC', valueAtTransaction: 5, price: 25 },
      { id: '62561', type: 'Fee', amount: 0.001, currency: 'LTC', valueAtTransaction: null, price: null },
    ]);
  });

  it('reads the getBalance example', () => {
    const { amounts } = parseBalance({
      success: 1, method: 'getBalance', account_currency: 'EUR',
      details: { BTC: { amount: '1.18522859', coin: 'BTC' }, ETC: { amount: '36.74842241', coin: 'ETC' } },
      summary: { value_fiat: '1' },
    });
    expect(Object.fromEntries(amounts)).toEqual({ BTC: 1.18522859, ETC: 36.74842241 });
  });
});

describe('client', () => {
  it('is accepted by a server that checks key, signature and nonce', async () => {
    const fake = new FakeCoinTracking();
    const client = new CoinTrackingClient({ key: fake.key, secret: fake.secret }, { fetch: fake.fetch() });
    const trades = await client.getTrades();
    expect(trades.length).toBe(fake.trades.length);
    await client.getLedger();
    expect(fake.calls).toEqual(['getTrades', 'getLedger']);
  });

  it('turns API errors into CoinTrackingError', async () => {
    const fake = new FakeCoinTracking();
    const client = new CoinTrackingClient({ key: fake.key, secret: 'wrong' }, { fetch: fake.fetch() });
    await expect(client.getTrades()).rejects.toMatchObject({ code: 'SIGN_INVALID' });
    await expect(client.getTrades()).rejects.toBeInstanceOf(CoinTrackingError);
  });

  it('reports every call so the UI can track the hourly budget', async () => {
    const fake = new FakeCoinTracking();
    const seen: number[] = [];
    const client = new CoinTrackingClient({ key: fake.key, secret: fake.secret }, { fetch: fake.fetch(), onCall: (t) => seen.push(t) });
    await client.getBalance();
    expect(seen).toHaveLength(1);
  });
});
