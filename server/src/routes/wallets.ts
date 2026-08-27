import { Router } from 'express';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';
import { requireAuth } from '../middleware/auth.js';
import { idempotent } from '../middleware/idempotency.js';
import { history, listWallets, openWallet, transfer, withdraw, WalletError } from '../lib/wallet.js';
import { MoneyError, isSupportedCurrency, parseDecimal, SUPPORTED_CURRENCIES } from '../lib/money.js';
import { resolvePayee } from '../lib/handle.js';

export const walletRouter = Router();

walletRouter.use(requireAuth);

// ---------------------------------------------------------------------------

walletRouter.get('/', async (req, res) => {
  res.json({ wallets: await listWallets(req.user!.id) });
});

walletRouter.get('/currencies', (_req, res) => {
  res.json({ currencies: SUPPORTED_CURRENCIES });
});

const openSchema = z.object({ currency: z.string().length(3) });

walletRouter.post('/', async (req, res) => {
  const parsed = openSchema.safeParse(req.body);
  if (!parsed.success || !isSupportedCurrency(parsed.data.currency)) {
    res.status(400).json({ error: { code: 'invalid_currency', message: 'Unsupported currency.' } });
    return;
  }
  res.status(201).json({ wallet: await openWallet(req.user!.id, parsed.data.currency) });
});

// ---------------------------------------------------------------------------
// Recipient lookup — so the UI can confirm who is about to be paid.
// ---------------------------------------------------------------------------

walletRouter.get('/recipients/:address', async (req, res) => {
  const found = await resolvePayee(db, String(req.params.address ?? ''));

  if (!found) {
    res.status(404).json({
      error: { code: 'recipient_not_found', message: 'No PayHive user with that ID or handle.' },
    });
    return;
  }
  // Only the public addresses and the display name. Confirming a payee should
  // not be a way to harvest email addresses from a PayHive ID.
  res.json({
    recipient: {
      payhiveId: found.payhiveId,
      handle: found.handle,
      displayName: found.displayName,
    },
  });
});

// ---------------------------------------------------------------------------
// Transfer
// ---------------------------------------------------------------------------

const transferSchema = z.object({
  to: z.string().min(3).max(20),
  /** Decimal string as typed by the user, e.g. "25.00". Parsed, never floated. */
  amount: z.string().min(1).max(30),
  currency: z.string().length(3),
  note: z.string().max(140).optional(),
});

walletRouter.post('/transfers', idempotent('POST /wallets/transfers'), async (req, res) => {
  const parsed = transferSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'invalid_request', message: parsed.error.issues[0]?.message } });
    return;
  }

  try {
    const amount = parseDecimal(parsed.data.amount, parsed.data.currency);
    const result = await transfer({
      fromUserId: req.user!.id,
      to: parsed.data.to,
      amount,
      note: parsed.data.note,
    });
    res.status(201).json({ transfer: result });
  } catch (error) {
    handleWalletError(error, res);
  }
});

// ---------------------------------------------------------------------------
// Withdrawal
// ---------------------------------------------------------------------------

const withdrawSchema = z.object({
  amount: z.string().min(1).max(30),
  currency: z.string().length(3),
});

walletRouter.post('/withdrawals', idempotent('POST /wallets/withdrawals'), async (req, res) => {
  const parsed = withdrawSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'invalid_request', message: parsed.error.issues[0]?.message } });
    return;
  }

  try {
    const amount = parseDecimal(parsed.data.amount, parsed.data.currency);
    const result = await withdraw({ userId: req.user!.id, amount });
    res.status(201).json({ withdrawal: result });
  } catch (error) {
    handleWalletError(error, res);
  }
});

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

walletRouter.get('/transactions', async (req, res) => {
  const limit = req.query.limit ? Number(req.query.limit) : undefined;
  const before = req.query.before ? new Date(String(req.query.before)) : undefined;
  const currency = req.query.currency ? String(req.query.currency) : undefined;

  if (before && Number.isNaN(before.getTime())) {
    res.status(400).json({ error: { code: 'invalid_cursor', message: '`before` must be an ISO timestamp.' } });
    return;
  }

  res.json({
    transactions: await history(req.user!.id, { limit, before, currency }),
  });
});

// ---------------------------------------------------------------------------

function handleWalletError(error: unknown, res: import('express').Response): void {
  if (error instanceof WalletError) {
    res.status(error.status).json({ error: { code: error.code, message: error.message } });
    return;
  }
  if (error instanceof MoneyError) {
    res.status(400).json({ error: { code: 'invalid_amount', message: error.message } });
    return;
  }
  throw error;
}
