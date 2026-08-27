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
