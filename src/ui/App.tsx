import type { JSX } from 'preact';
import { forwardRef } from 'preact/compat';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { CoinTrackingClient, CoinTrackingError, type CtCredentials } from '../core/cointracking';
import { suggestRenames } from '../core/mapping';
import { OAuthError, ParqetOAuth } from '../core/oauth';
import { ParqetAuthError, ParqetClient } from '../core/parqet';
import type { SyncPlan } from '../core/plan';
import {
  compareBalances, executePlan, explainDifference, fetchSource, makePlan, ownActivities,
  type BalanceRow, type BreakdownRow, type Progress, type SourceData, type SyncResult,
} from '../core/sync';
import type { ExistingActivity, ParqetCryptoActivity, Portfolio } from '../core/types';
import * as vault from '../core/vault';
import { APP_NAME, CT_CALLS_PER_HOUR, oauthConfig } from './config';
import {
  formatSymbolMap, loadOptions, loadPortfolioId, parseSymbolList, parseSymbolMap, recentCalls, recordCall,
  saveOptions, savePortfolioId, type SyncOptions,
} from './prefs';

const oauth = new ParqetOAuth(oauthConfig());
const parqet = new ParqetClient(() => oauth.accessToken());

type Busy = null | 'connect' | 'preview' | 'sync' | 'balances' | 'reset' | 'portfolio';

const num = new Intl.NumberFormat('en', { maximumFractionDigits: 8 });
const date = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' });
const money = (value: number, currency: string) => {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency, maximumSignificantDigits: 6 }).format(value);
  } catch {
    return `${num.format(value)} ${currency}`;
  }
};
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const TYPE_LABEL: Record<string, string> = {
  buy: 'Buy', sell: 'Sell', transfer_in: 'Transfer in', transfer_out: 'Transfer out',
};

function describeError(e: unknown): { title: string; detail?: string; reconnect?: boolean } {
  if (e instanceof ParqetAuthError || e instanceof OAuthError) {
    return { title: 'Parqet connection lost', detail: e.message, reconnect: true };
  }
  if (e instanceof CoinTrackingError) {
    const hints: Record<string, string> = {
      KEY_INVALID: 'Check your API key.',
      KEY_MISSING: 'Enter your API key.',
      SIGN_INVALID: 'Check your API secret.',
      NO_ACCESS: 'The CoinTracking API needs a PRO, EXPERT or UNLIMITED plan.',
    };
    return { title: `CoinTracking: ${e.message}`, detail: hints[e.code] ?? `Error code ${e.code}.` };
  }
  if (e instanceof Error) return { title: e.message };
  return { title: 'Something went wrong.' };
}

