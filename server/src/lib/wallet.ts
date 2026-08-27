import { and, desc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import type { Transaction } from '../db/index.js';
import { accounts, postings, transactions, users } from '../db/schema.js';
import {
  InsufficientFunds,
  LedgerError,
  getOrCreateAccount,
  post,
} from './ledger.js';
import { toJSON, type Currency, type Money } from './money.js';
import { resolvePayee } from './handle.js';

/**
 * Wallet operations.
 *
 * These are the only three shapes of money movement in the current build:
 *
 *   deposit    system_funding -> user wallet    (money enters PayHive)
 *   transfer   user wallet    -> user wallet    (money moves inside PayHive)
 *   withdraw   user wallet    -> system_payout  (money leaves PayHive)
 *
 * Only deposit and withdraw touch an external provider. `transfer` never does:
 * it is a pair of rows in our own ledger, which is both the fastest possible
 * P2P send and the reason a card network is not involved in it.
 */

export class WalletError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'WalletError';
  }
}

export interface WalletBalance {
  accountId: string;
  currency: string;
  balance: ReturnType<typeof toJSON>;
}

/** Every wallet the user holds, one per currency they've touched. */
export async function listWallets(userId: string): Promise<WalletBalance[]> {
  const rows = await db
    .select({
      id: accounts.id,
      currency: accounts.currency,
      balance: accounts.balance,
    })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.kind, 'user_wallet')))
    .orderBy(accounts.currency);

  return rows.map((row) => ({
    accountId: row.id,
    currency: row.currency,
    balance: toJSON({ amount: BigInt(row.balance), currency: row.currency }),
  }));
}

/** Open a wallet in a currency the user doesn't hold yet. Idempotent. */
export async function openWallet(userId: string, currency: Currency): Promise<WalletBalance> {
  const account = await getOrCreateAccount(db, {
    kind: 'user_wallet',
    currency,
    userId,
  });
  return {
    accountId: account.id,
    currency: account.currency,
    balance: toJSON({ amount: BigInt(account.balance), currency: account.currency }),
  };
}

// ---------------------------------------------------------------------------
// Deposit
// ---------------------------------------------------------------------------

