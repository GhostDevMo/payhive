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
    /** Permanent public address for this wallet, e.g. "PH7K4M2Q9X". Never changes. */
    payhiveId: text('payhive_id').notNull(),
    /** Optional user-chosen alias, e.g. "alice.dev". Resolves to the same wallet. */
    handle: text('handle'),
    /**
     * The handle folded to the form uniqueness is enforced on: separators
     * stripped and lookalike characters collapsed, so `a1ice` cannot be
     * registered alongside `alice`. See lib/handle.ts.
     */
    handleSkeleton: text('handle_skeleton'),
    /** When the handle last changed, for the change cooldown. */
    handleUpdatedAt: timestamp('handle_updated_at', { withTimezone: true }),
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
    // Uniqueness lives on the skeleton, not the handle: two names that look
    // alike must not both exist. Postgres treats NULLs as distinct, so users
    // without a handle do not collide with each other.
    handleSkeletonIdx: uniqueIndex('users_handle_skeleton_key').on(t.handleSkeleton),
  }),
);

/**
 * Handles that have been released and may never be claimed again.
 *
 * A handle someone has shared is an address other people have written down.
 * Letting it resolve to a different person later turns a stale contact into a
 * payment to a stranger, so released names are burned rather than recycled.
 */
/**
 * A bank account a user has linked through an aggregator.
 *
 * What is deliberately NOT here: the account number, the routing number, and
 * the user's bank password. The user authenticates inside the aggregator's own
 * UI, and PayHive keeps only tokens and enough to recognise the account on
 * screen. Holding the real details would put this database in a compliance
 * category the product has not signed up for, and buys nothing — the
 * aggregator and the payment provider are the only parties that need them.
 *
 * `accessTokenEncrypted` is the one genuine secret in this table. It is a
 * long-lived credential to the user's bank data, so it is encrypted at rest and
 * never leaves the server. See lib/secrets.ts.
 */
/**
 * Long-lived credentials for native clients.
 *
 * A phone cannot hold a session cookie: the app is served from its own origin,
 * so every call is cross-site and WKWebView will drop the cookie. Native
 * clients therefore carry a short-lived access token and exchange this for a
 * new one when it expires.
 *
 * Three properties this table exists to provide:
 *
 *  - The token is stored HASHED. A leaked database must not hand over live
 *    sessions, and unlike a password these are high-entropy random values, so
 *    a single SHA-256 is enough — no salt or work factor needed.
 *  - Each use ROTATES the token, so a stolen one has a short useful life.
 *  - Tokens are grouped into a FAMILY. Presenting one that has already been
 *    used means two parties hold it, which means it was stolen; the whole
 *    family is revoked rather than trying to guess which holder is genuine.
 */
export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** SHA-256 of the token. The token itself is shown once and never stored. */
    tokenHash: text('token_hash').notNull(),
    /** All tokens descended from one login. Revoked together on reuse. */
    familyId: uuid('family_id').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** Set the moment it is exchanged. A second use is evidence of theft. */
    usedAt: timestamp('used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    hashIdx: uniqueIndex('refresh_tokens_hash_key').on(t.tokenHash),
    familyIdx: index('refresh_tokens_family_idx').on(t.familyId),
    userIdx: index('refresh_tokens_user_idx').on(t.userId),
  }),
);

export const bankAccounts = pgTable(
  'bank_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Which aggregator linked it, so a swap cannot silently reuse its tokens. */
    provider: text('provider').notNull(),
    /** The aggregator's id for the bank login. */
    itemId: text('item_id').notNull(),
    /** The chosen account within that login. */
    externalAccountId: text('external_account_id').notNull(),
    /** AES-256-GCM. Never selected into anything that reaches a client. */
    accessTokenEncrypted: text('access_token_encrypted').notNull(),
    /**
     * Token the payment provider pays out to. Null when the aggregator could
     * not mint one for this processor or region, which means the account is
     * linked and visible but not yet payable.
     */
    destinationRef: text('destination_ref'),
    /** For display only. */
    institution: text('institution').notNull(),
    last4: text('last4').notNull(),
    currency: text('currency').notNull(),
    country: text('country').notNull(),
    /** 'active' | 'removed'. Rows are retired, never deleted: a past payout refers to them. */
    status: text('status').notNull().default('active'),
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    removedAt: timestamp('removed_at', { withTimezone: true }),
  },
  (t) => ({
    userIdx: index('bank_accounts_user_idx').on(t.userId),
    // One default per user, enforced by the database rather than by remembering
    // to clear the old one.
    defaultIdx: uniqueIndex('bank_accounts_one_default')
      .on(t.userId)
      .where(sql`is_default AND status = 'active'`),
  }),
);

export const retiredHandles = pgTable('retired_handles', {
  /** The folded form, matching users.handle_skeleton. */
  skeleton: text('skeleton').primaryKey(),
  /** The handle as it was written, kept for support and audit. */
  handle: text('handle').notNull(),
  /** Who released it. Null for names retired by us rather than by a user. */
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  retiredAt: timestamp('retired_at', { withTimezone: true }).notNull().defaultNow(),
});

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