export function App() {
  const [connected, setConnected] = useState(oauth.isConnected());
  const [portfolios, setPortfolios] = useState<Portfolio[] | null>(null);
  const [portfolioId, setPortfolioId] = useState<string | null>(loadPortfolioId());
  const [newPortfolio, setNewPortfolio] = useState<string | null>(null);

  const [creds, setCreds] = useState<CtCredentials>({ key: '', secret: '' });
  const [remember, setRemember] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const [stored, setStored] = useState(vault.hasStored());
  const [unlockPass, setUnlockPass] = useState('');

  const [options, setOptions] = useState<SyncOptions>(loadOptions());
  const [source, setSource] = useState<SourceData | null>(null);
  const [existing, setExisting] = useState<ExistingActivity[] | null>(null);
  const [result, setResult] = useState<SyncResult | null>(null);
  const [balances, setBalances] = useState<BalanceRow[] | null>(null);
  const [breakdown, setBreakdown] = useState<Record<string, BreakdownRow[]>>({});

  const [busy, setBusy] = useState<Busy>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<ReturnType<typeof describeError> | null>(null);
  const [calls, setCalls] = useState(recentCalls().length);
  const sheet = useRef<HTMLDialogElement>(null);

  const credsReady = creds.key.trim() !== '' && creds.secret.trim() !== '';
  const portfolio = portfolios?.find((p) => p.id === portfolioId) ?? null;

  // The plan is a pure function of what we fetched and the options, so option changes need no new API calls.
  const planned = useMemo((): { plan: SyncPlan | null; planError: string | null } => {
    if (!source || !existing) return { plan: null, planError: null };
    try {
      return { plan: makePlan(source, existing, options), planError: null };
    } catch (e) {
      return { plan: null, planError: (e as Error).message };
    }
  }, [source, existing, options]);
  const { plan, planError } = planned;
  const changes = plan ? plan.create.length + plan.deleteChanged.length + (options.removeOrphans ? plan.orphaned.length : 0) : 0;

  const fail = (e: unknown) => {
    const d = describeError(e);
    if (d.reconnect) {
      oauth.logout();
      setConnected(false);
    }
    setError(d);
  };

  async function run(kind: Exclude<Busy, null>, fn: () => Promise<void>) {
    setBusy(kind);
    setError(null);
    try {
      await fn();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
      setProgress(null);
    }
  }

  const ctClient = () =>
    new CoinTrackingClient(
      { key: creds.key.trim(), secret: creds.secret.trim() },
      { onCall: (t) => { recordCall(t); setCalls(recentCalls().length); } },
    );

  // OAuth callback
  useEffect(() => {
    const url = new URL(location.href);
    if (!oauth.isCallback(url)) return;
    history.replaceState(null, '', '/');
    void run('connect', async () => {
      await oauth.completeLogin(url);
      setConnected(true);
    });
  }, []);

  useEffect(() => {
    if (!connected) return;
    void run('portfolio', async () => {
      const list = await parqet.listPortfolios();
      setPortfolios(list);
      if (!list.some((p) => p.id === portfolioId)) setPortfolioId(list.length === 1 ? list[0]!.id : null);
    });
  }, [connected]);

  useEffect(() => savePortfolioId(portfolioId), [portfolioId]);
  useEffect(() => saveOptions(options), [options]);
  // A different portfolio means a different starting point.
  useEffect(() => {
    setExisting(null);
    setResult(null);
    setBalances(null);
  }, [portfolioId]);

  const connect = () =>
    run('connect', async () => {
      location.assign(await oauth.beginLogin());
    });

  const disconnect = () => {
    oauth.logout();
    setConnected(false);
    setPortfolios(null);
    setExisting(null);
  };

  const createPortfolio = () =>
    run('portfolio', async () => {
      const name = (newPortfolio ?? '').trim();
      if (!name) return;
      const id = await parqet.createPortfolio(name);
      setPortfolios(await parqet.listPortfolios());
      setPortfolioId(id);
      setNewPortfolio(null);
    });

  const unlock = () =>
    run('connect', async () => {
      try {
        setCreds(await vault.unlock(unlockPass));
        setUnlockPass('');
      } catch {
        throw new Error('That passphrase does not unlock the saved key.');
      }
    });

  const forgetStored = () => {
    vault.forget();
    setStored(false);
  };

  const preview = (refetch: boolean) =>
    run('preview', async () => {
      if (!portfolioId) return;
      setResult(null);
      setBalances(null);
      if (remember && passphrase) {
        await vault.store({ key: creds.key.trim(), secret: creds.secret.trim() }, passphrase);
        setStored(true);
        setRemember(false);
        setPassphrase('');
      }
      const src = refetch || !source ? await fetchSource(ctClient()) : source;
      setSource(src);
      setExisting(await parqet.listCryptoActivities(portfolioId));
    });

  const sync = () =>
    run('sync', async () => {
      if (!plan || !portfolioId) return;
      const r = await executePlan(parqet, portfolioId, plan, { removeOrphans: options.removeOrphans }, setProgress);
      setResult(r);
      setExisting(await parqet.listCryptoActivities(portfolioId));
    });

  const checkBalances = () =>
    run('balances', async () => {
      if (!portfolioId) return;
      const { amounts } = await ctClient().getBalance();
      const acts = await parqet.listCryptoActivities(portfolioId);
      setExisting(acts);
      const rows = compareBalances(amounts, ownActivities(acts), options.symbolMap, options.skipSymbols);
      setBalances(rows);
      const trades = source?.trades ?? [];
      setBreakdown(
        Object.fromEntries(
          rows.filter((r) => r.difference !== 0).map((r) => [r.symbol, explainDifference(r.symbol, trades, acts, options.symbolMap)]),
        ),
      );
    });

  const resetAll = () =>
    run('reset', async () => {
      if (!portfolioId) return;
      const own = ownActivities(await parqet.listCryptoActivities(portfolioId));
      if (own.length === 0) return;
      const ok = confirm(`Delete ${own.length} activities that ${APP_NAME} created in “${portfolio?.name}”? Activities you added yourself stay.`);
      if (!ok) return;
      await parqet.deleteActivities(portfolioId, own.map((a) => a.id));
      setExisting(await parqet.listCryptoActivities(portfolioId));
      setResult(null);
      sheet.current?.close();
    });

  // ---------- CTA ----------
  let cta: { label: string; action: () => void; disabled: boolean } = {
    label: 'Preview changes',
    action: () => void preview(false),
    disabled: !connected || !portfolioId || !credsReady || busy !== null,
  };
  if (plan && busy === null) {
    cta = changes
      ? { label: `Sync ${changes} ${changes === 1 ? 'change' : 'changes'}`, action: () => void sync(), disabled: false }
      : { label: 'Up to date', action: () => {}, disabled: true };
  }
  if (busy === 'preview') cta = { label: 'Reading transactions…', action: () => {}, disabled: true };
  if (busy === 'sync') {
    const p = progress;
    cta = {
      label: p ? `${p.phase === 'create' ? 'Adding' : 'Removing'} ${p.done} / ${p.total}…` : 'Syncing…',
      action: () => {},
      disabled: true,
    };
  }

  const clientIdMissing = !oauthConfig().clientId;

  return (
    <div class="page">
      <header class="page-header">
        <p class="eyebrow">Crypto sync for Parqet</p>
        <h1>{APP_NAME}</h1>
        <p class="lede">
          Import every crypto transaction from CoinTracking into a Parqet portfolio. Runs in your browser. Nothing is stored on a server.
        </p>
      </header>

      {clientIdMissing && (
        <div class="notice warning" role="alert">
          <strong>Setup incomplete</strong>
          VITE_PARQET_CLIENT_ID is not set. See the README.
        </div>
      )}

      {error && (
        <div class="notice error" role="alert">
          <strong>{error.title}</strong>
          {error.detail}
        </div>
      )}

      {/* 1 · Parqet */}
      <section class="group" aria-labelledby="g-parqet">
        <h2 class="group-label" id="g-parqet">
          <span class={`step ${connected && portfolio ? 'done' : ''}`}>{connected && portfolio ? '✓' : '1'}</span> Parqet
        </h2>
        <div class="card">
          {!connected ? (
            <div class="row">
              <p class="muted small">Sign in to Parqet and allow access to your portfolios.</p>
              <button class="btn primary" onClick={connect} disabled={busy !== null || clientIdMissing}>
                {busy === 'connect' ? 'Connecting…' : 'Connect Parqet'}
              </button>
            </div>
          ) : (
            <>
              <div class="row">
                <span class="status-line"><span class="dot ok" aria-hidden="true" /> Connected</span>
                <button class="btn link small" onClick={disconnect}>Disconnect</button>
              </div>
              <p class="field-label" style={{ marginTop: '1rem' }} id="pf-label">Target portfolio</p>
              {portfolios === null ? (
                <p class="muted small">Loading portfolios…</p>
              ) : (
                <div class="chips" role="radiogroup" aria-labelledby="pf-label">
                  {portfolios.map((p) => (
                    <button
                      key={p.id}
                      class="chip"
                      role="radio"
                      aria-checked={p.id === portfolioId}
                      onClick={() => setPortfolioId(p.id)}
                    >
                      {p.name}
                    </button>
                  ))}
                  {newPortfolio === null && (
                    <button class="chip add" onClick={() => setNewPortfolio('Crypto')}>+ New portfolio</button>
                  )}
                </div>
              )}
              {newPortfolio !== null && (
                <form class="inline-form" onSubmit={(e) => { e.preventDefault(); void createPortfolio(); }}>
                  <input
                    class="input"
                    aria-label="Portfolio name"
                    maxLength={80}
                    value={newPortfolio}
                    onInput={(e) => setNewPortfolio(e.currentTarget.value)}
                    autoFocus
                  />
                  <button class="btn primary" type="submit" disabled={busy !== null || !newPortfolio.trim()}>Create</button>
                  <button class="btn ghost" type="button" onClick={() => setNewPortfolio(null)}>Cancel</button>
                </form>
              )}
              <p class="hint">Use a portfolio just for crypto. {APP_NAME} only changes activities it created itself.</p>
            </>
          )}
        </div>
      </section>

      {/* 2 · CoinTracking */}
      <section class="group" aria-labelledby="g-ct">
        <h2 class="group-label" id="g-ct">
          <span class={`step ${credsReady ? 'done' : ''}`}>{credsReady ? '✓' : '2'}</span> CoinTracking
        </h2>
        <div class="card">
          {stored && !credsReady ? (
            <form onSubmit={(e) => { e.preventDefault(); void unlock(); }}>
              <label class="field">
                <span class="field-label">Passphrase for your saved API key</span>
                <input class="input" type="password" autoComplete="current-password" value={unlockPass} onInput={(e) => setUnlockPass(e.currentTarget.value)} />
              </label>
              <div class="row" style={{ marginTop: '0.8rem' }}>
                <button class="btn link small" type="button" onClick={forgetStored}>Forget saved key</button>
                <button class="btn primary" type="submit" disabled={!unlockPass || busy !== null}>Unlock</button>
              </div>
            </form>
          ) : (
            <>
              <label class="field">
                <span class="field-label">API key</span>
                <input class="input" autoComplete="off" spellcheck={false} value={creds.key} onInput={(e) => setCreds({ ...creds, key: e.currentTarget.value })} />
              </label>
              <label class="field">
                <span class="field-label">API secret</span>
                <input class="input" type="password" autoComplete="off" value={creds.secret} onInput={(e) => setCreds({ ...creds, secret: e.currentTarget.value })} />
              </label>
              {!stored && (
                <label class="check">
                  <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.currentTarget.checked)} />
                  Remember in this browser, encrypted with a passphrase
                </label>
              )}
              {remember && (
                <label class="field" style={{ marginTop: '0.8rem' }}>
                  <span class="field-label">Passphrase</span>
                  <input class="input" type="password" autoComplete="new-password" value={passphrase} onInput={(e) => setPassphrase(e.currentTarget.value)} />
                </label>
              )}
              <p class="hint">
                Create a key with read access only under{' '}
                <a href="https://cointracking.info/api/api.php" target="_blank" rel="noopener noreferrer">CoinTracking → API</a>. The secret signs each request here in your browser and is never sent anywhere.
              </p>
            </>
          )}
          <p class="hint">
            CoinTracking allows {CT_CALLS_PER_HOUR} API calls per hour. A preview uses 2, a balance check 1. Used in the last hour: {calls}.
          </p>
        </div>
      </section>

      {/* 3 · Review */}
      {(plan || planError) && (
        <section class="group" aria-labelledby="g-review" aria-live="polite">
          <h2 class="group-label" id="g-review"><span class="step">3</span> Review</h2>
          {planError && <div class="notice error"><strong>{planError}</strong></div>}
          {result && <SyncResultNotice result={result} />}
          {plan && source && (
            <ReviewPanel
              plan={plan}
              currency={source.accountCurrency}
              removeOrphans={options.removeOrphans}
              fetchedAt={source.fetchedAt}
              onRefresh={() => void preview(true)}
              onCheckBalances={() => void checkBalances()}
              busy={busy}
              symbolMap={options.symbolMap}
              onRename={(renames) =>
                setOptions({ ...options, symbolMap: { ...options.symbolMap, ...Object.fromEntries(renames.map((r) => [r.from, r.to])) } })
              }
            />
          )}
          {balances && <BalanceTable rows={balances} breakdown={breakdown} />}
        </section>
      )}

      <div class="cta-bar">
        <div class="cta-row">
          <button class="cta secondary" type="button" onClick={() => sheet.current?.showModal()} aria-haspopup="dialog">
            Options
          </button>
          <button class={`cta ${busy === 'preview' || busy === 'sync' ? 'loading' : ''}`} onClick={cta.action} disabled={cta.disabled}>
            {cta.label}
          </button>
        </div>
        {!plan && !connected && <p class="cta-note">Connect Parqet and enter your CoinTracking API key to start.</p>}
      </div>

      <OptionsSheet
        ref={sheet}
        options={options}
        onChange={setOptions}
        canReset={connected && !!portfolioId}
        onReset={() => void resetAll()}
        busy={busy}
      />

      <footer class="footer">
        <p>Not affiliated with Parqet or CoinTracking.</p>
        <p>
          <a href="https://christoph-werner.com/" target="_blank" rel="noopener">christoph-werner.com</a>
          {' · '}
          <a href="https://christoph-werner.com/imprint.html" target="_blank" rel="noopener">Legal</a>
        </p>
      </footer>
    </div>
  );
}

