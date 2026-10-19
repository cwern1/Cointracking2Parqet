/** Fiat currencies Parqet accepts for `currency`. A test keeps this in sync with spec/parqet-openapi.json. */
export const PARQET_CURRENCIES = [
  'AED', 'ARS', 'AUD', 'BHD', 'BRL', 'BWP', 'CAD', 'CHF', 'CLP', 'CNY', 'CZK', 'DKK', 'EUR', 'GBP', 'GBX', 'GEL',
  'HKD', 'HUF', 'IDR', 'ILS', 'INR', 'ISK', 'JPY', 'KRW', 'KZT', 'MAD', 'MXN', 'MYR', 'NOK', 'NZD', 'PEN', 'PHP',
  'PLN', 'QAR', 'RON', 'RSD', 'RUB', 'SAR', 'SEK', 'SGD', 'THB', 'TRY', 'TWD', 'USD', 'VND', 'ZAR', 'ZMW',
] as const;

export type ParqetCurrency = (typeof PARQET_CURRENCIES)[number];

/** Further ISO 4217 codes CoinTracking may use for fiat that Parqet does not list. */
const OTHER_FIAT = [
  'AFN', 'ALL', 'AMD', 'AOA', 'AZN', 'BAM', 'BBD', 'BDT', 'BGN', 'BIF', 'BMD', 'BND', 'BOB', 'BSD', 'BYN', 'BZD',
  'CDF', 'COP', 'CRC', 'CUP', 'CVE', 'DJF', 'DOP', 'DZD', 'EGP', 'ETB', 'FJD', 'GHS', 'GMD', 'GNF', 'GTQ', 'GYD',
  'HNL', 'HRK', 'HTG', 'IQD', 'IRR', 'JMD', 'JOD', 'KES', 'KGS', 'KHR', 'KWD', 'LAK', 'LBP', 'LKR', 'LRD', 'LYD',
  'MDL', 'MGA', 'MKD', 'MMK', 'MNT', 'MOP', 'MUR', 'MVR', 'MWK', 'MZN', 'NAD', 'NGN', 'NIO', 'NPR', 'OMR', 'PAB',
  'PGK', 'PKR', 'PYG', 'RWF', 'SCR', 'SDG', 'SLL', 'SOS', 'SRD', 'SYP', 'SZL', 'TJS', 'TMT', 'TND', 'TOP', 'TTD',
  'TZS', 'UAH', 'UGX', 'UYU', 'UZS', 'VES', 'XAF', 'XCD', 'XOF', 'YER',
];

const FIAT = new Set<string>([...PARQET_CURRENCIES, ...OTHER_FIAT]);

export function isFiat(code: string): boolean {
  return FIAT.has(code.toUpperCase());
}

export function isParqetCurrency(code: string): code is ParqetCurrency {
  return (PARQET_CURRENCIES as readonly string[]).includes(code);
}
