// Cointracking2Parqet UI. Plain DOM, no framework, no build step.
// Data from CoinTracking and Parqet only ever reaches the page through esc() or textContent.
import { CoinTrackingClient, CoinTrackingError } from './core/cointracking.js';
import { suggestRenames } from './core/mapping.js';
import { OAuthError, ParqetOAuth } from './core/oauth.js';
import { ParqetAuthError, ParqetClient } from './core/parqet.js';
import { compareBalances, executePlan, explainDifference, fetchSource, makePlan, ownActivities } from './core/sync.js';
import * as vault from './core/vault.js';
import {
  formatSymbolMap, loadOptions, loadPortfolioId, parseSymbolList, parseSymbolMap, recentCalls, recordCall,
  saveOptions, savePortfolioId,
} from './prefs.js';

const APP_NAME = 'Cointracking2Parqet';
const $ = (id) => document.getElementById(id);

// ---------- formatting ----------

const num = new Intl.NumberFormat('en', { maximumFractionDigits: 8 });
const dateFmt = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' });
const money = (value, currency) => {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency, maximumSignificantDigits: 6 }).format(value);
  } catch {
    return `${num.format(value)} ${currency}`;
  }
};
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const TYPE_LABEL = { buy: 'Buy', sell: 'Sell', transfer_in: 'Transfer in', transfer_out: 'Transfer out' };
const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const typeClass = (t) => (TYPE_LABEL[t] ? t : '');

// ---------- state ----------

const state = {
  connected: false,
  portfolios: null,
  portfolioId: loadPortfolioId(),
  options: loadOptions(),
  source: null,
  existing: null,
  plan: null,
  planError: null,
  result: null,
  balances: null,
  breakdown: {},
  busy: null,
  progress: null,
  stored: vault.hasStored(),
};

let oauth;
let parqet;
let clientIdMissing = false;

// ---------- errors ----------