function SyncResultNotice({ result }: { result: SyncResult }) {
  const ok = result.failures.length === 0 && result.notDeleted === 0;
  return (
    <div class={`notice ${ok ? 'success' : 'warning'}`} role="status">
      <strong>
        {ok ? 'Sync complete.' : 'Sync finished with problems.'} Added {result.created}, removed {result.deleted}.
      </strong>
      {result.notDeleted > 0 && (
        <p>Parqet did not delete {plural(result.notDeleted, 'outdated activity', 'outdated activities')}. They still count twice. Please report this.</p>
      )}
      {result.failures.length > 0 && (
        <>
          Parqet rejected {result.failures.length} {result.failures.length === 1 ? 'activity' : 'activities'}.
          {result.keptBecauseOfFailure > 0 && ` The previous version of ${result.keptBecauseOfFailure} was kept.`}
          <ul>
            {result.failures.slice(0, 10).map((f) => (
              <li key={f.activity.externalId}>
                {f.activity.symbol} {TYPE_LABEL[f.activity.type] ?? f.activity.type} on {f.activity.datetime.slice(0, 10)}: {f.message || f.code}
              </li>
            ))}
          </ul>
          {result.failures.some((f) => /asset|symbol|not.?found/i.test(f.code + f.message)) && (
            <p style={{ marginTop: '0.4rem' }}>Unknown coin symbols can be renamed or skipped under Options.</p>
          )}
        </>
      )}
    </div>
  );
}

