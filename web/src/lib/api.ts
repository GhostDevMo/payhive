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

const BASE = '/api';

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

async function call<T>(
  path: string,
  options: { method?: string; body?: unknown; idempotencyKey?: string } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;

  const response = await fetch(`${BASE}${path}`, {
    method: options.method ?? 'GET',
    headers,
    credentials: 'include',
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

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

export const api = {
  me: () => call<{ user: User }>('/auth/me'),

  signup: (input: { email: string; password: string; displayName: string; currency: string }) =>
    call<{ user: User }>('/auth/signup', { method: 'POST', body: input }),

  login: (input: { email: string; password: string }) =>
    call<{ user: User }>('/auth/login', { method: 'POST', body: input }),

  logout: () => call<void>('/auth/logout', { method: 'POST' }),

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
