import { randomUUID } from 'node:crypto';
import { money, SUPPORTED_CURRENCIES, type Money } from '../lib/money.js';
import type {
  DepositIntent,
  DepositParams,
  PaymentProvider,
  PayoutParams,
  PayoutRequest,
  ProviderEvent,
} from './types.js';

/**
 * Local-development provider.
 *
 * Deposits succeed immediately so the whole app can be exercised end to end
 * with no Stripe keys, no network, and no test cards. Every flow the real
 * provider drives is reachable here, which is what keeps the tests fast and
 * the onboarding of a new developer down to `npm run dev`.
 */
export class MockProvider implements PaymentProvider {
  readonly name = 'mock';

  supportedCurrencies(): string[] {
    return [...SUPPORTED_CURRENCIES];
  }

  async createDeposit(params: DepositParams): Promise<DepositIntent> {
    return {
      providerRef: `mock_pi_${randomUUID()}`,
      status: 'succeeded',
      clientSecret: undefined,
    };
  }

  async createPayout(params: PayoutParams): Promise<PayoutRequest> {
    return {
      providerRef: `mock_po_${randomUUID()}`,
      status: 'paid',
    };
  }

  async parseWebhook(rawBody: Buffer): Promise<ProviderEvent> {
    const parsed = JSON.parse(rawBody.toString('utf8')) as {
      id?: string;
      type?: ProviderEvent['type'];
      providerRef?: string;
      userId?: string;
      amount?: { amount: string; currency: string };
    };

    let amount: Money | null = null;
    if (parsed.amount) {
      amount = money(BigInt(parsed.amount.amount), parsed.amount.currency);
    }

    return {
      id: parsed.id ?? `mock_evt_${randomUUID()}`,
      provider: this.name,
      type: parsed.type ?? 'ignored',
      providerRef: parsed.providerRef ?? null,
      amount,
      userId: parsed.userId ?? null,
      raw: parsed,
    };
  }
}