function ReviewPanel(props: {
  plan: SyncPlan;
  currency: string;
  removeOrphans: boolean;
  fetchedAt: number;
  onRefresh: () => void;
  onCheckBalances: () => void;
  busy: Busy;
  symbolMap: Record<string, string>;
  onRename: (renames: Array<{ from: string; to: string }>) => void;
}) {
  const { plan, currency } = props;
  const renames = suggestRenames(
    plan.trades.flatMap((t) => [t.mapped.trade.buyCurrency, t.mapped.trade.sellCurrency, t.mapped.trade.feeCurrency]).filter((c): c is string => !!c),
    props.symbolMap,
  );
  const skipped = plan.trades.filter((t) => t.status === 'skipped');
  const notes = plan.trades.filter((t) => t.mapped.notes.length && t.status !== 'skipped');
  return (
    <>
      {renames.length > 0 && (
        <div class="notice warning" role="status">
          <strong>Check these coin symbols</strong>
          CoinTracking adds a number to tickers that exist twice. Parqet most likely knows{' '}
          {renames.map((r) => `${r.from} as ${r.to}`).join(', ')}.
          <div class="chips" style={{ marginTop: '0.6rem' }}>
            <button class="btn primary small" onClick={() => props.onRename(renames)}>
              Rename {renames.map((r) => `${r.from} → ${r.to}`).join(', ')}
            </button>
          </div>
        </div>
      )}
      <div class="stats">
        <Stat cls="new" value={plan.counts.new} label="New" />
        <Stat cls="changed" value={plan.counts.changed} label="Changed" />
        <Stat value={plan.counts.unchanged} label="In sync" />
        <Stat value={plan.counts.skipped} label="Skipped" />
        {plan.counts.orphaned > 0 && <Stat cls="removed" value={plan.counts.orphaned} label="Deleted in CT" />}
      </div>

      {plan.create.length > 0 && (
        <details class="section" open>
          <summary>{plural(plan.create.length, 'activity', 'activities')} to add</summary>
          <ActivityList items={plan.create} currency={currency} />
        </details>
      )}
      {plan.deleteChanged.length > 0 && (
        <details class="section">
          <summary>{plural(plan.deleteChanged.length, 'outdated activity', 'outdated activities')} to replace</summary>
          <ExistingList items={plan.deleteChanged} />
        </details>
      )}
      {plan.orphaned.length > 0 && (
        <details class="section">
          <summary>
            {plural(plan.orphaned.length, 'activity', 'activities')} whose transaction was deleted in CoinTracking
            {props.removeOrphans ? ' (will be removed)' : ' (kept, see Options)'}
          </summary>
          <ExistingList items={plan.orphaned} />
        </details>
      )}
      {skipped.length > 0 && (
        <details class="section">
          <summary>{plural(skipped.length, 'transaction', 'transactions')} skipped</summary>
          <Paged
            items={skipped}
            render={(t) => (
              <div class="list-item" key={t.mapped.trade.id}>
                <span class="badge skip">{t.mapped.trade.type}</span>
                <div class="item-main">
                  <div class="item-title">{tradeSummary(t.mapped.trade)}</div>
                  <div class="item-sub">{t.mapped.skipped}</div>
                </div>
                <div class="item-side">{date.format(t.mapped.trade.time * 1000)}</div>
              </div>
            )}
          />
        </details>
      )}
      {notes.length > 0 && (
        <details class="section">
          <summary>{plural(notes.length, 'transaction', 'transactions')} with notes</summary>
          <Paged
            items={notes}
            render={(t) => (
              <div class="list-item" key={t.mapped.trade.id}>
                <span class="badge">{t.mapped.trade.type}</span>
                <div class="item-main">
                  <div class="item-title">{tradeSummary(t.mapped.trade)}</div>
                  <div class="item-sub">{t.mapped.notes.join(' · ')}</div>
                </div>
                <div class="item-side">{date.format(t.mapped.trade.time * 1000)}</div>
              </div>
            )}
          />
        </details>
      )}

      <div class="row" style={{ marginTop: '1.2rem' }}>
        <span class="muted small">Transactions read {date.format(props.fetchedAt)}</span>
        <span class="chips">
          <button class="btn ghost small" onClick={props.onCheckBalances} disabled={props.busy !== null}>
            {props.busy === 'balances' ? 'Checking…' : 'Check balances'}
          </button>
          <button class="btn ghost small" onClick={props.onRefresh} disabled={props.busy !== null}>
            Read again
          </button>
        </span>
      </div>
    </>
  );
}

