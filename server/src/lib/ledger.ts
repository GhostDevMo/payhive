import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Executor, Transaction } from '../db/index.js';
import { db } from '../db/index.js';
import {
  accounts,
  postings,
  transactions,
  type AccountKind,
  type TransactionType,
} from '../db/schema.js';
import { isSupportedCurrency, type Currency } from './money.js';

/**
 * The ledger.
 *
 * Everything that moves value in PayHive goes through `post()`. Nothing writes
 * to `accounts.balance` directly. That single choke point is what makes the
 * books provable: if the only way to change a balance is a balanced entry, the
 * books cannot drift.
 */

export class LedgerError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'LedgerError';
  }
}

export class InsufficientFunds extends LedgerError {
  constructor(
    readonly accountId: string,
    readonly currency: string,
    readonly available: bigint,
    readonly requested: bigint,
  ) {
    super(
      `Insufficient funds: account ${accountId} holds ${available} ${currency}, needs ${requested}`,
      'insufficient_funds',
    );
    this.name = 'InsufficientFunds';
  }
}

export interface Entry {
  accountId: string;
  /** Signed minor units. Negative debits the account, positive credits it. */
  amount: bigint;
  currency: Currency;
}

export interface PostInput {
  type: TransactionType;
  entries: Entry[];
  description?: string;
  initiatedBy?: string | null;
  /** Provider-side id (Stripe PaymentIntent, Payout…). Unique when present. */
  providerRef?: string | null;
  metadata?: Record<string, unknown>;
}

