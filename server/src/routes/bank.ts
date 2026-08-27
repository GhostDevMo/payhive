import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import {
  BankError,
  completeBankLink,
  listBankAccounts,
  removeBankAccount,
  setDefaultBankAccount,
  startBankLink,
} from '../lib/bank.js';

export const bankRouter = Router();

bankRouter.use(requireAuth);

function fail(error: unknown, res: import('express').Response): void {
  if (error instanceof BankError) {
    res.status(error.status).json({ error: { code: error.code, message: error.message } });
    return;
  }
  throw error;
}

/** The accounts a user has linked. Tokens are never part of this. */
bankRouter.get('/', async (req, res) => {
  res.json({ bankAccounts: await listBankAccounts(req.user!.id) });
});

const startSchema = z.object({
  currency: z.string().length(3),
  country: z.string().length(2),
  redirectUri: z.string().url().optional(),
});

/**
 * Open a link session.
 *
 * Returns a short-lived token the client SDK opens the aggregator's UI with.
 * The user's bank credentials are entered there and never come back here.
 */
bankRouter.post('/link-token', async (req, res) => {
  const parsed = startSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: { code: 'invalid_request', message: 'A currency and country are required.' },
    });
    return;
  }

  try {
    res.json(await startBankLink({ userId: req.user!.id, ...parsed.data }));
  } catch (error) {
    fail(error, res);
  }
});

const completeSchema = z.object({
  publicToken: z.string().min(1).max(500),
  accountId: z.string().max(200).optional(),
  country: z.string().length(2).optional(),
});

/** Finish a link with the public token the SDK handed the browser. */
bankRouter.post('/', async (req, res) => {
  const parsed = completeSchema.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: { code: 'invalid_request', message: 'A public token is required.' } });
    return;
  }

  try {
    res.status(201).json({ bankAccount: await completeBankLink({ userId: req.user!.id, ...parsed.data }) });
  } catch (error) {
    fail(error, res);
  }
});

bankRouter.post('/:id/default', async (req, res) => {
  try {
    res.json({ bankAccount: await setDefaultBankAccount(req.user!.id, String(req.params.id)) });
  } catch (error) {
    fail(error, res);
  }
});

bankRouter.delete('/:id', async (req, res) => {
  try {
    await removeBankAccount(req.user!.id, String(req.params.id));
    res.status(204).end();
  } catch (error) {
    fail(error, res);
  }
});