export interface DepositParams {
  userId: string;
  amount: Money;
  /** Stripe PaymentIntent id, or a mock reference in local dev. */
  providerRef: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Credit a wallet because money arrived from outside.
 *
 * `providerRef` carries a unique index, so a webhook delivered twice — which
 * Stripe will do — raises a duplicate-key error rather than crediting twice.
 * The caller treats that specific failure as success.
 */
export async function deposit(params: DepositParams): Promise<{ transactionId: string }> {
  if (params.amount.amount <= 0n) {
    throw new WalletError('Deposit amount must be positive', 'invalid_amount');
  }

  return db.transaction(async (tx) => {
    const wallet = await getOrCreateAccount(tx, {
      kind: 'user_wallet',
      currency: params.amount.currency,
      userId: params.userId,
    });
    const funding = await getOrCreateAccount(tx, {
      kind: 'system_funding',
      currency: params.amount.currency,
    });

    const result = await post(tx, {
      type: 'deposit',
      description: params.description ?? 'Wallet top-up',
      initiatedBy: params.userId,
      providerRef: params.providerRef,
      metadata: params.metadata ?? {},
      entries: [
        { accountId: funding.id, amount: -params.amount.amount, currency: params.amount.currency },
        { accountId: wallet.id, amount: params.amount.amount, currency: params.amount.currency },
      ],
    });

    return { transactionId: result.id };
  });
}

// ---------------------------------------------------------------------------
// Transfer — the P2P send
// ---------------------------------------------------------------------------

export interface TransferParams {
  fromUserId: string;
  /**
   * What the sender typed: a PayHive ID like "PH7K4M2Q9X" or a handle like
   * "alice.dev". Resolved by resolvePayee, so the sender does not have to know
   * which kind of address they were given.
   */
  to: string;
  amount: Money;
  note?: string;
}

export interface TransferResult {
  transactionId: string;
  from: { payhiveId: string; displayName: string };
  to: { payhiveId: string; displayName: string };
  amount: ReturnType<typeof toJSON>;
  createdAt: Date;
}

/**
 * Move money between two PayHive users.
 *
 * No external network call happens here and none should ever be added. The
 * entire operation is one database transaction containing two postings, which
 * is why it settles instantly and costs nothing per send.
 */
export async function transfer(params: TransferParams): Promise<TransferResult> {
  if (params.amount.amount <= 0n) {
    throw new WalletError('Transfer amount must be positive', 'invalid_amount');
  }

  return db.transaction(async (tx) => {
    const sender = await loadUser(tx, { id: params.fromUserId });
    if (!sender) throw new WalletError('Sender not found', 'sender_not_found', 404);

    const recipient = await resolvePayee(tx, params.to);
    if (!recipient) {
      throw new WalletError(
        `No PayHive user with ID or handle ${params.to}`,
        'recipient_not_found',
        404,
      );
    }
    if (recipient.id === sender.id) {
      throw new WalletError('You cannot send money to yourself', 'self_transfer');
    }

    const fromWallet = await getOrCreateAccount(tx, {
      kind: 'user_wallet',
      currency: params.amount.currency,
      userId: sender.id,
    });
    // Open the recipient's wallet in this currency if they don't have one yet,
    // so a first-time receiver doesn't need to pre-provision anything.
    const toWallet = await getOrCreateAccount(tx, {
      kind: 'user_wallet',
      currency: params.amount.currency,
      userId: recipient.id,
    });

    let result;
    try {
      result = await post(tx, {
        type: 'transfer',
        description: params.note ?? `Transfer to ${recipient.payhiveId}`,
        initiatedBy: sender.id,
        metadata: {
          fromPayhiveId: sender.payhiveId,
          toPayhiveId: recipient.payhiveId,
          note: params.note ?? null,
        },
        entries: [
          { accountId: fromWallet.id, amount: -params.amount.amount, currency: params.amount.currency },
          { accountId: toWallet.id, amount: params.amount.amount, currency: params.amount.currency },
        ],
      });
    } catch (error) {
      if (error instanceof InsufficientFunds) {
        throw new WalletError(
          `Not enough ${params.amount.currency} in your wallet`,
          'insufficient_funds',
          422,
        );
      }
      throw error;
    }

    return {
      transactionId: result.id,
      from: { payhiveId: sender.payhiveId, displayName: sender.displayName },
      to: { payhiveId: recipient.payhiveId, displayName: recipient.displayName },
      amount: toJSON(params.amount),
      createdAt: result.createdAt,
    };
  });
}

// ---------------------------------------------------------------------------
// Withdrawal
// ---------------------------------------------------------------------------

export interface WithdrawParams {
  userId: string;
  amount: Money;
  providerRef?: string | null;
  description?: string;
  metadata?: Record<string, unknown>;
}

/** Debit a wallet because money is leaving PayHive for a bank account. */
export async function withdraw(params: WithdrawParams): Promise<{ transactionId: string }> {
  if (params.amount.amount <= 0n) {
    throw new WalletError('Withdrawal amount must be positive', 'invalid_amount');
  }

  return db.transaction(async (tx) => {
    const wallet = await getOrCreateAccount(tx, {
      kind: 'user_wallet',
      currency: params.amount.currency,
      userId: params.userId,
    });
    const payout = await getOrCreateAccount(tx, {
      kind: 'system_payout',
      currency: params.amount.currency,
    });

    try {
      const result = await post(tx, {
        type: 'withdrawal',
        description: params.description ?? 'Withdrawal to bank account',
        initiatedBy: params.userId,
        providerRef: params.providerRef ?? null,
        metadata: params.metadata ?? {},
        entries: [
          { accountId: wallet.id, amount: -params.amount.amount, currency: params.amount.currency },
          { accountId: payout.id, amount: params.amount.amount, currency: params.amount.currency },
        ],
      });
      return { transactionId: result.id };
    } catch (error) {
      if (error instanceof InsufficientFunds) {
        throw new WalletError(
          `Not enough ${params.amount.currency} in your wallet`,
          'insufficient_funds',
          422,
        );
      }
      throw error;
    }
  });
}

/**
 * Put a withdrawal back after the payout failed.
 *
 * A withdrawal debits the wallet before the provider is called, because the
 * opposite order can send money that was never covered. The cost of that choice
 * is this function: when the provider refuses, the debit has to be undone.
 *
 * It is a new balanced entry rather than a deletion. The books record what
 * happened — money left, then came back — and a ledger that edits its own past
 * is not a ledger.
 */
export async function reverseWithdrawal(params: {
  userId: string;
  amount: Money;
  reversesTransactionId: string;
  reason: string;
}): Promise<{ transactionId: string }> {
  return db.transaction(async (tx) => {
    const wallet = await getOrCreateAccount(tx, {
      kind: 'user_wallet',
      currency: params.amount.currency,
      userId: params.userId,
    });
    const payout = await getOrCreateAccount(tx, {
      kind: 'system_payout',
      currency: params.amount.currency,
    });

    const result = await post(tx, {
      type: 'reversal',
      description: 'Withdrawal reversed: the payout could not be sent',
      initiatedBy: params.userId,
      metadata: { reverses: params.reversesTransactionId, reason: params.reason },
      entries: [
        { accountId: payout.id, amount: -params.amount.amount, currency: params.amount.currency },
        { accountId: wallet.id, amount: params.amount.amount, currency: params.amount.currency },
      ],
    });

    await tx
      .update(transactions)
      .set({ status: 'reversed' })
      .where(eq(transactions.id, params.reversesTransactionId));

    return { transactionId: result.id };
  });
}

/** Record the provider's reference once a payout has been accepted. */
export async function attachProviderRef(
  transactionId: string,
  providerRef: string,
): Promise<void> {
  await db.update(transactions).set({ providerRef }).where(eq(transactions.id, transactionId));
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export interface HistoryEntry {
  transactionId: string;
  type: string;
  description: string | null;
  currency: string;
  /** Signed from this user's point of view: negative means money left. */
  amount: ReturnType<typeof toJSON>;
  counterparty: string | null;
  createdAt: Date;
}

/**
 * Transaction history for one user, built from their own postings so the sign
 * is always from their perspective. Keyset pagination on (created_at, id) —
 * offset pagination silently skips rows once new transactions land mid-scroll.
 */
export async function history(
  userId: string,
  options: { limit?: number; before?: Date; currency?: string } = {},
): Promise<HistoryEntry[]> {
  const limit = Math.min(Math.max(options.limit ?? 25, 1), 100);

  const userAccounts = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.kind, 'user_wallet')));

  const accountIds = userAccounts.map((a) => a.id);
  if (accountIds.length === 0) return [];

  const conditions = [inArray(postings.accountId, accountIds)];
  if (options.before) conditions.push(lt(postings.createdAt, options.before));
  if (options.currency) conditions.push(eq(postings.currency, options.currency.toUpperCase()));

  const rows = await db
    .select({
      transactionId: postings.transactionId,
      amount: postings.amount,
      currency: postings.currency,
      createdAt: postings.createdAt,
      type: transactions.type,
      description: transactions.description,
      metadata: transactions.metadata,
    })
    .from(postings)
    .innerJoin(transactions, eq(transactions.id, postings.transactionId))
    .where(and(...conditions))
    .orderBy(desc(postings.createdAt), desc(postings.id))
    .limit(limit);

  return rows.map((row) => {
    const amount = BigInt(row.amount);
    const meta = (row.metadata ?? {}) as Record<string, unknown>;
    // On a transfer, the counterparty is whichever side isn't the sign we hold.
    const counterparty =
      row.type === 'transfer'
        ? amount < 0n
          ? ((meta.toPayhiveId as string) ?? null)
          : ((meta.fromPayhiveId as string) ?? null)
        : null;

    return {
      transactionId: row.transactionId,
      type: row.type,
      description: row.description,
      currency: row.currency,
      amount: toJSON({ amount, currency: row.currency }),
      counterparty,
      createdAt: row.createdAt,
    };
  });
}

// ---------------------------------------------------------------------------

async function loadUser(
  tx: Transaction,
  by: { id?: string; payhiveId?: string },
): Promise<{ id: string; payhiveId: string; displayName: string } | undefined> {
  const where = by.id ? eq(users.id, by.id) : eq(users.payhiveId, by.payhiveId!);
  const rows = await tx
    .select({ id: users.id, payhiveId: users.payhiveId, displayName: users.displayName })
    .from(users)
    .where(where)
    .limit(1);
  return rows[0];
}