function Stat({ value, label, cls = '' }: { value: number; label: string; cls?: string }) {
  return (
    <div class={`stat ${cls}`}>
      <div class="stat-value">{value}</div>
      <div class="stat-label">{label}</div>
    </div>
  );
}

function tradeSummary(t: { buyAmount: number | null; buyCurrency: string | null; sellAmount: number | null; sellCurrency: string | null }) {
  const b = t.buyAmount ? `+${num.format(t.buyAmount)} ${t.buyCurrency}` : '';
  const s = t.sellAmount ? `−${num.format(t.sellAmount)} ${t.sellCurrency}` : '';
  return [b, s].filter(Boolean).join('  ') || '—';
}

function Paged<T>({ items, render, page = 50 }: { items: T[]; render: (t: T) => JSX.Element; page?: number }) {
  const [shown, setShown] = useState(page);
  return (
    <div class="list">
      {items.slice(0, shown).map(render)}
      {items.length > shown && (
        <div class="more">
          <button class="btn link small" onClick={() => setShown(shown + page * 4)}>
            Show more ({items.length - shown} left)
          </button>
        </div>
      )}
    </div>
  );
}

function ActivityList({ items, currency }: { items: ParqetCryptoActivity[]; currency: string }) {
  return (
    <Paged
      items={items}
      render={(a) => (
        <div class="list-item" key={a.externalId}>
          <span class={`badge ${a.type}`}>{TYPE_LABEL[a.type] ?? a.type}</span>
          <div class="item-main">
            <div class="item-title">{num.format(a.shares)} {a.symbol}</div>
            <div class="item-sub">{a.description}</div>
          </div>
          <div class="item-side">
            <div>{money(a.price, currency)}</div>
            <div>{date.format(new Date(a.datetime))}</div>
          </div>
        </div>
      )}
    />
  );
}

