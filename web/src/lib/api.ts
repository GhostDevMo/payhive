import { IS_NATIVE, readTokens, writeTokens, type StoredTokens } from './tokenStore';
/**
 * API client.
 *
 * Two things this file is careful about:
 *
 *  1. Amounts are strings end to end. The server sends minor units as a string
 *     and a pre-formatted display value; the client never parses either into a
 *     JS number, because Number can't hold large minor-unit amounts exactly and
 *     a wallet balance is the wrong place to find that out.
 *  2. Every money-moving call carries a fresh Idempotency-Key, generated before
 *     the first attempt and reused across retries of that same attempt.
 */

/**
 * Where the API is, and how this client proves who it is.
 *
 * On the web the app and the API share an origin, so /api is a relative path
 * and the session rides along as an httpOnly cookie that JavaScript cannot
 * read. In a native shell there is no shared origin — the app is served from
 * capacitor://localhost — so the API needs an absolute URL and the session has
 * to travel as a bearer token instead. WKWebView drops the cookie either way.
 */
const BASE = IS_NATIVE ? `${import.meta.env.VITE_API_URL ?? ''}/api` : '/api';

/**
 * The live session, held in memory.
 *
 * Memory is the source of truth while the app runs; the secure store exists so
 * a relaunch does not force a sign-in. Keeping it this way lets every request
 * read the token synchronously while persistence stays asynchronous, which is
 * what the platform keystores require.
 */
let tokens: StoredTokens | null = null;

/** Restore a session saved by a previous launch. Call once, at startup. */
export async function hydrateSession(): Promise<void> {
  tokens = await readTokens();
}

export function storeTokens(next: StoredTokens | null): void {
  tokens = next;
  void writeTokens(next);
}

/** What login and signup should send, so the server knows which to issue. */
export const CLIENT_KIND = IS_NATIVE ? 'mobile' : 'web';

export { IS_NATIVE };

export interface MoneyValue {
  amount: string;
  currency: string;
  formatted: string;
  exponent: number;
}

export interface User {
  id: string;
  /** Permanent address for this wallet. Never changes. */
  payhiveId: string;
  /** Optional chosen alias that resolves to the same wallet. */
  handle?: string | null;
  email: string;
  displayName: string;
  kycStatus?: string;
}

export interface BankAccount {
  id: string;
  institution: string;
  last4: string;
  currency: string;
  country: string;
  isDefault: boolean;
  /** False when the account is linked but cannot yet receive a payout. */
  payoutReady: boolean;
  createdAt: string;
}

export interface Wallet {
  accountId: string;
  currency: string;
  balance: MoneyValue;
}

