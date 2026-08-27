/**
 * Linked bank accounts.
 *
 * The user authenticates with their bank inside the aggregator's UI, so no
 * function here ever receives an account number or a bank password. What
 * crosses into PayHive is a short-lived public token, exchanged once for
 * credentials that are encrypted before they touch the database.
 *
 * The read path returns a deliberately narrow view. Nothing that can be used to
 * move money or read bank data is selectable by anything that answers an HTTP
 * request.
 */

import { and, asc, eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { getBankLinkProvider } from '../banking/index.js';
import { encryptSecret } from './secrets.js';
import { isSupportedCurrency } from './money.js';

const { bankAccounts } = schema;

export class BankError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'BankError';
  }
}

/** Everything a user is allowed to see about their own linked accounts. */
export interface BankAccountView {
  id: string;
  institution: string;
  last4: string;
  currency: string;
  country: string;
  isDefault: boolean;
  /** False when the aggregator could not mint a payout token for this account. */
  payoutReady: boolean;
  createdAt: Date;
}

const columns = {
  id: bankAccounts.id,
  institution: bankAccounts.institution,
  last4: bankAccounts.last4,
  currency: bankAccounts.currency,
  country: bankAccounts.country,
  isDefault: bankAccounts.isDefault,
  destinationRef: bankAccounts.destinationRef,
  createdAt: bankAccounts.createdAt,
};

type Row = {
  id: string;
  institution: string;
  last4: string;
  currency: string;
  country: string;
  isDefault: boolean;
  destinationRef: string | null;
  createdAt: Date;
};

/** destinationRef is a payout capability, not information — report it as a boolean. */
function toView(row: Row): BankAccountView {
  const { destinationRef, ...rest } = row;
  return { ...rest, payoutReady: destinationRef !== null };
}

export async function listBankAccounts(userId: string): Promise<BankAccountView[]> {
  const rows = await db
    .select(columns)
    .from(bankAccounts)
    .where(and(eq(bankAccounts.userId, userId), eq(bankAccounts.status, 'active')))
    .orderBy(asc(bankAccounts.createdAt));

  return rows.map(toView);
}

/** Open a link session for the client SDK. */
export async function startBankLink(params: {
  userId: string;
  currency: string;
  country: string;
  redirectUri?: string;
}): Promise<{ linkToken: string; expiresAt: Date; provider: string; usesClientSdk: boolean }> {
  const currency = params.currency.toUpperCase();
  if (!isSupportedCurrency(currency)) {
    throw new BankError(`${currency} is not a supported currency`, 'unsupported_currency');
  }

  const country = params.country.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) {
    throw new BankError('Country must be a two-letter code, e.g. US or NG', 'invalid_country');
  }

  const provider = getBankLinkProvider();
  try {
    const session = await provider.createLinkSession({ ...params, currency, country });
    return {
      linkToken: session.linkToken,
      expiresAt: session.expiresAt,
      provider: provider.name,
      usesClientSdk: provider.usesClientSdk,
    };
  } catch (error) {
    throw new BankError(
      error instanceof Error ? error.message : 'Could not start a bank link session',
      'link_failed',
      502,
    );
  }
}

/**
 * Finish a link: exchange the public token and store what comes back.
 *
 * The exchange happens before the insert, so a failure leaves no row rather
 * than a row pointing at a link that does not exist.
 */
export async function completeBankLink(params: {
  userId: string;
  publicToken: string;
  accountId?: string;
  country?: string;
}): Promise<BankAccountView> {
  const provider = getBankLinkProvider();

  let linked;
  try {
    linked = await provider.exchange({
      userId: params.userId,
      publicToken: params.publicToken,
      accountId: params.accountId,
    });
  } catch (error) {
    // The aggregator's message is written for the end user — "your bank is
    // down for maintenance" is worth passing through verbatim.
    throw new BankError(
      error instanceof Error ? error.message : 'Could not link that account',
      'link_rejected',
    );
  }

  const currency = linked.currency.toUpperCase();
  if (!isSupportedCurrency(currency)) {
    throw new BankError(
      `PayHive cannot pay out in ${currency} yet`,
      'unsupported_currency',
    );
  }

  // Encrypt before the transaction: if the key is missing this must fail
  // without having written anything.
  const accessTokenEncrypted = encryptSecret(linked.accessToken);

  return db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: bankAccounts.id, externalAccountId: bankAccounts.externalAccountId })
      .from(bankAccounts)
      .where(and(eq(bankAccounts.userId, params.userId), eq(bankAccounts.status, 'active')));

    if (existing.some((row) => row.externalAccountId === linked.accountId)) {
      throw new BankError('That account is already linked', 'already_linked', 409);
    }

    const [created] = await tx
      .insert(bankAccounts)
      .values({
        userId: params.userId,
        provider: provider.name,
        itemId: linked.itemId,
        externalAccountId: linked.accountId,
        accessTokenEncrypted,
        destinationRef: linked.processorToken,
        institution: linked.institution,
        last4: linked.mask,
        currency,
        country: (params.country ?? 'US').toUpperCase(),
        // The first account becomes the default, so withdrawing never asks a
        // question with only one possible answer.
        isDefault: existing.length === 0,
      })
      .returning(columns);

    return toView(created!);
  });
}

