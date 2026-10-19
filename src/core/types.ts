/** One row of CoinTracking getTrades, normalised. `id` is CoinTracking's unique transaction id (the object key). */
export interface CtTrade {
  id: string;
  type: string;
  buyAmount: number | null;
  buyCurrency: string | null;
  sellAmount: number | null;
  sellCurrency: string | null;
  feeAmount: number | null;
  feeCurrency: string | null;
  exchange: string;
  group: string;
  comment: string;
  /** UNIX seconds */
  time: number;
}

/** One row of CoinTracking getLedger. Used only for its documented fiat prices. */
export interface CtLedgerRow {
  id: string;
  type: string;
  amount: number | null;
  currency: string;
  valueAtTransaction: number | null;
  price: number | null;
}

export type ParqetActivityType =
  | 'buy'
  | 'sell'
  | 'dividend'
  | 'interest'
  | 'transfer_in'
  | 'transfer_out'
  | 'fees_taxes'
  | 'deposit'
  | 'withdrawal';

/** Body item for POST /portfolios/{id}/activities, crypto variant. */
export interface ParqetCryptoActivity {
  type: ParqetActivityType;
  assetIdentifierType: 'crypto_symbol';
  symbol: string;
  shares: number;
  price: number;
  currency: string;
  datetime: string;
  fee?: number;
  tax?: number;
  description?: string;
  broker?: string;
  externalId: string;
}

/** An activity that already exists in the Parqet portfolio. */
export interface ExistingActivity {
  id: string;
  externalId?: string;
  type: string;
  symbol?: string;
  shares: number;
  datetime: string;
}

export interface Portfolio {
  id: string;
  name: string;
  currency: string;
}
