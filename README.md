# Cointracking2Parqet

Sync your [CoinTracking](https://cointracking.info) transactions into a [Parqet](https://parqet.com) portfolio. CoinTracking connects to hundreds of exchanges and wallets. Parqet's own crypto autosync covers only a few. Cointracking2Parqet lets you use the first to feed the second.

Everything runs in your browser. Nothing is stored on a server.

## How it works

```
Browser (all logic)                        Cloudflare Pages Function       Upstream
────────────────────────────────           ─────────────────────────       ───────────────────────
CoinTracking key + secret (memory)
  └ signs each request (HMAC-SHA512) ──▶   /api/ct      forwards ───────▶   cointracking.info/api/v1
Parqet OAuth (PKCE, sessionStorage) ─────▶ /api/parqet/* forwards ──────▶  connect.parqet.com
Mapping, diff, preview, sync
```

Neither API sends CORS headers that would allow a direct browser call. A small relay on the same origin therefore forwards requests unchanged. It lives in [`functions/_lib/relay.ts`](functions/_lib/relay.ts).

- **Allowlist:** It talks only to the two upstreams, and on Parqet only to the routes the app needs.
- **Same origin:** It accepts only same-origin browser requests.
- **Nothing kept:** It stores nothing and logs nothing. A test fails if it ever calls `console.*`.
- **Minimal headers:** It forwards only `Key`/`Sign` and `Authorization`/`Content-Type`/`Accept`.

**Your CoinTracking API secret never leaves the browser.** Only the public key and a one-time signature pass the relay. The end-to-end test checks this on every request. The Parqet access token does pass the relay in transit, because it has to reach Parqet.

The optional "remember in this browser" setting encrypts key and secret with AES-GCM. The key is derived from a passphrase with PBKDF2 at 600k iterations.

Whoever runs the relay could change its code. If you don't trust the host, deploy your own copy. It takes about five minutes and needs no tooling.

## Sync rules

All prices are fiat values at the time of each transaction, in your CoinTracking account currency. They come from CoinTracking's ledger.

| CoinTracking | Parqet |
|---|---|
| Trade/Swap fiat → crypto | `buy` |
| Trade/Swap crypto → fiat | `sell` |
| Trade/Swap crypto → crypto | `sell` + `buy` |
| Deposit / Withdrawal of crypto | `transfer_in` / `transfer_out` |
| Staking, Mining, Airdrop, Interest, Rewards, Gift in, … | `transfer_in`, or `buy` if set in Options |
| Spend, Gift out, Donation, Lost, Stolen, Liquidation, fees | `transfer_out` |
| Fee paid in fiat | `fee` on the activity |
| Fee paid in crypto | its own `transfer_out` |
| Loans, collateral, liquidity | skipped, or transfers if set in Options |
| Margin/futures trades, fiat deposits | skipped |

**Deduplication.** Every activity gets an `externalId` of the form `ct-<CoinTracking id>-<part>-<hash>`. The Parqet portfolio itself is therefore the sync state.

- **Changed transactions:** Changing a transaction in CoinTracking changes its hash. The old activity is replaced. The new one is created before the old one is deleted.
- **Deleted transactions:** If a transaction is deleted in CoinTracking, its Parqet activity is only removed if you allow it in Options.
- **Your own activities:** Activities you added by hand, or that came from Parqet's own imports, are never touched.

Each preview costs 2 CoinTracking API calls: trades plus ledger. The PRO plan allows 20 calls per hour. Changing options reuses the data already fetched.

## No dependencies

There is no npm, no build step and no bundler. The browser loads the plain JavaScript modules in `public/` directly. The relay in `functions/` is plain JavaScript as well, and Cloudflare compiles it. Tests use Node's built-in test runner. Node is only needed for local development and tests, not in production.

```
public/            everything the browser loads, served as is
  app/core/        CoinTracking and Parqet clients, mapping, sync logic
  app/main.js      the UI
functions/         the relay (Cloudflare Pages Functions)
dev/server.js      local server: public/ plus the relay, like Cloudflare Pages
tests/             node --test, with fake CoinTracking and Parqet servers
```

## Setup

1. **Parqet integration.** Open the [Parqet developer console](https://www.parqet.com/console/integrations) and create an integration.
   - Scopes: read and write.
   - Redirect URLs: `http://localhost:8788/callback` and `https://<your-domain>/callback`.
   - Copy the client ID.

   The integration stays private, which is enough for your own account.
2. **CoinTracking API key.** Go to [cointracking.info/api](https://cointracking.info/api/api.php) and create a key with **read access only**. API access requires a PRO, EXPERT or UNLIMITED plan.
3. **Local run.** Requires Node 22 or newer:
   ```sh
   cp .env.example .env.local   # set PARQET_CLIENT_ID
   node dev/server.js           # http://localhost:8788
   ```

## Deploy to Cloudflare Pages

In the Cloudflare dashboard, open **Workers & Pages**, create a Pages project and connect this GitHub repository.

| Setting | Value |
|---|---|
| Production branch | `main` |
| Build command | *(empty)* |
| Build output directory | `public` |
| Environment variable | `PARQET_CLIENT_ID` = your client ID |

Cloudflare serves `public/` and compiles `functions/` itself.

- **Domain:** Attach a custom domain such as `cointracking2parqet.christoph-werner.com`, and add `https://<domain>/callback` as a redirect URL in the Parqet console.
- **Logging:** Keep observability and Logpush off for this project.
- **Forks:** Cloudflare does not build previews for pull requests from forks. Production only builds from `main`, where only the maintainer merges.
- **Confidential client:** If Parqet ever requires one, add `PARQET_CLIENT_SECRET` as an encrypted variable. The relay then adds it to token requests. It is an app secret, not user data.

## Contributing

Pull requests are welcome. Every change is reviewed and merged by the maintainer. Please report security issues privately, see [SECURITY.md](SECURITY.md). Please keep the project free of dependencies.

## Tests

```sh
node scripts/fetch-spec.mjs   # once: downloads Parqet's OpenAPI spec to spec/
node --test tests/
```

The suite covers:

- **Units:** signing, parsing, every mapping branch, the sync plan, the relay, OAuth with PKCE and the vault.
- **Integration:** a run that starts the dev server and relay against fake upstreams and drives login, sync and idempotence over HTTP.

There is no sandbox for either API. The fakes in `tests/fakes/` enforce what is known about the real services:

- CoinTracking's HMAC signature and nonce.
- Parqet's PKCE check.
- Parqet's request schema, validated against Parqet's official OpenAPI spec with a small built-in validator. The spec belongs to Parqet and is not part of this repo.
- Batch limits, `externalId` deduplication and cursor pagination.

## Verified on a live account

A first real run with a Kraken and Trezor history surfaced these behaviours, which the code now handles:

- **Ledger prices:** CoinTracking's `getLedger` returns `price` and `value_at_transaction` without `show_advanced`.
- **Fees:** CoinTracking's trade amounts already include fees paid in crypto. The fee fields are informational, so Cointracking2Parqet only adds their fiat value to Parqet's `fee` field. Pure fee transactions such as "Other Fee" do reduce the balance. If an account books fees differently, Options has "Fees paid in crypto → Deduct separately".
- **Duplicate tickers:** CoinTracking appends a digit to tickers that exist twice, so Solana is `SOL2`. Parqet rejects those, and the preview offers a one-click rename.
- **Create response:** Parqet's create response did not list the created activities. Cointracking2Parqet counts what is actually in the portfolio afterwards.
- **Activity IDs:** Listing returns activity IDs as `cpa_<id>`, and delete silently ignores IDs it doesn't know. Cointracking2Parqet sends both forms and verifies the deletion.
- **Token endpoint:** It accepts form-encoded requests without a client secret. Client IDs are UUIDs.
- **Result:** After the sync, the balance check matched CoinTracking for every coin.

Still open: Parqet's API rate limits. The client retries on 429 and honours `Retry-After`.

## License

MIT. Not affiliated with Parqet or CoinTracking.
