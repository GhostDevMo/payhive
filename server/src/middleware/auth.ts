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

/**
 * Attaches req.user when the request carries a valid session. Never rejects.
 *
 * Two transports, one session. The browser sends an httpOnly cookie, which
 * JavaScript cannot read and so cannot leak through XSS. A native client sends
 * the same session as a bearer token, because an app served from its own origin
 * makes every API call cross-site and WKWebView will not keep the cookie.
 *
 * The cookie is checked first: if a request somehow carries both, the browser's
 * own credential is the one that counts.
 */
export async function loadUser(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const sessionId = sessionFromCookie(req) ?? sessionFromBearer(req);

  if (sessionId) {
    const user = await resolveSession(sessionId);
    if (user) {
      req.user = user;
      req.sessionId = sessionId;
    }
  }
  next();
}

function sessionFromCookie(req: Request): string | null {
  const value = req.cookies?.[SESSION_COOKIE];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function sessionFromBearer(req: Request): string | null {
  const header = req.get('authorization') ?? '';
  if (!header.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  return token.length > 0 ? token : null;
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
