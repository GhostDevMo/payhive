import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';
import { requireAuth } from '../middleware/auth.js';
import { idempotent } from '../middleware/idempotency.js';
import { deposit } from '../lib/wallet.js';
import { MoneyError, parseDecimal } from '../lib/money.js';
import { getProvider, StripeProvider } from '../providers/index.js';

export const depositRouter = Router();

depositRouter.use(requireAuth);

const depositSchema = z.object({
  amount: z.string().min(1).max(30),
  currency: z.string().length(3),
});

/**
 * Start a wallet top-up.
 *
 * The two providers land in different places on purpose:
 *
 *  mock   — credits the wallet immediately, so local development and tests
 *           never need a card or a tunnel for webhooks.
 *  stripe — creates a PaymentIntent and returns its client secret. The wallet
 *           is NOT credited here. It is credited by the webhook, because the
 *           browser telling us a payment succeeded is not evidence that it did.
 */
depositRouter.post('/', idempotent('POST /deposits'), async (req, res) => {
  const parsed = depositSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'invalid_request', message: parsed.error.issues[0]?.message } });
    return;
  }

  let amount;
  try {
    amount = parseDecimal(parsed.data.amount, parsed.data.currency);
  } catch (error) {
    if (error instanceof MoneyError) {
      res.status(400).json({ error: { code: 'invalid_amount', message: error.message } });
      return;
    }
    throw error;
  }

  if (amount.amount <= 0n) {
    res.status(400).json({ error: { code: 'invalid_amount', message: 'Amount must be positive.' } });
    return;
  }

  const provider = getProvider();
  if (!provider.supportedCurrencies().includes(amount.currency)) {
    res.status(422).json({
      error: {
        code: 'currency_unsupported_by_provider',
        message: `${provider.name} cannot settle ${amount.currency}. Supported: ${provider.supportedCurrencies().join(', ')}.`,
      },
    });
    return;
  }

  let customerRef: string | null = null;
  if (provider instanceof StripeProvider) {
    const rows = await db.select().from(users).where(eq(users.id, req.user!.id)).limit(1);
    const user = rows[0]!;
    customerRef = await provider.ensureCustomer({
      userId: user.id,
      email: user.email,
      displayName: user.displayName,
      existingRef: user.stripeCustomerId,
    });
    if (customerRef !== user.stripeCustomerId) {
      await db.update(users).set({ stripeCustomerId: customerRef }).where(eq(users.id, user.id));
    }
  }

  const intent = await provider.createDeposit({
    userId: req.user!.id,
    customerRef,
    amount,
    description: 'PayHive wallet top-up',
    metadata: { requestId: req.header('Idempotency-Key') ?? randomUUID() },
  });

  // Only credit inline when the provider settled synchronously (mock). Real
  // providers go through the webhook path.
  if (intent.status === 'succeeded') {
    const result = await deposit({
      userId: req.user!.id,
      amount,
      providerRef: intent.providerRef,
      description: 'Wallet top-up',
      metadata: { provider: provider.name },
    });
    res.status(201).json({
      deposit: { status: 'succeeded', transactionId: result.transactionId, providerRef: intent.providerRef },
    });
    return;
  }

  res.status(202).json({
    deposit: {
      status: intent.status,
      providerRef: intent.providerRef,
      clientSecret: intent.clientSecret ?? null,
      redirectUrl: intent.redirectUrl ?? null,
    },
  });
});
