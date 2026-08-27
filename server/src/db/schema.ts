import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  timestamp,
  bigint,
  jsonb,
  boolean,
  index,
  uniqueIndex,
  char,
} from 'drizzle-orm/pg-core';

/**
 * PayHive ledger schema.
 *
 * Design rules (do not break these):
 *  1. Money is ALWAYS a signed integer in the currency's minor unit (cents, kobo).
 *     Never a float. `bigint` mode 'bigint' so it arrives in JS as a BigInt.
 *  2. Every movement of value is a `transaction` with two or more `postings`.
 *     The postings of a transaction MUST sum to zero per currency. This is
 *     enforced by a deferred constraint trigger in the migration, not just here.
 *  3. Balances are derived from postings. `accounts.balance` is a cache kept in
 *     the same DB transaction under a row lock; tests assert cache == derived.
 */

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Public handle used to send money to this user, e.g. "PH7K4M2Q9X". */
    payhiveId: text('payhive_id').notNull(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    displayName: text('display_name').notNull(),
    /** 'unverified' | 'pending' | 'verified' | 'rejected' */
    kycStatus: text('kyc_status').notNull().default('unverified'),
    /** Stripe Customer id, for funding this wallet by card. */
    stripeCustomerId: text('stripe_customer_id'),
    /** Stripe Connect account id, for paying this user out. */
    stripeAccountId: text('stripe_account_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    emailIdx: uniqueIndex('users_email_key').on(t.email),
    payhiveIdIdx: uniqueIndex('users_payhive_id_key').on(t.payhiveId),
  }),
);

export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: index('sessions_user_idx').on(t.userId),
  }),
);

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

/**
 * Account kinds.
 *
 *  user_wallet     - a user's spendable balance. May never go negative.
 *  system_funding  - the outside world money arrives FROM (card charges).
 *                    Goes negative by design; its magnitude is what we've taken in.
 *  system_payout   - the outside world money leaves TO (bank payouts).
 *  system_fee      - PayHive revenue.
 *
 * System accounts are the counterparty that keeps every entry balanced. Without
 * them a deposit would be a single-sided posting, which is how ledgers rot.
 */
export const ACCOUNT_KINDS = [
  'user_wallet',
  'system_funding',
  'system_payout',
  'system_fee',
] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];

export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').$type<AccountKind>().notNull(),
    /** Null for system accounts. */
    userId: uuid('user_id').references(() => users.id, { onDelete: 'restrict' }),
    currency: char('currency', { length: 3 }).notNull(),
    /** Cached balance in minor units. Authoritative value is SUM(postings.amount). */
    balance: bigint('balance', { mode: 'bigint' }).notNull().default(sql`0`),
    /** System accounts may go negative; user wallets may not. */
    allowNegative: boolean('allow_negative').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userCurrencyIdx: uniqueIndex('accounts_user_currency_kind_key').on(
      t.userId,
      t.currency,
      t.kind,
    ),
    kindIdx: index('accounts_kind_idx').on(t.kind, t.currency),
  }),
);

export const TRANSACTION_TYPES = ['deposit', 'transfer', 'withdrawal', 'fee', 'reversal'] as const;
export type TransactionType = (typeof TRANSACTION_TYPES)[number];

export const TRANSACTION_STATUSES = ['pending', 'posted', 'failed', 'reversed'] as const;
export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];

/** A journal entry. The postings belonging to it must sum to zero per currency. */
export const transactions = pgTable(
  'transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    type: text('type').$type<TransactionType>().notNull(),
    status: text('status').$type<TransactionStatus>().notNull().default('posted'),
    /** Human-facing note shown in transaction history. */
    description: text('description'),
    /** The user who caused this, if any. */
    initiatedBy: uuid('initiated_by').references(() => users.id, { onDelete: 'set null' }),
    /** Provider-side identifier, e.g. a Stripe PaymentIntent or Payout id. */
    providerRef: text('provider_ref'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Partial unique index: a provider reference may appear at most once, so a
    // webhook replayed by Stripe cannot credit the same wallet twice. NULLs are
    // excluded because internal transfers have no provider reference at all.
    providerRefIdx: uniqueIndex('transactions_provider_ref_key')
      .on(t.providerRef)
      .where(sql`provider_ref IS NOT NULL`),
    createdIdx: index('transactions_created_idx').on(t.createdAt),
  }),
);

/**
 * One side of a journal entry.
 *
 * `amount` is signed: negative debits the account, positive credits it.
 * A user's balance is SUM(amount) over their postings.
 */
export const postings = pgTable(
  'postings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    transactionId: uuid('transaction_id')
      .notNull()
      .references(() => transactions.id, { onDelete: 'restrict' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict' }),
    currency: char('currency', { length: 3 }).notNull(),
    amount: bigint('amount', { mode: 'bigint' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    txIdx: index('postings_transaction_idx').on(t.transactionId),
    accountIdx: index('postings_account_idx').on(t.accountId, t.createdAt),
  }),
);

// ---------------------------------------------------------------------------
// Safety rails
// ---------------------------------------------------------------------------

/**
 * Idempotency: a client retrying a transfer must not move money twice.
 * The stored response is replayed verbatim on a repeat of the same key.
 */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    key: text('key').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    endpoint: text('endpoint').notNull(),
    /** SHA-256 of the request body: same key + different body is a client bug. */
    requestHash: text('request_hash').notNull(),
    responseStatus: bigint('response_status', { mode: 'number' }),
    responseBody: jsonb('response_body').$type<unknown>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: index('idempotency_user_idx').on(t.userId),
  }),
);

/** Webhook dedupe: providers retry, and retries must not re-credit a wallet. */
export const providerEvents = pgTable('provider_events', {
  id: text('id').primaryKey(),
  provider: text('provider').notNull(),
  type: text('type').notNull(),
  payload: jsonb('payload').$type<unknown>().notNull(),
  processedAt: timestamp('processed_at', { withTimezone: true }).notNull().defaultNow(),
});
