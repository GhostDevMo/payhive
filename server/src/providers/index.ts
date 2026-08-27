import { MockProvider } from './mock.js';
import { StripeProvider } from './stripe.js';
import type { PaymentProvider } from './types.js';

export * from './types.js';
export { MockProvider } from './mock.js';
export { StripeProvider } from './stripe.js';

let cached: PaymentProvider | null = null;

/**
 * Choose the provider from config.
 *
 * Defaults to mock. A missing STRIPE_SECRET_KEY with PAYMENT_PROVIDER=stripe
 * is a hard failure rather than a silent fall back to mock — quietly running
 * fake rails in production is the kind of bug you discover from a customer.
 */
export function getProvider(): PaymentProvider {
  if (cached) return cached;

  const choice = (process.env.PAYMENT_PROVIDER ?? 'mock').toLowerCase();

  if (choice === 'stripe') {
    const secretKey = process.env.STRIPE_SECRET_KEY;
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secretKey || !webhookSecret) {
      throw new Error(
        'PAYMENT_PROVIDER=stripe requires STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET.',
      );
    }
    cached = new StripeProvider({ secretKey, webhookSecret });
    return cached;
  }

  if (choice !== 'mock') {
    throw new Error(`Unknown PAYMENT_PROVIDER: ${choice}. Expected "mock" or "stripe".`);
  }

  cached = new MockProvider();
  return cached;
}

/** Test hook: drop the memoised provider so env changes take effect. */
export function resetProvider(): void {
  cached = null;
}
