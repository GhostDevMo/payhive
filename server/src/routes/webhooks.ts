import { Router, raw } from 'express';
import { db } from '../db/index.js';
import { providerEvents } from '../db/schema.js';
import { deposit } from '../lib/wallet.js';
import { getProvider } from '../providers/index.js';

export const webhookRouter = Router();

/**
 * Provider webhooks.
 *
 * Three rules hold this together:
 *
 *  1. The raw body is required for signature verification, so this router is
 *     mounted BEFORE express.json() and parses with express.raw().
 *  2. Every event is recorded by its provider event id, which is the primary
 *     key. Providers retry aggressively; the insert failing on a duplicate is
 *     how we make sure a retry cannot credit a wallet twice.
 *  3. We answer 2xx quickly for anything we've understood — including events
 *     we deliberately ignore — so the provider stops retrying. A 500 here
 *     means "we failed, please retry", and should only be sent when true.
 */
webhookRouter.post('/:provider', raw({ type: '*/*' }), async (req, res) => {
  const provider = getProvider();

  if (req.params.provider !== provider.name) {
    res.status(404).json({ error: { code: 'unknown_provider', message: 'No such provider.' } });
    return;
  }

  let event;
  try {
    event = await provider.parseWebhook(
      req.body as Buffer,
      req.header('stripe-signature') ?? req.header('x-payhive-signature'),
    );
  } catch (error) {
    // Signature failures are not retryable and must not reach the ledger.
    res.status(400).json({
      error: { code: 'invalid_signature', message: (error as Error).message },
    });
    return;
  }

  // Claim the event id. A duplicate delivery loses this race and exits.
  try {
    await db.insert(providerEvents).values({
      id: `${event.provider}:${event.id}`,
      provider: event.provider,
      type: event.type,
      payload: event.raw,
    });
  } catch {
    res.status(200).json({ received: true, duplicate: true });
    return;
  }

  switch (event.type) {
    case 'deposit.succeeded': {
      if (!event.userId || !event.amount || !event.providerRef) {
        // Nothing actionable, but it is verified and recorded — don't ask for
        // a retry that will fail identically.
        res.status(200).json({ received: true, ignored: 'missing_metadata' });
        return;
      }
      try {
        await deposit({
          userId: event.userId,
          amount: event.amount,
          providerRef: event.providerRef,
          description: 'Wallet top-up',
          metadata: { provider: event.provider, eventId: event.id },
        });
      } catch (error) {
        // The unique index on transactions.provider_ref is the second line of
        // defence: if this PaymentIntent already credited the wallet, treat the
        // duplicate as success rather than retrying forever.
        if (isUniqueViolation(error)) {
          res.status(200).json({ received: true, duplicate: true });
          return;
        }
        throw error;
      }
      res.status(200).json({ received: true });
      return;
    }

    case 'deposit.failed':
    case 'payout.failed':
    case 'payout.paid':
      // Recorded for reconciliation. Payout state changes don't move the
      // ledger — the debit already happened when the withdrawal was requested.
      res.status(200).json({ received: true });
      return;

    default:
      res.status(200).json({ received: true, ignored: event.type });
  }
});

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code: unknown }).code === '23505';
}
