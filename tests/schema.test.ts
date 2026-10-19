import { describe, expect, it } from 'vitest';
import { parseLedger, parseTrades } from '../src/core/cointracking';
import { DEFAULT_OPTIONS, mapTrades, PriceBook } from '../src/core/mapping';
import { createActivityBodyValidator } from './fakes/openapi';
import { ledgerResponse, SAMPLE, tradesResponse } from './fakes/fakeCoinTracking';

describe('Parqet request schema', () => {
  it('accepts every activity the mapping produces', () => {
    const trades = parseTrades(tradesResponse(SAMPLE));
    const prices = new PriceBook('EUR', parseLedger(ledgerResponse(SAMPLE)).rows);
    for (const options of [DEFAULT_OPTIONS, { ...DEFAULT_OPTIONS, incomeAs: 'buy' as const, defiAsTransfers: true }]) {
      const activities = mapTrades(trades, prices, { ...options, accountCurrency: 'EUR' }).flatMap((m) => m.activities);
      expect(activities.length).toBeGreaterThan(5);
      const validate = createActivityBodyValidator();
      const ok = validate({ activities });
      expect(validate.errors ?? []).toEqual([]);
      expect(ok).toBe(true);
    }
  });

  it('rejects what Parqet would reject, so the check is real', () => {
    const validate = createActivityBodyValidator();
    const base = {
      type: 'buy', assetIdentifierType: 'crypto_symbol', symbol: 'BTC', shares: 1, price: 1, currency: 'EUR',
      datetime: '2024-01-01T00:00:00.000Z', externalId: 'ct-1-b-00000000',
    };
    expect(validate({ activities: [base] })).toBe(true);
    expect(validate({ activities: [{ ...base, currency: 'XYZ' }] })).toBe(false);
    expect(validate({ activities: [{ ...base, externalId: 'ct.1' }] })).toBe(false);
    expect(validate({ activities: [{ ...base, datetime: '2024-01-01T00:00:00+01:00' }] })).toBe(false);
    expect(validate({ activities: [] })).toBe(false);
  });
});
