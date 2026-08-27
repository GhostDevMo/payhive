import { createHash } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { idempotencyKeys } from '../db/schema.js';

/**
 * Idempotency for money-moving endpoints.
 *
 * The failure this prevents is mundane and expensive: a user taps Send, the
 * response is lost to a flaky connection, the client retries, and the ledger
 * records two transfers. With a key, the second request replays the first
 * response and moves nothing.
 *
 * Semantics follow the IETF idempotency-key draft, which is also what Stripe
 * implements — same key + different body is a client error, not a silent
 * overwrite of what the first request did.
 */

function hashBody(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(body ?? null)).digest('hex');
}

export function idempotent(endpoint: string) {
  return async function middleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const key = req.header('Idempotency-Key');

    if (!key) {
      res.status(400).json({
        error: {
          code: 'idempotency_key_required',
          message: 'This endpoint moves money and requires an Idempotency-Key header.',
        },
      });
      return;
    }

    if (!req.user) {
      next();
      return;
    }

    const requestHash = hashBody(req.body);
    const existing = await db
      .select()
      .from(idempotencyKeys)
      .where(eq(idempotencyKeys.key, key))
      .limit(1);

    const record = existing[0];
    if (record) {
      if (record.userId !== req.user.id) {
        res.status(403).json({
          error: { code: 'idempotency_key_conflict', message: 'Idempotency key belongs to another user.' },
        });
        return;
      }
      if (record.requestHash !== requestHash) {
        res.status(422).json({
          error: {
            code: 'idempotency_key_reused',
            message: 'This Idempotency-Key was already used with a different request body.',
          },
        });
        return;
      }
      if (record.responseStatus !== null && record.responseBody !== null) {
        // Replay verbatim. The client cannot tell this apart from the original,
        // which is the whole point.
        res.setHeader('Idempotent-Replay', 'true');
        res.status(record.responseStatus).json(record.responseBody);
        return;
      }
      // Recorded but no response yet: the first request is still in flight.
      res.status(409).json({
        error: {
          code: 'idempotency_key_in_progress',
          message: 'A request with this key is still being processed. Retry shortly.',
        },
      });
      return;
    }

    // Claim the key before doing any work. The primary key makes this the
    // race-safe point: two concurrent retries, one insert wins.
    try {
      await db.insert(idempotencyKeys).values({
        key,
        userId: req.user.id,
        endpoint,
        requestHash,
      });
    } catch {
      res.status(409).json({
        error: {
          code: 'idempotency_key_in_progress',
          message: 'A request with this key is already being processed.',
        },
      });
      return;
    }

    // Capture the response so the next retry can replay it.
    const originalJson = res.json.bind(res);
    res.json = ((body: unknown) => {
      void db
        .update(idempotencyKeys)
        .set({ responseStatus: res.statusCode, responseBody: body })
        .where(eq(idempotencyKeys.key, key))
        .catch(() => {
          /* Recording the replay is best-effort; the money already moved correctly. */
        });
      return originalJson(body);
    }) as Response['json'];

    next();
  };
}