export async function setDefaultBankAccount(
  userId: string,
  bankAccountId: string,
): Promise<BankAccountView> {
  return db.transaction(async (tx) => {
    const [target] = await tx
      .select({ id: bankAccounts.id })
      .from(bankAccounts)
      .where(
        and(
          eq(bankAccounts.id, bankAccountId),
          eq(bankAccounts.userId, userId),
          eq(bankAccounts.status, 'active'),
        ),
      )
      .limit(1);

    if (!target) throw new BankError('No such bank account', 'bank_account_not_found', 404);

    // Clear first: the partial unique index permits one default per user, so
    // setting before clearing would collide with the row being replaced.
    await tx
      .update(bankAccounts)
      .set({ isDefault: false })
      .where(and(eq(bankAccounts.userId, userId), eq(bankAccounts.isDefault, true)));

    const [updated] = await tx
      .update(bankAccounts)
      .set({ isDefault: true })
      .where(eq(bankAccounts.id, bankAccountId))
      .returning(columns);

    return toView(updated!);
  });
}

/**
 * Unlink an account.
 *
 * Marked removed rather than deleted: a completed withdrawal refers to where
 * the money went, and that record has to stay legible. The stored credential is
 * cleared at the same time, because there is no longer any reason to hold it.
 */
export async function removeBankAccount(userId: string, bankAccountId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [target] = await tx
      .select({ id: bankAccounts.id, isDefault: bankAccounts.isDefault })
      .from(bankAccounts)
      .where(
        and(
          eq(bankAccounts.id, bankAccountId),
          eq(bankAccounts.userId, userId),
          eq(bankAccounts.status, 'active'),
        ),
      )
      .limit(1);

    if (!target) throw new BankError('No such bank account', 'bank_account_not_found', 404);

    await tx
      .update(bankAccounts)
      .set({
        status: 'removed',
        isDefault: false,
        removedAt: new Date(),
        accessTokenEncrypted: '',
        destinationRef: null,
      })
      .where(eq(bankAccounts.id, bankAccountId));

    // Removing the default promotes the oldest remaining account, so the user
    // is not silently left without a destination.
    if (target.isDefault) {
      const [next] = await tx
        .select({ id: bankAccounts.id })
        .from(bankAccounts)
        .where(and(eq(bankAccounts.userId, userId), eq(bankAccounts.status, 'active')))
        .orderBy(asc(bankAccounts.createdAt))
        .limit(1);

      if (next) {
        await tx.update(bankAccounts).set({ isDefault: true }).where(eq(bankAccounts.id, next.id));
      }
    }
  });
}

/** The destination a withdrawal should go to, checked for currency and payability. */
export async function resolvePayoutDestination(
  userId: string,
  currency: string,
  bankAccountId?: string,
): Promise<{ id: string; destinationRef: string; institution: string; last4: string }> {
  const rows = await db
    .select({
      id: bankAccounts.id,
      destinationRef: bankAccounts.destinationRef,
      institution: bankAccounts.institution,
      last4: bankAccounts.last4,
      currency: bankAccounts.currency,
      isDefault: bankAccounts.isDefault,
    })
    .from(bankAccounts)
    .where(and(eq(bankAccounts.userId, userId), eq(bankAccounts.status, 'active')));

  const chosen = bankAccountId
    ? rows.find((row) => row.id === bankAccountId)
    : (rows.find((row) => row.isDefault) ?? rows[0]);

  if (!chosen) {
    throw new BankError('Link a bank account before withdrawing', 'no_bank_account', 409);
  }
  if (chosen.currency !== currency) {
    throw new BankError(
      `That account receives ${chosen.currency}, not ${currency}`,
      'currency_mismatch',
    );
  }
  if (!chosen.destinationRef) {
    throw new BankError(
      'That account is linked but cannot receive payouts yet',
      'not_payout_ready',
      409,
    );
  }

  return {
    id: chosen.id,
    destinationRef: chosen.destinationRef,
    institution: chosen.institution,
    last4: chosen.last4,
  };
}
