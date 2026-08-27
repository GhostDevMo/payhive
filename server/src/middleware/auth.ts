import { createHash, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { SESSION_COOKIE, resolveSession, type SessionUser } from '../lib/auth.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: SessionUser;
      sessionId?: string;
    }
  }
}

/** Attaches req.user when a valid session cookie is present. Never rejects. */
export async function loadUser(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const sessionId = req.cookies?.[SESSION_COOKIE];
  if (typeof sessionId === 'string' && sessionId.length > 0) {
    const user = await resolveSession(sessionId);
    if (user) {
      req.user = user;
      req.sessionId = sessionId;
    }
  }
  next();
}

/** Gate for endpoints that move money or read private data. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: { code: 'unauthenticated', message: 'Sign in to continue' } });
    return;
  }
  next();
}

/**
 * Gate for endpoints that report the whole system's position rather than one
 * user's. The caller is a monitor, not a person, so this is a shared token
 * rather than a session.
 *
 * It fails closed: an unset ADMIN_TOKEN refuses every request. Leaving the
 * books readable by anyone who guesses the URL is the worse failure, and a
 * deployment that forgot to set the token should find out immediately.
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env.ADMIN_TOKEN ?? '';
  if (expected.length === 0) {
    res.status(503).json({
      error: {
        code: 'admin_not_configured',
        message: 'Admin endpoints are disabled until ADMIN_TOKEN is set.',
      },
    });
    return;
  }

  const header = req.get('authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';

  if (!secretEquals(presented, expected)) {
    res.status(401).json({
      error: { code: 'unauthenticated', message: 'Admin token required' },
    });
    return;
  }

  next();
}

/**
 * Compares two secrets without leaking the answer through how long it took.
 * Hashing first is what keeps the comparison fixed-width, so the token's
 * length does not leak either.
 */
function secretEquals(a: string, b: string): boolean {
  const left = createHash('sha256').update(a).digest();
  const right = createHash('sha256').update(b).digest();
  return timingSafeEqual(left, right);
}
