import type { ExistingActivity, ParqetCryptoActivity, Portfolio } from './types';

export class ParqetError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'ParqetError';
  }
}

export class ParqetAuthError extends ParqetError {
  constructor(status: number, body?: unknown) {
    super(status, 'Your Parqet session has expired. Please connect again.', body);
    this.name = 'ParqetAuthError';
  }
}

export interface CreateFailure {
  activity: ParqetCryptoActivity;
  code: string;
  message: string;
}

export interface CreateResult {
  created: number;
  failures: CreateFailure[];
}

export interface ParqetClientOptions {
  base?: string;
  fetch?: typeof fetch;
  /** Waits between retries. Replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
}

export const BATCH_SIZE = 100;

export function chunk<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

export class ParqetClient {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly getToken: () => Promise<string>,
    options: ParqetClientOptions = {},
  ) {
    this.base = options.base ?? '/api/parqet';
    this.fetchImpl = options.fetch ?? fetch.bind(globalThis);
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const token = await this.getToken();
      const res = await this.fetchImpl(this.base + path, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        const retryAfter = Number(res.headers.get('retry-after'));
        await this.sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt);
        continue;
      }
      const text = await res.text();
      const json: unknown = text ? safeJson(text) : undefined;
      if (res.status === 401) throw new ParqetAuthError(res.status, json);
      if (!res.ok) throw new ParqetError(res.status, errorMessage(res.status, json), json);
      return json as T;
    }
  }

  async listPortfolios(): Promise<Portfolio[]> {
    const res = await this.request<{ items: Array<{ id: string; name: string; currency: string }> }>('GET', '/portfolios');
    return res.items.map(({ id, name, currency }) => ({ id, name, currency }));
  }

  async createPortfolio(name: string): Promise<string> {
    const res = await this.request<{ id: string }>('POST', '/portfolios', { name });
    return res.id;
  }

  /** All crypto activities of a portfolio, following the cursor. */
  async listCryptoActivities(portfolioId: string): Promise<ExistingActivity[]> {
    const out: ExistingActivity[] = [];
    let cursor: string | null = null;
    do {
      const q = new URLSearchParams({ limit: '500', assetType: 'crypto' });
      if (cursor) q.set('cursor', cursor);
      const res: { activities: RawActivity[]; cursor?: string | null } = await this.request(
        'GET',
        `/portfolios/${encodeURIComponent(portfolioId)}/activities?${q}`,
      );
      for (const a of res.activities) {
        out.push({
          id: a.id,
          externalId: a.externalId,
          type: a.type,
          symbol: a.asset && 'symbol' in a.asset ? a.asset.symbol : undefined,
          shares: a.shares ?? 0,
          datetime: a.datetime,
        });
      }
      cursor = res.cursor ?? null;
    } while (cursor);
    return out;
  }

  async createActivities(
    portfolioId: string,
    activities: ParqetCryptoActivity[],
    onProgress?: (done: number) => void,
  ): Promise<CreateResult> {
    let created = 0;
    const failures: CreateFailure[] = [];
    let done = 0;
    for (const batch of chunk(activities, BATCH_SIZE)) {
      const res = await this.request<{
        createdActivities?: Array<{ _id?: string }>;
        notCreatedActivities?: Array<{ error?: { originalIndex?: number; code?: string; message?: string } }>;
      }>('POST', `/portfolios/${encodeURIComponent(portfolioId)}/activities`, { activities: batch });
      created += res.createdActivities?.length ?? 0;
      for (const nc of res.notCreatedActivities ?? []) {
        const idx = nc.error?.originalIndex;
        const activity = idx !== undefined ? batch[idx] : undefined;
        if (activity) failures.push({ activity, code: nc.error?.code ?? 'unknown', message: nc.error?.message ?? '' });
      }
      done += batch.length;
      onProgress?.(done);
    }
    return { created, failures };
  }

  /**
   * Deletes activities and returns how many Parqet confirmed.
   * Listing returns ids like "cpa_<objectId>" while create/delete answer with a bare "_id", and Parqet
   * silently ignores ids it doesn't know. So each id is sent in both forms; the unknown form is a no-op.
   */
  async deleteActivities(portfolioId: string, ids: string[]): Promise<number> {
    const forms = [...new Set(ids.flatMap((id) => [id, id.replace(/^[a-z]+_/, '')]))];
    const deleted = new Set<string>();
    for (const batch of chunk(forms, BATCH_SIZE)) {
      const res = await this.request<{ deletedActivities?: Array<{ _id?: string }> }>(
        'DELETE',
        `/portfolios/${encodeURIComponent(portfolioId)}/activities`,
        { activityIds: batch },
      );
      for (const d of res.deletedActivities ?? []) if (d._id) deleted.add(d._id.replace(/^[a-z]+_/, ''));
    }
    return deleted.size;
  }
}

interface RawActivity {
  id: string;
  externalId?: string;
  type: string;
  shares?: number;
  datetime: string;
  asset?: { assetIdentifierType: string; symbol?: string };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function errorMessage(status: number, body: unknown): string {
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    const msg = b.message ?? b.error ?? b.relayError;
    if (msg) return `Parqet error ${status}: ${Array.isArray(msg) ? msg.join(', ') : String(msg)}`;
  }
  return `Parqet error ${status}`;
}