export interface TransactionRow {
  transactionId: string;
  type: 'deposit' | 'transfer' | 'withdrawal' | 'fee' | 'reversal';
  description: string | null;
  currency: string;
  amount: MoneyValue;
  counterparty: string | null;
  createdAt: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function send(
  path: string,
  options: { method?: string; body?: unknown; idempotencyKey?: string },
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;

  if (tokens) headers.Authorization = `Bearer ${tokens.accessToken}`;

  return fetch(`${BASE}${path}`, {
    method: options.method ?? 'GET',
    headers,
    credentials: 'include',
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

/**
 * Exchange the refresh token for a new pair.
 *
 * Shared across concurrent callers: several requests expiring at once must
 * produce one refresh, not several. A second exchange of the same token is
 * treated by the server as theft and signs the user out, so racing here would
 * log people out for no reason.
 */
let refreshing: Promise<boolean> | null = null;

async function refreshTokens(): Promise<boolean> {
  refreshing ??= (async () => {
    if (!tokens) return false;
    try {
      const response = await fetch(`${BASE}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: tokens.refreshToken }),
      });
      if (!response.ok) {
        storeTokens(null);
        return false;
      }
      const payload = (await response.json()) as { tokens: StoredTokens };
      storeTokens({
        accessToken: payload.tokens.accessToken,
        refreshToken: payload.tokens.refreshToken,
      });
      return true;
    } catch {
      return false;
    } finally {
      refreshing = null;
    }
  })();

  return refreshing;
}

async function call<T>(
  path: string,
  options: { method?: string; body?: unknown; idempotencyKey?: string } = {},
): Promise<T> {
  let response = await send(path, options);

  // A native access token is short-lived by design, so one 401 is expected
  // rather than exceptional. Retried once, with the same idempotency key, so a
  // money-moving call that crossed an expiry cannot be applied twice.
  if (response.status === 401 && tokens && !path.startsWith('/auth/refresh')) {
    if (await refreshTokens()) response = await send(path, options);
  }

  if (response.status === 204) return undefined as T;

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const error = (payload as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(
      error?.message ?? `Request failed (${response.status})`,
      error?.code ?? 'unknown',
      response.status,
    );
  }

  return payload as T;
}

export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

async function authenticate(
  path: string,
  input: Record<string, unknown>,
): Promise<{ user: User }> {
  const result = await call<{ user: User; tokens?: StoredTokens }>(path, {
    method: 'POST',
    body: { ...input, client: CLIENT_KIND },
  });

  if (result.tokens) {
    storeTokens({
      accessToken: result.tokens.accessToken,
      refreshToken: result.tokens.refreshToken,
    });
  }

  return { user: result.user };
}

export const api = {
  me: () => call<{ user: User }>('/auth/me'),

  /**
   * Sign up or in.
   *
   * The client kind travels with the request so the server knows which
   * credential to issue: a cookie for a browser, a token pair for a native
   * shell. Storing the pair happens here so no screen has to know the
   * difference.
   */
  signup: (input: { email: string; password: string; displayName: string; currency: string }) =>
    authenticate('/auth/signup', input),

  login: (input: { email: string; password: string }) => authenticate('/auth/login', input),

  logout: async () => {
    const current = tokens;
    await call<void>('/auth/logout', {
      method: 'POST',
      body: current ? { refreshToken: current.refreshToken } : {},
    });
    storeTokens(null);
  },

  wallets: () => call<{ wallets: Wallet[] }>('/wallets'),

  currencies: () => call<{ currencies: string[] }>('/wallets/currencies'),

  openWallet: (currency: string) =>
    call<{ wallet: Wallet }>('/wallets', { method: 'POST', body: { currency } }),

  /** Accepts a PayHive ID or a handle — the payer should not have to know which. */
  lookupRecipient: (address: string) =>
    call<{ recipient: { payhiveId: string; handle: string | null; displayName: string } }>(
      `/wallets/recipients/${encodeURIComponent(address)}`,
    ),

  setHandle: (handle: string) =>
    call<{ handle: string }>('/auth/me/handle', { method: 'PUT', body: { handle } }),

  updateProfile: (input: { displayName?: string; email?: string; currentPassword?: string }) =>
    call<{ user: User }>('/auth/me', { method: 'PATCH', body: input }),

  changePassword: (input: { currentPassword: string; newPassword: string }) =>
    call<void>('/auth/me/password', { method: 'PUT', body: input }),

  bankAccounts: () => call<{ bankAccounts: BankAccount[] }>('/bank-accounts'),

  /** Step one of linking: a short-lived token the aggregator's UI opens with. */
  bankLinkToken: (input: { currency: string; country: string }) =>
    call<{ linkToken: string; provider: string; usesClientSdk: boolean }>(
      '/bank-accounts/link-token',
      { method: 'POST', body: input },
    ),

  /** Step two: hand back what the aggregator gave the browser. */
  linkBankAccount: (input: { publicToken: string; accountId?: string; country: string }) =>
    call<{ bankAccount: BankAccount }>('/bank-accounts', { method: 'POST', body: input }),

  setDefaultBankAccount: (id: string) =>
    call<{ bankAccount: BankAccount }>(`/bank-accounts/${encodeURIComponent(id)}/default`, {
      method: 'POST',
    }),

  removeBankAccount: (id: string) =>
    call<void>(`/bank-accounts/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  deposit: (input: { amount: string; currency: string }, key: string) =>
    call<{ deposit: { status: string; transactionId?: string; clientSecret?: string | null } }>(
      '/deposits',
      { method: 'POST', body: input, idempotencyKey: key },
    ),

  transfer: (
    input: { to: string; amount: string; currency: string; note?: string },
    key: string,
  ) =>
    call<{
      transfer: {
        transactionId: string;
        to: { payhiveId: string; handle?: string | null; displayName: string };
        amount: MoneyValue;
      };
    }>('/wallets/transfers', { method: 'POST', body: input, idempotencyKey: key }),

  withdraw: (input: { amount: string; currency: string }, key: string) =>
    call<{ withdrawal: { transactionId: string } }>('/wallets/withdrawals', {
      method: 'POST',
      body: input,
      idempotencyKey: key,
    }),

  transactions: (params: { currency?: string; limit?: number } = {}) => {
    const search = new URLSearchParams();
    if (params.currency) search.set('currency', params.currency);
    if (params.limit) search.set('limit', String(params.limit));
    const query = search.toString();
    return call<{ transactions: TransactionRow[] }>(`/wallets/transactions${query ? `?${query}` : ''}`);
  },
};
