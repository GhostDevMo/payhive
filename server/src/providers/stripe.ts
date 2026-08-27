import Stripe from 'stripe';
import { money, type Money } from '../lib/money.js';
import type {
  DepositIntent,
  DepositParams,
  PaymentProvider,
  PayoutParams,
  PayoutRequest,
  ProviderEvent,
} from './types.js';

/**
 * Stripe adapter.
 *
 * Scope note, and it matters: Stripe is the rail for money ENTERING and
 * LEAVING PayHive — card and bank funding in, Connect payouts out. It is not
 * the rail for user-to-user sends, and this file deliberately exposes no way
 * to make it one.
 *
 * That is not only an architecture preference. Stripe's published restricted-
 * business list names "peer-to-peer money transmission" as prohibited, and
 * puts money transmitters, remittance and currency exchange in the restricted
 * category that needs explicit underwriting approval. Routing internal sends
 * through Stripe would be the fastest way to lose the account. Internal sends
 * stay in our ledger, where no third party is a party to them.
 *
 * Before going live on real corridors, PayHive needs its own money
 * transmission position sorted (state MTLs or a sponsor/partner such as Nium).
 * That is a licensing question, not a code question, and no amount of good
 * software substitutes for it.
 */

/** Stripe amounts are JS numbers. Guard the conversion rather than trusting it. */
function toStripeAmount(value: Money): number {
  if (value.amount > BigInt(Number.MAX_SAFE_INTEGER) || value.amount < 0n) {
    throw new Error(`Amount out of range for Stripe: ${value.amount}`);
  }
  return Number(value.amount);
}

export interface StripeProviderOptions {
  secretKey: string;
  webhookSecret: string;
  apiVersion?: Stripe.LatestApiVersion;
}

export class StripeProvider implements PaymentProvider {
  readonly name = 'stripe';
  private readonly stripe: Stripe;
  private readonly webhookSecret: string;

  constructor(options: StripeProviderOptions) {
    this.stripe = new Stripe(options.secretKey, {
      // Pin the version. An unpinned SDK means Stripe can change response
      // shapes under a running ledger.
      apiVersion: options.apiVersion ?? ('2024-12-18.acacia' as Stripe.LatestApiVersion),
      appInfo: { name: 'PayHive', version: '0.1.0' },
    });
    this.webhookSecret = options.webhookSecret;
  }

  supportedCurrencies(): string[] {
    // Settlement currencies Stripe supports for most accounts. NGN is not a
    // Stripe settlement currency, which is precisely the gap a partner like
    // Nium fills later.
    return ['USD', 'EUR', 'GBP', 'CAD'];
  }

  /**
   * Fund a wallet. Creates a PaymentIntent whose metadata carries the PayHive
   * user id — the webhook uses that to know which wallet to credit, and never
   * trusts a user id sent from the browser.
   */
  async createDeposit(params: DepositParams): Promise<DepositIntent> {
    const intent = await this.stripe.paymentIntents.create(
      {
        amount: toStripeAmount(params.amount),
        currency: params.amount.currency.toLowerCase(),
        customer: params.customerRef ?? undefined,
        description: params.description ?? 'PayHive wallet top-up',
        automatic_payment_methods: { enabled: true },
        metadata: {
          payhive_user_id: params.userId,
          payhive_purpose: 'wallet_deposit',
          ...(params.metadata ?? {}),
        },
      },
      {
        // Stripe-level idempotency, separate from our own endpoint keys.
        idempotencyKey: `deposit:${params.userId}:${params.metadata?.requestId ?? crypto.randomUUID()}`,
      },
    );

    return {
      providerRef: intent.id,
      clientSecret: intent.client_secret ?? undefined,
      status:
        intent.status === 'succeeded'
          ? 'succeeded'
          : intent.status === 'processing'
            ? 'processing'
            : intent.status === 'canceled'
              ? 'failed'
              : 'requires_action',
    };
  }

  /**
   * Pay a user out to their bank via their Connect account.
   *
   * Two steps on purpose: a Transfer moves funds from the platform balance to
   * the connected account, then a Payout moves them to the bank. Keeping them
   * separate means a failed bank payout doesn't unwind the transfer, and the
   * connected account's own balance is visible for support.
   */
  async createPayout(params: PayoutParams): Promise<PayoutRequest> {
    const transfer = await this.stripe.transfers.create(
      {
        amount: toStripeAmount(params.amount),
        currency: params.amount.currency.toLowerCase(),
        destination: params.destinationRef,
        description: params.description ?? 'PayHive withdrawal',
        metadata: {
          payhive_user_id: params.userId,
          payhive_purpose: 'wallet_withdrawal',
          ...(params.metadata ?? {}),
        },
      },
      { idempotencyKey: `payout:${params.userId}:${params.metadata?.requestId ?? crypto.randomUUID()}` },
    );

    return { providerRef: transfer.id, status: 'pending' };
  }

  async parseWebhook(rawBody: Buffer, signature: string | undefined): Promise<ProviderEvent> {
    if (!signature) throw new Error('Missing Stripe-Signature header');

    // Throws on a bad signature. Never downgrade this to a log line.
    const event = this.stripe.webhooks.constructEvent(rawBody, signature, this.webhookSecret);

    const base = { id: event.id, provider: this.name, raw: event };

    switch (event.type) {
      case 'payment_intent.succeeded': {
        const intent = event.data.object as Stripe.PaymentIntent;
        return {
          ...base,
          type: 'deposit.succeeded',
          providerRef: intent.id,
          // amount_received, not amount: partial captures exist and crediting
          // the requested amount instead of the received one is free money.
          amount: money(BigInt(intent.amount_received), intent.currency.toUpperCase()),
          userId: intent.metadata?.payhive_user_id ?? null,
        };
      }
      case 'payment_intent.payment_failed': {
        const intent = event.data.object as Stripe.PaymentIntent;
        return {
          ...base,
          type: 'deposit.failed',
          providerRef: intent.id,
          amount: money(BigInt(intent.amount), intent.currency.toUpperCase()),
          userId: intent.metadata?.payhive_user_id ?? null,
        };
      }
      case 'payout.paid': {
        const payout = event.data.object as Stripe.Payout;
        return {
          ...base,
          type: 'payout.paid',
          providerRef: payout.id,
          amount: money(BigInt(payout.amount), payout.currency.toUpperCase()),
          userId: (payout.metadata?.payhive_user_id as string | undefined) ?? null,
        };
      }
      case 'payout.failed': {
        const payout = event.data.object as Stripe.Payout;
        return {
          ...base,
          type: 'payout.failed',
          providerRef: payout.id,
          amount: money(BigInt(payout.amount), payout.currency.toUpperCase()),
          userId: (payout.metadata?.payhive_user_id as string | undefined) ?? null,
        };
      }
      default:
        return { ...base, type: 'ignored', providerRef: null, amount: null, userId: null };
    }
  }

  /** Create (or reuse) the Stripe Customer that card deposits are attached to. */
  async ensureCustomer(params: {
    userId: string;
    email: string;
    displayName: string;
    existingRef?: string | null;
  }): Promise<string> {
    if (params.existingRef) return params.existingRef;
    const customer = await this.stripe.customers.create({
      email: params.email,
      name: params.displayName,
      metadata: { payhive_user_id: params.userId },
    });
    return customer.id;
  }
}