function ExistingList({ items }: { items: ExistingActivity[] }) {
  return (
    <Paged
      items={items}
      render={(a) => (
        <div class="list-item" key={a.id}>
          <span class={`badge ${a.type}`}>{TYPE_LABEL[a.type] ?? a.type}</span>
          <div class="item-main">
            <div class="item-title">{num.format(a.shares)} {a.symbol}</div>
          </div>
          <div class="item-side">{date.format(new Date(a.datetime))}</div>
        </div>
      )}
    />
  );
}

function BalanceTable({ rows, breakdown }: { rows: BalanceRow[]; breakdown: Record<string, BreakdownRow[]> }) {
  const off = rows.filter((r) => r.difference !== 0);
  return (
    <div class="card" style={{ marginTop: '1rem' }}>
      <div class="row" style={{ marginBottom: '0.6rem' }}>
        <strong>Balance check</strong>
        <span class={off.length ? 'small' : 'small muted'} style={off.length ? { color: 'var(--danger)' } : undefined}>
          {off.length ? `${off.length} of ${rows.length} coins differ` : `All ${rows.length} coins match`}
        </span>
      </div>
      <div class="table-wrap">
        <table class="balances">
          <thead>
            <tr><th>Coin</th><th>CoinTracking</th><th>Parqet</th><th>Difference</th></tr>
          </thead>
          <tbody>
            {[...off, ...rows.filter((r) => r.difference === 0)].map((r) => (
              <tr key={r.symbol}>
                <td>{r.symbol}</td>
                <td>{num.format(r.coinTracking)}</td>
                <td>{num.format(r.parqet)}</td>
                <td class={r.difference ? 'off' : 'muted'}>{r.difference ? num.format(r.difference) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p class="hint">Parqet amounts are the sum of the activities {APP_NAME} created. Differences usually come from skipped transactions.</p>
      {off.map((r) => breakdown[r.symbol] && (
        <details class="section" key={r.symbol}>
          <summary>Where the {r.symbol} difference comes from</summary>
          <div class="table-wrap">
            <table class="balances">
              <thead>
                <tr><th>CoinTracking type</th><th>CoinTracking</th><th>Parqet</th><th>Difference</th></tr>
              </thead>
              <tbody>
                {breakdown[r.symbol]!.map((b) => {
                  const d = Number((b.parqet - b.coinTracking).toFixed(10));
                  return (
                    <tr key={b.label}>
                      <td>{b.label}</td>
                      <td>{num.format(b.coinTracking)}</td>
                      <td>{num.format(b.parqet)}</td>
                      <td class={Math.abs(d) > 1e-8 ? 'off' : 'muted'}>{Math.abs(d) > 1e-8 ? num.format(d) : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p class="hint">“CoinTracking” is the net amount per type from your trade list. Fee rows show CoinTracking's fee fields. With “Already in amounts” these are not deducted in Parqet, so a difference in a fee row is expected there.</p>
        </details>
      ))}
    </div>
  );
}


const OptionsSheet = forwardRef<
  HTMLDialogElement,
  { options: SyncOptions; onChange: (o: SyncOptions) => void; canReset: boolean; onReset: () => void; busy: Busy }
>(function OptionsSheet({ options, onChange, canReset, onReset, busy }, ref) {
  const [mapText, setMapText] = useState(formatSymbolMap(options.symbolMap));
  const [skipText, setSkipText] = useState(options.skipSymbols.join(', '));
  useEffect(() => setMapText(formatSymbolMap(options.symbolMap)), [options.symbolMap]);
  useEffect(() => setSkipText(options.skipSymbols.join(', ')), [options.skipSymbols]);
  const set = (patch: Partial<SyncOptions>) => onChange({ ...options, ...patch });

  const choice = <K extends keyof SyncOptions>(key: K, label: string, values: Array<[SyncOptions[K], string]>, hint: string) => (
    <div class="sheet-section">
      <p class="sheet-label" id={`opt-${String(key)}`}>{label}</p>
      <div class="chips" role="radiogroup" aria-labelledby={`opt-${String(key)}`}>
        {values.map(([v, text]) => (
          <button key={String(v)} type="button" class="chip" role="radio" aria-checked={options[key] === v} onClick={() => set({ [key]: v } as Partial<SyncOptions>)}>
            {text}
          </button>
        ))}
      </div>
      <p class="hint">{hint}</p>
    </div>
  );

  return (
    <dialog ref={ref} class="sheet" aria-labelledby="options-title">
      <form
        method="dialog"
        class="sheet-inner"
        onSubmit={() => set({ symbolMap: parseSymbolMap(mapText), skipSymbols: parseSymbolList(skipText) })}
      >
        <h2 class="sheet-title" id="options-title">Options</h2>
        {choice('incomeAs', 'Staking, mining, airdrops', [['transfer_in', 'Transfer in'], ['buy', 'Buy']],
          'Transfer in adds the coins at market value without counting them as invested money.')}
        {choice('cryptoFees', 'Fees paid in crypto', [['included', 'Already in amounts'], ['separate', 'Deduct separately']],
          'CoinTracking usually includes fees in the traded amounts. Switch only if the balance check shows a difference equal to your fees.')}
        {choice('defiAsTransfers', 'Loans, collateral, liquidity', [[false, 'Skip'], [true, 'Import as transfers']],
          'Margin and futures trades are never imported.')}
        {choice('removeOrphans', 'Deleted in CoinTracking', [[false, 'Keep in Parqet'], [true, 'Remove from Parqet']],
          'Applies to activities this app created whose transaction no longer exists in CoinTracking.')}
        <div class="sheet-section">
          <label class="sheet-label" for="opt-map">Rename coins</label>
          <textarea id="opt-map" class="input" rows={3} placeholder="IOTA=MIOTA" value={mapText} onInput={(e) => setMapText(e.currentTarget.value)} />
          <p class="hint">One per line, CoinTracking symbol = Parqet symbol.</p>
        </div>
        <div class="sheet-section">
          <label class="sheet-label" for="opt-skip">Never import</label>
          <input id="opt-skip" class="input" placeholder="e.g. LUNC, SCAM" value={skipText} onInput={(e) => setSkipText(e.currentTarget.value)} />
        </div>
        <div class="sheet-section danger-zone">
          <p class="sheet-label">Start over</p>
          <button type="button" class="btn danger" disabled={!canReset || busy !== null} onClick={onReset}>
            {busy === 'reset' ? 'Removing…' : 'Remove all synced activities'}
          </button>
          <p class="hint">Deletes only what {APP_NAME} created in the selected portfolio.</p>
        </div>
        <div class="sheet-actions">
          <button class="btn primary" type="submit">Done</button>
        </div>
      </form>
    </dialog>
  );
});