export interface PostedTransaction {
  id: string;
  type: TransactionType;
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

const SYSTEM_KINDS: AccountKind[] = ['system_funding', 'system_payout', 'system_fee'];

/**
 * Fetch or lazily create an account. User wallets are per (user, currency);
 * system accounts are per (kind, currency) and are shared.
 *
 * The insert uses ON CONFLICT DO NOTHING then re-selects, so two concurrent
 * first-time deposits in a new currency can't race into a duplicate wallet.
 */
export async function getOrCreateAccount(
  exec: Executor,
  params: { kind: AccountKind; currency: Currency; userId?: string | null },
): Promise<{ id: string; balance: bigint; currency: string; allowNegative: boolean }> {
  const currency = params.currency.toUpperCase();
  if (!isSupportedCurrency(currency)) {
    throw new LedgerError(`Unsupported currency: ${currency}`, 'unsupported_currency');
  }

  const isSystem = SYSTEM_KINDS.includes(params.kind);
  const userId = isSystem ? null : (params.userId ?? null);
  if (!isSystem && !userId) {
    throw new LedgerError(`Account kind ${params.kind} requires a userId`, 'missing_user');
  }

  const where = and(
    eq(accounts.kind, params.kind),
    eq(accounts.currency, currency),
    userId ? eq(accounts.userId, userId) : isNull(accounts.userId),
  );

  const existing = await exec.select().from(accounts).where(where).limit(1);
  if (existing[0]) return existing[0];

  await exec
    .insert(accounts)
    .values({
      kind: params.kind,
      currency,
      userId,
      // System accounts are the counterparty to the outside world and are
      // expected to run negative; a user wallet running negative is a bug.
      allowNegative: isSystem,
    })
    .onConflictDoNothing();

  const created = await exec.select().from(accounts).where(where).limit(1);
  if (!created[0]) {
    throw new LedgerError('Failed to create account', 'account_create_failed');
  }
  return created[0];
}

/**
 * The authoritative balance, computed from postings rather than read from the
 * cache column. Used by the reconciliation check and by tests.
 */
export async function derivedBalance(exec: Executor, accountId: string): Promise<bigint> {
  const result = await exec
    .select({ total: sql<bigint | null>`SUM(${postings.amount})` })
    .from(postings)
    .where(eq(postings.accountId, accountId));
  const total = result[0]?.total;
  return total === null || total === undefined ? 0n : BigInt(total);
}

// ---------------------------------------------------------------------------
// Posting
// ---------------------------------------------------------------------------

function validate(input: PostInput): void {
  if (input.entries.length < 2) {
    throw new LedgerError('A transaction needs at least two entries', 'unbalanced');
  }

  const byCurrency = new Map<string, bigint>();
  for (const entry of input.entries) {
    if (entry.amount === 0n) {
      throw new LedgerError('Zero-amount entries are not allowed', 'zero_entry');
    }
    const currency = entry.currency.toUpperCase();
    if (!isSupportedCurrency(currency)) {
      throw new LedgerError(`Unsupported currency: ${currency}`, 'unsupported_currency');
    }
    byCurrency.set(currency, (byCurrency.get(currency) ?? 0n) + entry.amount);
  }

  // Sum to zero *per currency*. A single-currency transfer balances trivially;
  // a future FX entry balances USD against USD and NGN against NGN through the
  // FX position accounts, never by netting one currency against another.
  for (const [currency, sum] of byCurrency) {
    if (sum !== 0n) {
      throw new LedgerError(
        `Entries do not balance for ${currency}: sum is ${sum}, expected 0`,
        'unbalanced',
      );
    }
  }
}

/**
 * Write one balanced journal entry.
 *
 * Must be called inside a DB transaction (`postInTransaction` wraps it for you).
 * Accounts are locked FOR UPDATE in ascending id order — a fixed global order
 * is what stops two simultaneous transfers between the same pair of users from
 * deadlocking each other.
 */
export async function post(tx: Transaction, input: PostInput): Promise<PostedTransaction> {
  validate(input);

  // Collapse repeated references to the same account into one net movement, so
  // each account is locked and updated exactly once.
  const net = new Map<string, { amount: bigint; currency: string }>();
  for (const entry of input.entries) {
    const current = net.get(entry.accountId);
    const currency = entry.currency.toUpperCase();
    if (current && current.currency !== currency) {
      throw new LedgerError(
        `Account ${entry.accountId} received entries in two currencies`,
        'currency_mismatch',
      );
    }
    net.set(entry.accountId, {
      amount: (current?.amount ?? 0n) + entry.amount,
      currency,
    });
  }

  const lockOrder = [...net.keys()].sort();

  const locked = new Map<string, { currency: string; balance: bigint; allowNegative: boolean }>();
  for (const accountId of lockOrder) {
    const rows = await tx
      .select({
        id: accounts.id,
        currency: accounts.currency,
        balance: accounts.balance,
        allowNegative: accounts.allowNegative,
      })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .for('update');

    const row = rows[0];
    if (!row) throw new LedgerError(`Unknown account: ${accountId}`, 'unknown_account');
    locked.set(accountId, {
      currency: row.currency,
      balance: BigInt(row.balance),
      allowNegative: row.allowNegative,
    });
  }

  // Check every account can absorb its movement BEFORE writing anything.
  for (const [accountId, movement] of net) {
    const account = locked.get(accountId)!;
    if (account.currency !== movement.currency) {
      throw new LedgerError(
        `Account ${accountId} is ${account.currency} but entry is ${movement.currency}`,
        'currency_mismatch',
      );
    }
    const next = account.balance + movement.amount;
    if (next < 0n && !account.allowNegative) {
      throw new InsufficientFunds(accountId, account.currency, account.balance, -movement.amount);
    }
  }

  const [created] = await tx
    .insert(transactions)
    .values({
      type: input.type,
      status: 'posted',
      description: input.description ?? null,
      initiatedBy: input.initiatedBy ?? null,
      providerRef: input.providerRef ?? null,
      metadata: input.metadata ?? {},
    })
    .returning({ id: transactions.id, createdAt: transactions.createdAt });

  if (!created) throw new LedgerError('Failed to create transaction', 'transaction_create_failed');

  await tx.insert(postings).values(
    input.entries.map((entry) => ({
      transactionId: created.id,
      accountId: entry.accountId,
      currency: entry.currency.toUpperCase(),
      amount: entry.amount,
    })),
  );

  // Update the cached balance with a relative increment, never an absolute
  // write — under the row lock this is safe, and it keeps the cache honest
  // even if two code paths disagree about what the balance "should" be.
  for (const [accountId, movement] of net) {
    await tx
      .update(accounts)
      .set({ balance: sql`${accounts.balance} + ${movement.amount}` })
      .where(eq(accounts.id, accountId));
  }

  return { id: created.id, type: input.type, createdAt: created.createdAt };
}

/** Convenience wrapper: opens a DB transaction and posts inside it. */
export async function postInTransaction(input: PostInput): Promise<PostedTransaction> {
  return db.transaction((tx) => post(tx, input));
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

export interface ReconciliationReport {
  ok: boolean;
  /** Accounts whose cached balance disagrees with the sum of their postings. */
  drift: Array<{ accountId: string; cached: bigint; derived: bigint }>;
  /** Journal entries that do not sum to zero. Should always be empty. */
  unbalanced: Array<{ transactionId: string; currency: string; sum: bigint }>;
  /** Per-currency total across every account. Should always be zero. */
  currencyTotals: Array<{ currency: string; total: bigint }>;
}

/**
 * Prove the books. Run this in a nightly job and alert on `ok === false`;
 * a payments platform that cannot demonstrate this on demand has nothing to
 * show a partner's diligence team.
 */
export async function reconcile(exec: Executor = db): Promise<ReconciliationReport> {
  const drift = await exec.execute(sql`
    SELECT a.id AS account_id,
           a.balance AS cached,
           COALESCE(SUM(p.amount), 0) AS derived
    FROM accounts a
    LEFT JOIN postings p ON p.account_id = a.id
    GROUP BY a.id, a.balance
    HAVING a.balance <> COALESCE(SUM(p.amount), 0)
  `);

  const unbalanced = await exec.execute(sql`
    SELECT transaction_id, currency, SUM(amount) AS sum
    FROM postings
    GROUP BY transaction_id, currency
    HAVING SUM(amount) <> 0
  `);

  const totals = await exec.execute(sql`
    SELECT currency, COALESCE(SUM(amount), 0) AS total
    FROM postings
    GROUP BY currency
    ORDER BY currency
  `);

  const driftRows = (drift.rows as Array<Record<string, unknown>>).map((r) => ({
    accountId: String(r.account_id),
    cached: BigInt(String(r.cached)),
    derived: BigInt(String(r.derived)),
  }));
  const unbalancedRows = (unbalanced.rows as Array<Record<string, unknown>>).map((r) => ({
    transactionId: String(r.transaction_id),
    currency: String(r.currency),
    sum: BigInt(String(r.sum)),
  }));
  const totalRows = (totals.rows as Array<Record<string, unknown>>).map((r) => ({
    currency: String(r.currency),
    total: BigInt(String(r.total)),
  }));

  return {
    ok:
      driftRows.length === 0 &&
      unbalancedRows.length === 0 &&
      totalRows.every((t) => t.total === 0n),
    drift: driftRows,
    unbalanced: unbalancedRows,
    currencyTotals: totalRows,
  };
}
