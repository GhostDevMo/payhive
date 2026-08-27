import type { Money } from '../lib/money.js';

/**
 * The provider seam.
 *
 * PayHive's stated first objective is securing a payment infrastructure
 * partner. That partner is not signed yet, so the application must not be
 * written against any one of them. Everything the outside world does for us
 * fits behind this interface; swapping Stripe for Nium, or running both in
 * different corridors, is one new file implementing `PaymentProvider` and a
 * config change.
 *
 * Note what is deliberately NOT here: user-to-user transfer. That is an
 * internal ledger movement and must never become a provider call.
 */

export interface DepositIntent {
  /** Provider-side id, stored on the transaction for reconciliation. */
  providerRef: string;
  /** Passed to the client SDK to complete the payment, when the provider uses one. */
  clientSecret?: string;
  /** Where to send the user, for redirect-based methods. */
  redirectUrl?: string;
  status: 'requires_action' | 'processing' | 'succeeded' | 'failed';
}

export interface PayoutRequest {
  providerRef: string;
  status: 'pending' | 'paid' | 'failed';
}

export interface DepositParams {
  userId: string;
  /** Provider-side customer id, if the provider keeps one. */
  customerRef?: string | null;
  amount: Money;
  description?: string;
  metadata?: Record<string, string>;
}

export interface PayoutParams {
  userId: string;
  /** Provider-side destination: a Connect account, bank token, or wallet id. */
  destinationRef: string;
  amount: Money;
  description?: string;
  metadata?: Record<string, string>;
}

/** A provider event, normalised so the webhook route doesn't care whose it is. */
export interface ProviderEvent {
  id: string;
  provider: string;
  type: 'deposit.succeeded' | 'deposit.failed' | 'payout.paid' | 'payout.failed' | 'ignored';
  providerRef: string | null;
  amount: Money | null;
  userId: string | null;
  raw: unknown;
}

export interface PaymentProvider {
  readonly name: string;

  /** Currencies this provider can actually settle. */
  supportedCurrencies(): string[];

  createDeposit(params: DepositParams): Promise<DepositIntent>;

  createPayout(params: PayoutParams): Promise<PayoutRequest>;

  /**
   * Verify the signature on a webhook and normalise it. Throws if the
   * signature is invalid — an unverified webhook is an open door to your
   * ledger, so this must never be softened to a warning.
   */
  parseWebhook(rawBody: Buffer, signature: string | undefined): Promise<ProviderEvent>;
}
