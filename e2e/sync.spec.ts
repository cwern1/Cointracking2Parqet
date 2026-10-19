import { expect, test, type Page } from '@playwright/test';

const UPSTREAM = 'http://localhost:9911';
const SHOTS = process.env.SCREENSHOT_DIR;

async function state() {
  return (await (await fetch(`${UPSTREAM}/__state`)).json()) as {
    activities: Record<string, Array<{ externalId?: string; type: string; shares: number }>>;
    ctCalls: string[];
    seen: Array<{ path: string; headers: Record<string, string>; body: string }>;
  };
}

async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-${name}.png`, fullPage: true });
}

test.beforeEach(async () => {
  await fetch(`${UPSTREAM}/__reset`);
});

async function connectAndEnterKey(page: Page) {
  await page.goto('/');
  await shot(page, '01-start');
  await page.getByRole('button', { name: 'Connect Parqet' }).click();
  await expect(page.getByText('Connected')).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  await page.getByRole('radio', { name: 'Depot' }).click();
  await page.getByLabel('API key').fill('ct-key');
  await page.getByLabel('API secret').fill('ct-secret');
}

test('connect, preview, sync, stay idempotent, react to option changes', async ({ page }) => {
  const browserRequests: string[] = [];
  page.on('request', (r) => browserRequests.push(`${r.url()} ${JSON.stringify(r.headers())} ${r.postData() ?? ''}`));

  await connectAndEnterKey(page);
  await page.getByRole('button', { name: 'Preview changes' }).click();

  await expect(page.locator('.stat.new .stat-value')).toHaveText('7');
  await expect(page.getByText('8 activities to add')).toBeVisible();
  await shot(page, '02-preview');

  await page.getByRole('button', { name: 'Sync 8 changes' }).click();
  await expect(page.getByText('Sync complete. Added 8, removed 0.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Up to date' })).toBeDisabled();
  expect((await state()).activities.pf_main).toHaveLength(8);
  await shot(page, '03-synced');

  // Changing an option needs no new CoinTracking call and shows the replacement right away.
  const callsBefore = (await state()).ctCalls.length;
  await page.getByRole('button', { name: 'Options' }).click();
  await page.getByRole('radio', { name: 'Buy' }).click();
  await shot(page, '04-options');
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('button', { name: 'Sync 2 changes' })).toBeVisible();
  expect((await state()).ctCalls.length).toBe(callsBefore);
  await page.getByRole('button', { name: 'Sync 2 changes' }).click();
  await expect(page.getByText('Sync complete. Added 1, removed 1.')).toBeVisible();
  const staking = (await state()).activities.pf_main!.filter((a) => a.externalId?.startsWith('ct-1003-'));
  expect(staking.map((a) => a.type)).toEqual(['buy']);

  await page.getByRole('button', { name: 'Check balances' }).click();
  await expect(page.getByText('Balance check', { exact: true })).toBeVisible();
  // Exactly the coins whose transactions are skipped differ: the loan (USDC) and the unpriced airdrop (FOO).
  await expect(page.getByText('2 of 5 coins differ')).toBeVisible();
  await shot(page, '05-balances');

  // The API secret must never leave the browser: not to the relay, not to any upstream.
  expect(browserRequests.filter((r) => r.includes('ct-secret'))).toEqual([]);
  expect((await state()).seen.filter((s) => JSON.stringify(s).includes('ct-secret'))).toEqual([]);
  // But the signed requests did reach CoinTracking.
  expect((await state()).ctCalls).toEqual(['getTrades', 'getLedger', 'getBalance']);
});

test('shows CoinTracking errors and recovers', async ({ page }) => {
  await connectAndEnterKey(page);
  await page.getByLabel('API secret').fill('wrong');
  await page.getByRole('button', { name: 'Preview changes' }).click();
  await expect(page.getByRole('alert')).toContainText('Check your API secret.');
  await shot(page, '06-error');
  await page.getByLabel('API secret').fill('ct-secret');
  await page.getByRole('button', { name: 'Preview changes' }).click();
  await expect(page.locator('.stat.new .stat-value')).toHaveText('7');
});

test('creates a portfolio and resets synced activities', async ({ page }) => {
  await connectAndEnterKey(page);
  await page.getByRole('button', { name: '+ New portfolio' }).click();
  await page.getByLabel('Portfolio name').fill('CT Sync (Test)');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('radio', { name: 'CT Sync (Test)' })).toHaveAttribute('aria-checked', 'true');

  await page.getByRole('button', { name: 'Preview changes' }).click();
  await page.getByRole('button', { name: 'Sync 8 changes' }).click();
  await expect(page.getByText('Sync complete.')).toBeVisible();

  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Options' }).click();
  await page.getByRole('button', { name: 'Remove all synced activities' }).click();
  await expect(page.getByRole('button', { name: 'Sync 8 changes' })).toBeVisible();
  const s = await state();
  const id = Object.keys(s.activities).find((k) => k !== 'pf_main')!;
  expect(s.activities[id]).toHaveLength(0);
});

test('remembers the key encrypted and unlocks it after a reload', async ({ page }) => {
  await connectAndEnterKey(page);
  await page.getByLabel('Remember in this browser').check();
  await page.getByLabel('Passphrase', { exact: true }).fill('hunter2-long-passphrase');
  await page.getByRole('button', { name: 'Preview changes' }).click();
  await expect(page.locator('.stat.new .stat-value')).toHaveText('7');

  const stored = await page.evaluate(() => localStorage.getItem('cb.vault') ?? '');
  expect(stored).not.toContain('ct-secret');
  expect(stored).not.toContain('ct-key');

  await page.reload();
  await page.getByLabel('Passphrase for your saved API key').fill('hunter2-long-passphrase');
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.getByLabel('API key')).toHaveValue('ct-key');
});

test('suggests renaming CoinTracking duplicate tickers and applies it without new API calls', async ({ page }) => {
  await fetch(`${UPSTREAM}/__ct/trades`, {
    method: 'POST',
    body: JSON.stringify([
      { id: '1', type: 'Trade', buy: [2, 'SOL2'], sell: [360, 'EUR'], fee: [0.01, 'SOL2'], exchange: 'Kraken', time: 1_736_943_780, prices: { SOL2: 180 } },
    ]),
  });
  await connectAndEnterKey(page);
  await page.getByRole('button', { name: 'Preview changes' }).click();
  await expect(page.getByText('Check these coin symbols')).toBeVisible();
  await expect(page.getByText('2 SOL2', { exact: true })).toBeVisible();
  const calls = (await state()).ctCalls.length;

  await page.getByRole('button', { name: 'Rename SOL2 → SOL' }).click();
  await expect(page.getByText('Check these coin symbols')).toHaveCount(0);
  await expect(page.getByText('2 SOL', { exact: true })).toBeVisible();

  // The rename must survive opening and closing the options.
  await page.getByRole('button', { name: 'Options' }).click();
  await expect(page.getByLabel('Rename coins')).toHaveValue('SOL2=SOL');
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByText('Check these coin symbols')).toHaveCount(0);
  expect((await state()).ctCalls.length).toBe(calls);

  await page.getByRole('button', { name: 'Sync 1 change' }).click();
  await expect(page.getByText('Sync complete. Added 1, removed 0.')).toBeVisible();
  const symbols = (await state()).activities.pf_main!.map((a) => (a as { asset?: { symbol: string } }).asset?.symbol);
  expect(symbols).toEqual(['SOL']);
});
