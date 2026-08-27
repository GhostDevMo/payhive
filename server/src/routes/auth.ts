import { Router } from 'express';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';
import {
  SESSION_COOKIE,
  allocatePayhiveId,
  createSession,
  destroySession,
  hashPassword,
  verifyPassword,
} from '../lib/auth.js';
import { requireAuth } from '../middleware/auth.js';
import { openWallet } from '../lib/wallet.js';
import { claimHandle, HandleError } from '../lib/handle.js';

export const authRouter = Router();

const signupSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(10).max(200),
  displayName: z.string().min(1).max(80),
  /** Wallet opened on signup so the dashboard is never empty-stated. */
  currency: z.string().length(3).default('USD'),
});

const loginSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(1).max(200),
});

const cookieOptions = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: process.env.NODE_ENV === 'production',
  path: '/',
};

authRouter.post('/signup', async (req, res) => {
  const parsed = signupSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'invalid_request', message: parsed.error.issues[0]?.message } });
    return;
  }

  const email = parsed.data.email.toLowerCase();
  const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (existing[0]) {
    res.status(409).json({ error: { code: 'email_taken', message: 'That email is already registered.' } });
    return;
  }

  const payhiveId = await allocatePayhiveId();
  const passwordHash = await hashPassword(parsed.data.password);

  const [created] = await db
    .insert(users)
    .values({ email, passwordHash, displayName: parsed.data.displayName, payhiveId })
    .returning({ id: users.id, payhiveId: users.payhiveId, displayName: users.displayName });

  if (!created) {
    res.status(500).json({ error: { code: 'signup_failed', message: 'Could not create account.' } });
    return;
  }

  await openWallet(created.id, parsed.data.currency);

  const session = await createSession(created.id);
  res.cookie(SESSION_COOKIE, session.id, { ...cookieOptions, expires: session.expiresAt });
  res.status(201).json({
    user: {
      id: created.id,
      payhiveId: created.payhiveId,
      handle: null,
      displayName: created.displayName,
      email,
    },
  });
});

authRouter.post('/login', async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'invalid_request', message: 'Email and password required.' } });
    return;
  }

  const rows = await db
    .select()
    .from(users)
    .where(eq(users.email, parsed.data.email.toLowerCase()))
    .limit(1);

  const user = rows[0];
  // Same response and roughly the same work whether the user exists or not,
  // so this endpoint isn't an account-enumeration oracle.
  const ok = user ? await verifyPassword(parsed.data.password, user.passwordHash) : false;
  if (!user || !ok) {
    res.status(401).json({ error: { code: 'invalid_credentials', message: 'Email or password is incorrect.' } });
    return;
  }

  const session = await createSession(user.id);
  res.cookie(SESSION_COOKIE, session.id, { ...cookieOptions, expires: session.expiresAt });
  res.json({
    user: {
      id: user.id,
      payhiveId: user.payhiveId,
      handle: user.handle ?? null,
      displayName: user.displayName,
      email: user.email,
      kycStatus: user.kycStatus,
    },
  });
});

authRouter.post('/logout', async (req, res) => {
  if (req.sessionId) await destroySession(req.sessionId);
  res.clearCookie(SESSION_COOKIE, cookieOptions);
  res.status(204).end();
});

authRouter.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// ---------------------------------------------------------------------------
// Handle
// ---------------------------------------------------------------------------

const handleSchema = z.object({ handle: z.string().min(1).max(64) });

/**
 * Claim or change the caller's payment handle.
 *
 * The generated PayHive ID is untouched by this and keeps working forever; a
 * handle is an additional way to be paid, not a replacement for the first one.
 */
authRouter.put('/me/handle', requireAuth, async (req, res) => {
  const parsed = handleSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'invalid_request', message: 'A handle is required.' } });
    return;
  }

  try {
    const claimed = await claimHandle(req.user!.id, parsed.data.handle);
    res.json({ handle: claimed.handle });
  } catch (error) {
    if (error instanceof HandleError) {
      res.status(error.status).json({ error: { code: error.code, message: error.message } });
      return;
    }
    throw error;
  }
});