function describeError(e) {
  if (e instanceof ParqetAuthError || e instanceof OAuthError) {
    return { title: 'Parqet connection lost', detail: e.message, reconnect: true };
  }
  if (e instanceof CoinTrackingError) {
    const hints = {
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

function showError(e) {
  if (!e) {
    $('error').hidden = true;
    return;
  }
  const d = describeError(e);
  if (d.reconnect) {
    oauth.logout();
    state.connected = false;
  }
  $('error-title').textContent = d.title;
  $('error-detail').textContent = d.detail ?? '';
  $('error').hidden = false;
}

async function run(kind, fn) {
  state.busy = kind;
  showError(null);
  render();
  try {
    await fn();
  } catch (e) {
    showError(e);
  } finally {
    state.busy = null;
    state.progress = null;
    render();
  }
}

// ---------- derived ----------

const creds = () => ({ key: $('ct-key').value.trim(), secret: $('ct-secret').value.trim() });
const credsReady = () => {
  const c = creds();
  return c.key !== '' && c.secret !== '';
};
const portfolio = () => state.portfolios?.find((p) => p.id === state.portfolioId) ?? null;

function recomputePlan() {
  state.plan = null;
  state.planError = null;
  if (!state.source || !state.existing) return;
  try {
    state.plan = makePlan(state.source, state.existing, state.options);
  } catch (e) {
    state.planError = e.message;
  }
}

const changeCount = () =>
  state.plan
    ? state.plan.create.length + state.plan.deleteChanged.length + (state.options.removeOrphans ? state.plan.orphaned.length : 0)
    : 0;

function ctClient() {
  return new CoinTrackingClient(creds(), {
    onCall: (t) => {
      recordCall(t);
      $('ct-calls').textContent = String(recentCalls().length);
    },
  });
}

// ---------- actions ----------

async function connect() {
  await run('connect', async () => {
    location.assign(await oauth.beginLogin());
  });
}

function disconnect() {
  oauth.logout();
  Object.assign(state, { connected: false, portfolios: null, existing: null, plan: null });
  render();
}

async function loadPortfolios() {
  await run('portfolio', async () => {
    const list = await parqet.listPortfolios();
    state.portfolios = list;
    if (!list.some((p) => p.id === state.portfolioId)) selectPortfolio(list.length === 1 ? list[0].id : null);
  });
}

function selectPortfolio(id) {
  if (id === state.portfolioId) return;
  state.portfolioId = id;
  savePortfolioId(id);
  Object.assign(state, { existing: null, plan: null, result: null, balances: null, breakdown: {} });
  render();
}

async function createPortfolio(name) {
  await run('portfolio', async () => {
    if (!name.trim()) return;
    const id = await parqet.createPortfolio(name.trim());
    state.portfolios = await parqet.listPortfolios();
    $('new-portfolio-form').hidden = true;
    selectPortfolio(id);
  });
}

async function unlock() {
  await run('connect', async () => {
    let c;
    try {
      c = await vault.unlock($('unlock-pass').value);
    } catch {
      throw new Error('That passphrase does not unlock the saved key.');
    }
    $('ct-key').value = c.key;
    $('ct-secret').value = c.secret;
    $('unlock-pass').value = '';
  });
}

async function preview(refetch) {
  await run('preview', async () => {
    if (!state.portfolioId) return;
    Object.assign(state, { result: null, balances: null, breakdown: {} });
    if ($('remember').checked && $('passphrase').value) {
      await vault.store(creds(), $('passphrase').value);
      state.stored = true;
      $('remember').checked = false;
      $('passphrase').value = '';
    }
    if (refetch || !state.source) state.source = await fetchSource(ctClient());
    state.existing = await parqet.listCryptoActivities(state.portfolioId);
    recomputePlan();
  });
}

async function sync() {
  await run('sync', async () => {
    if (!state.plan || !state.portfolioId) return;
    state.result = await executePlan(parqet, state.portfolioId, state.plan, { removeOrphans: state.options.removeOrphans }, (p) => {
      state.progress = p;
      renderCta();
    });
    state.existing = await parqet.listCryptoActivities(state.portfolioId);
    recomputePlan();
  });
}

async function checkBalances() {
  await run('balances', async () => {
    if (!state.portfolioId) return;
    const { amounts } = await ctClient().getBalance();
    const acts = await parqet.listCryptoActivities(state.portfolioId);
    state.existing = acts;
    recomputePlan();
    const rows = compareBalances(amounts, ownActivities(acts), state.options.symbolMap, state.options.skipSymbols);
    state.balances = rows;
    const trades = state.source?.trades ?? [];
    state.breakdown = Object.fromEntries(
      rows.filter((r) => r.difference !== 0).map((r) => [r.symbol, explainDifference(r.symbol, trades, acts, state.options.symbolMap)]),
    );
  });
}

async function resetAll() {
  await run('reset', async () => {
    if (!state.portfolioId) return;
    const own = ownActivities(await parqet.listCryptoActivities(state.portfolioId));
    if (own.length === 0) return;
    const ok = confirm(
      `Delete ${own.length} activities that ${APP_NAME} created in “${portfolio()?.name}”? Activities you added yourself stay.`,
    );
    if (!ok) return;
    await parqet.deleteActivities(state.portfolioId, own.map((a) => a.id));
    state.existing = await parqet.listCryptoActivities(state.portfolioId);
    state.result = null;
    recomputePlan();
    $('options').close();
  });
}

function setOptions(patch) {
  state.options = { ...state.options, ...patch };
  saveOptions(state.options);
  recomputePlan();
  render();
}

// ---------- rendering ----------

function render() {
  renderParqet();
  renderCreds();
  renderReview();
  renderCta();
  renderOptions();
}

function renderParqet() {
  const done = state.connected && !!portfolio();
  $('step-parqet').textContent = done ? '✓' : '1';
  $('step-parqet').classList.toggle('done', done);
  $('parqet-disconnected').hidden = state.connected;
  $('parqet-connected').hidden = !state.connected;
  $('connect').disabled = state.busy !== null || clientIdMissing;
  $('connect-label').textContent = state.busy === 'connect' ? 'Connecting…' : 'Connect with Parqet';
  $('pf-loading').hidden = state.portfolios !== null;

  const chips = (state.portfolios ?? [])
    .map(
      (p) =>
        `<button type="button" class="chip" role="radio" data-portfolio="${esc(p.id)}" aria-checked="${p.id === state.portfolioId}">${esc(p.name)}</button>`,
    )
    .join('');
  const add = $('new-portfolio-form').hidden && state.portfolios !== null
    ? '<button type="button" class="chip add" data-new-portfolio>+ New portfolio</button>'
    : '';
  const html = chips + add;
  if ($('portfolios').innerHTML !== html) $('portfolios').innerHTML = html;
}

function renderCreds() {
  const ready = credsReady();
  $('step-ct').textContent = ready ? '✓' : '2';
  $('step-ct').classList.toggle('done', ready);
  const locked = state.stored && !ready;
  $('unlock-form').hidden = !locked;
  $('creds-form').hidden = locked;
  $('remember-row').hidden = state.stored;
  $('passphrase-row').hidden = !$('remember').checked;
  $('ct-calls').textContent = String(recentCalls().length);
}

function renderCta() {
  const cta = $('cta');
  const p = state.progress;
  let label = 'Preview changes';
  let disabled = !state.connected || !state.portfolioId || !credsReady() || state.busy !== null;
  let action = 'preview';
  if (state.plan && state.busy === null) {
    const n = changeCount();
    label = n ? `Sync ${plural(n, 'change', 'changes')}` : 'Up to date';
    disabled = n === 0;
    action = 'sync';
  }
  if (state.busy === 'preview') label = 'Reading transactions…';
  if (state.busy === 'sync') {
    label = p ? `${p.phase === 'create' ? 'Adding' : 'Removing'} ${p.done} / ${p.total}…` : 'Syncing…';
    disabled = true;
  }
  cta.textContent = label;
  cta.disabled = disabled;
  cta.dataset.action = action;
  cta.classList.toggle('loading', state.busy === 'preview' || state.busy === 'sync');
  $('cta-note').hidden = !!state.plan || state.connected;
}

function renderOptions() {
  for (const group of document.querySelectorAll('[data-option]')) {
    const key = group.dataset.option;
    for (const chip of group.querySelectorAll('[data-value]')) {
      chip.setAttribute('aria-checked', String(String(state.options[key]) === chip.dataset.value));
    }
  }
  $('reset').disabled = !state.connected || !state.portfolioId || state.busy !== null;
  $('reset').textContent = state.busy === 'reset' ? 'Removing…' : 'Remove all synced activities';
}

function tradeSummary(t) {
  const b = t.buyAmount ? `+${num.format(t.buyAmount)} ${t.buyCurrency}` : '';
  const s = t.sellAmount ? `−${num.format(t.sellAmount)} ${t.sellCurrency}` : '';
  return [b, s].filter(Boolean).join('  ') || '—';
}

const PAGE = 50;
const shown = {};
const openSections = new Set(['create']);

function listHtml(key, items, rowHtml) {
  const limit = shown[key] ?? PAGE;
  const more =
    items.length > limit
      ? `<div class="more"><button type="button" class="btn link small" data-more="${key}">Show more (${items.length - limit} left)</button></div>`
      : '';
  return `<div class="list">${items.slice(0, limit).map(rowHtml).join('')}${more}</div>`;
}

function section(key, summary, inner) {
  return `<details class="section" data-section="${key}"${openSections.has(key) ? ' open' : ''}><summary>${esc(summary)}</summary>${inner}</details>`;
}

const activityRow = (currency) => (a) => `
  <div class="list-item">
    <span class="badge ${typeClass(a.type)}">${esc(TYPE_LABEL[a.type] ?? a.type)}</span>
    <div class="item-main">
      <div class="item-title">${esc(num.format(a.shares))} ${esc(a.symbol)}</div>
      <div class="item-sub">${esc(a.description)}${a.fee ? ` · fee ${esc(money(a.fee, currency))}` : ''}</div>
    </div>
    <div class="item-side"><div>${esc(money(a.price, currency))}</div><div>${esc(dateFmt.format(new Date(a.datetime)))}</div></div>
  </div>`;

const existingRow = (a) => `
  <div class="list-item">
    <span class="badge ${typeClass(a.type)}">${esc(TYPE_LABEL[a.type] ?? a.type)}</span>
    <div class="item-main"><div class="item-title">${esc(num.format(a.shares))} ${esc(a.symbol)}</div></div>
    <div class="item-side">${esc(dateFmt.format(new Date(a.datetime)))}</div>
  </div>`;

const tradeRow = (t, note, badgeClass) => `
  <div class="list-item">
    <span class="badge ${badgeClass}">${esc(t.type)}</span>
    <div class="item-main"><div class="item-title">${esc(tradeSummary(t))}</div><div class="item-sub">${esc(note)}</div></div>
    <div class="item-side">${esc(dateFmt.format(t.time * 1000))}</div>
  </div>`;

const stat = (value, label, cls = '') =>
  `<div class="stat ${cls}"><div class="stat-value">${value}</div><div class="stat-label">${esc(label)}</div></div>`;

function renderReview() {
  const { plan, source } = state;
  $('review').hidden = !plan && !state.planError;
  $('plan-error').hidden = !state.planError;
  $('plan-error-text').textContent = state.planError ?? '';
  $('result').innerHTML = state.result ? resultHtml(state.result) : '';
  if (!plan || !source) {
    $('renames').hidden = true;
    $('stats').innerHTML = '';
    $('sections').innerHTML = '';
    $('balances').innerHTML = '';
    return;
  }
  const currency = source.accountCurrency;

  const renames = suggestRenames(
    plan.trades.flatMap((t) => [t.mapped.trade.buyCurrency, t.mapped.trade.sellCurrency, t.mapped.trade.feeCurrency]).filter(Boolean),
    state.options.symbolMap,
  );
  $('renames').hidden = renames.length === 0;
  $('renames-text').textContent = ` CoinTracking adds a number to tickers that exist twice. Parqet most likely knows ${renames
    .map((r) => `${r.from} as ${r.to}`)
    .join(', ')}.`;
  $('renames-apply').textContent = `Rename ${renames.map((r) => `${r.from} → ${r.to}`).join(', ')}`;
  $('renames-apply').onclick = () =>
    setOptions({ symbolMap: { ...state.options.symbolMap, ...Object.fromEntries(renames.map((r) => [r.from, r.to])) } });

  $('stats').innerHTML =
    stat(plan.counts.new, 'New', 'new') +
    stat(plan.counts.changed, 'Changed', 'changed') +
    stat(plan.counts.unchanged, 'In sync') +
    stat(plan.counts.skipped, 'Skipped') +
    (plan.counts.orphaned ? stat(plan.counts.orphaned, 'Deleted in CT', 'removed') : '');

  const skipped = plan.trades.filter((t) => t.status === 'skipped');
  const notes = plan.trades.filter((t) => t.mapped.notes.length && t.status !== 'skipped');
  let html = '';
  if (plan.create.length)
    html += section('create', `${plural(plan.create.length, 'activity', 'activities')} to add`, listHtml('create', plan.create, activityRow(currency)));
  if (plan.deleteChanged.length)
    html += section('replace', `${plural(plan.deleteChanged.length, 'outdated activity', 'outdated activities')} to replace`, listHtml('replace', plan.deleteChanged, existingRow));
  if (plan.orphaned.length)
    html += section(
      'orphaned',
      `${plural(plan.orphaned.length, 'activity', 'activities')} whose transaction was deleted in CoinTracking${state.options.removeOrphans ? ' (will be removed)' : ' (kept, see Options)'}`,
      listHtml('orphaned', plan.orphaned, existingRow),
    );
  if (skipped.length)
    html += section('skipped', `${plural(skipped.length, 'transaction', 'transactions')} skipped`, listHtml('skipped', skipped, (t) => tradeRow(t.mapped.trade, t.mapped.skipped, 'skip')));
  if (notes.length)
    html += section('notes', `${plural(notes.length, 'transaction', 'transactions')} with notes`, listHtml('notes', notes, (t) => tradeRow(t.mapped.trade, t.mapped.notes.join(' · '), '')));
  $('sections').innerHTML = html;

  $('fetched-at').textContent = `Transactions read ${dateFmt.format(source.fetchedAt)}`;
  $('check-balances').disabled = state.busy !== null;
  $('check-balances').textContent = state.busy === 'balances' ? 'Checking…' : 'Check balances';
  $('read-again').disabled = state.busy !== null;
  $('balances').innerHTML = state.balances ? balancesHtml(state.balances, state.breakdown) : '';
}

function resultHtml(r) {
  const ok = r.failures.length === 0 && r.notDeleted === 0;
  let html = `<div class="notice ${ok ? 'success' : 'warning'}" role="status"><strong>${ok ? 'Sync complete.' : 'Sync finished with problems.'} Added ${r.created}, removed ${r.deleted}.</strong>`;
  if (r.notDeleted > 0) {
    html += `<p>Parqet did not delete ${plural(r.notDeleted, 'outdated activity', 'outdated activities')}. They still count twice. Please report this.</p>`;
  }
  if (r.failures.length) {
    html += `Parqet rejected ${plural(r.failures.length, 'activity', 'activities')}.`;
    if (r.keptBecauseOfFailure > 0) html += ` The previous version of ${r.keptBecauseOfFailure} was kept.`;
    html += `<ul>${r.failures
      .slice(0, 10)
      .map((f) => `<li>${esc(f.activity.symbol)} ${esc(TYPE_LABEL[f.activity.type] ?? f.activity.type)} on ${esc(f.activity.datetime.slice(0, 10))}: ${esc(f.message || f.code)}</li>`)
      .join('')}</ul>`;
    if (r.failures.some((f) => /asset|symbol|not.?found|security/i.test(f.code + f.message))) {
      html += '<p class="mt-04">Unknown coin symbols can be renamed or skipped under Options.</p>';
    }
  }
  return `${html}</div>`;
}

function balancesHtml(rows, breakdown) {
  const off = rows.filter((r) => r.difference !== 0);
  const ordered = [...off, ...rows.filter((r) => r.difference === 0)];
  const summary = off.length ? `${off.length} of ${rows.length} coins differ` : `All ${rows.length} coins match`;
  let html = `<div class="card mt-1">
    <div class="row mb-06"><strong>Balance check</strong>
      <span class="small ${off.length ? 'text-danger' : 'muted'}">${summary}</span></div>
    <div class="table-wrap"><table class="balances">
      <thead><tr><th>Coin</th><th>CoinTracking</th><th>Parqet</th><th>Difference</th></tr></thead>
      <tbody>${ordered
        .map(
          (r) =>
            `<tr><td>${esc(r.symbol)}</td><td>${num.format(r.coinTracking)}</td><td>${num.format(r.parqet)}</td><td class="${r.difference ? 'off' : 'muted'}">${r.difference ? num.format(r.difference) : '—'}</td></tr>`,
        )
        .join('')}</tbody>
    </table></div>
    <p class="hint">Parqet amounts are the sum of the activities ${APP_NAME} created. Differences usually come from skipped transactions.</p>`;
  for (const r of off) {
    const rowsB = breakdown[r.symbol];
    if (!rowsB) continue;
    const body = rowsB
      .map((b) => {
        const d = Number((b.parqet - b.coinTracking).toFixed(10));
        const show = Math.abs(d) > 1e-8;
        return `<tr><td>${esc(b.label)}</td><td>${num.format(b.coinTracking)}</td><td>${num.format(b.parqet)}</td><td class="${show ? 'off' : 'muted'}">${show ? num.format(d) : '—'}</td></tr>`;
      })
      .join('');
    html += section(
      `why-${r.symbol}`,
      `Where the ${r.symbol} difference comes from`,
      `<div class="table-wrap"><table class="balances"><thead><tr><th>CoinTracking type</th><th>CoinTracking</th><th>Parqet</th><th>Difference</th></tr></thead><tbody>${body}</tbody></table></div>
       <p class="hint">“CoinTracking” is the net amount per type from your trade list. Fee rows show CoinTracking's fee fields. With “Already in amounts” these are not deducted in Parqet, so a difference in a fee row is expected there.</p>`,
    );
  }
  return `${html}</div>`;
}

// ---------- events ----------

function wire() {
  $('connect').addEventListener('click', connect);
  $('disconnect').addEventListener('click', disconnect);

  $('portfolios').addEventListener('click', (e) => {
    const chip = e.target.closest('button');
    if (!chip) return;
    if (chip.hasAttribute('data-new-portfolio')) {
      $('new-portfolio-form').hidden = false;
      renderParqet();
      $('new-portfolio-name').focus();
      $('new-portfolio-name').select();
    } else if (chip.dataset.portfolio) selectPortfolio(chip.dataset.portfolio);
  });
  $('new-portfolio-form').addEventListener('submit', (e) => {
    e.preventDefault();
    createPortfolio($('new-portfolio-name').value);
  });
  $('new-portfolio-cancel').addEventListener('click', () => {
    $('new-portfolio-form').hidden = true;
    renderParqet();
  });

  for (const id of ['ct-key', 'ct-secret']) $(id).addEventListener('input', () => {
    renderCreds();
    renderCta();
  });
  $('remember').addEventListener('change', renderCreds);
  $('unlock-form').addEventListener('submit', (e) => {
    e.preventDefault();
    unlock();
  });
  $('forget').addEventListener('click', () => {
    vault.forget();
    state.stored = false;
    render();
  });

  $('cta').addEventListener('click', () => ($('cta').dataset.action === 'sync' ? sync() : preview(false)));
  $('read-again').addEventListener('click', () => preview(true));
  $('check-balances').addEventListener('click', checkBalances);

  const review = $('review');
  review.addEventListener('click', (e) => {
    const more = e.target.closest('[data-more]');
    if (!more) return;
    const key = more.dataset.more;
    shown[key] = (shown[key] ?? PAGE) + PAGE * 4;
    renderReview();
  });
  // Remember which sections are open across re-renders. "toggle" does not bubble, so listen while capturing.
  review.addEventListener(
    'toggle',
    (e) => {
      const key = e.target.dataset?.section;
      if (!key) return;
      if (e.target.open) openSections.add(key);
      else openSections.delete(key);
    },
    true,
  );

  // Options sheet
  $('open-options').addEventListener('click', () => {
    $('opt-map').value = formatSymbolMap(state.options.symbolMap);
    $('opt-skip').value = state.options.skipSymbols.join(', ');
    $('options').showModal();
  });
  for (const group of document.querySelectorAll('[data-option]')) {
    group.addEventListener('click', (e) => {
      const chip = e.target.closest('[data-value]');
      if (!chip) return;
      const raw = chip.dataset.value;
      setOptions({ [group.dataset.option]: raw === 'true' ? true : raw === 'false' ? false : raw });
    });
  }
  $('options-form').addEventListener('submit', () =>
    setOptions({ symbolMap: parseSymbolMap($('opt-map').value), skipSymbols: parseSymbolList($('opt-skip').value) }),
  );
  $('reset').addEventListener('click', resetAll);
}

// ---------- start ----------

async function start() {
  let config = { clientId: '', authorizeUrl: 'https://connect.parqet.com/oauth2/authorize' };
  try {
    const res = await fetch('/api/config');
    if (res.ok) config = await res.json();
  } catch {
    /* relay unreachable: the login button stays disabled */
  }
  clientIdMissing = !config.clientId;
  $('setup-notice').hidden = !clientIdMissing;

  oauth = new ParqetOAuth({
    clientId: config.clientId,
    authorizeUrl: config.authorizeUrl,
    tokenUrl: '/api/parqet/oauth2/token',
    redirectUri: `${location.origin}/callback`,
    scope: 'portfolio:read portfolio:write',
  });
  parqet = new ParqetClient(() => oauth.accessToken());
  state.connected = oauth.isConnected();

  wire();
  render();

  const url = new URL(location.href);
  if (oauth.isCallback(url)) {
    history.replaceState(null, '', '/');
    await run('connect', async () => {
      await oauth.completeLogin(url);
      state.connected = true;
    });
  }
  if (state.connected) await loadPortfolios();
}

start();
