/**
 * User-chosen payment handles.
 *
 * A handle is an alias, never an identity. The generated PayHive ID remains
 * the permanent way to reach a wallet; this only adds a nicer name that
 * resolves to the same place. That distinction is what keeps history truthful
 * and keeps a previously shared address from ever going stale.
 *
 * The whole of the difficulty here is that a handle is typed by a human who is
 * about to send money, and read by a human deciding whether to trust it. Both
 * of those are attackable.
 */

import { and, eq, isNotNull, ne } from 'drizzle-orm';
import { db, schema, type Executor } from '../db/index.js';

const { users, retiredHandles } = schema;

export class HandleError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'HandleError';
  }
}

export const HANDLE_MIN = 3;
export const HANDLE_MAX = 20;

/** How long a user must wait between handle changes. */
export const HANDLE_CHANGE_COOLDOWN_DAYS = 30;

/**
 * Names nobody may claim, because claiming one is a licence to impersonate.
 * Checked against the skeleton, so `p4yhive` and `pay.hive` are covered by the
 * single entry `payhive`.
 */
const RESERVED_WORDS = [
  'payhive',
  'payhivesupport',
  'support',
  'help',
  'helpdesk',
  'admin',
  'administrator',
  'root',
  'system',
  'official',
  'security',
  'billing',
  'payments',
  'payment',
  'refund',
  'refunds',
  'noreply',
  'no-reply',
  'api',
  'www',
  'mail',
  'team',
  'staff',
  'moderator',
  'verify',
  'verified',
  'wallet',
  'ledger',
  'me',
  'new',
  'edit',
  'settings',
  'account',
  'accounts',
  'login',
  'signup',
  'null',
  'undefined',
];


/**
 * Characters that are the same shape to someone reading quickly, folded onto
 * one representative. This is what stops `a1ice` being registered next to
 * `alice` and collecting the payments that miss.
 *
 * Deliberately conservative. The classic `rn` -> `m` substitution is not here:
 * folding it would collide `corner` with `comer`, and refusing honest names is
 * its own kind of failure. The ones kept are those that are genuinely
 * indistinguishable in the sans-serif faces a phone renders.
 */
const CONFUSABLES: Record<string, string> = {
  o: '0',
  l: '1',
  i: '1',
  s: '5',
  b: '8',
  g: '9',
  z: '2',
};

/** Separators a person might add or drop without thinking they changed anything. */
const SEPARATORS = /[._-]/g;

/** The shape of a generated PayHive ID, which a handle must never imitate. */
const LOOKS_LIKE_PAYHIVE_ID = /^ph[0-9a-z]{8}$/;

/**
 * Reduce a handle to the form uniqueness is enforced on.
 *
 * Two handles with the same skeleton are treated as the same handle, so only
 * one of them can exist. `Alice`, `alice`, `al.ice` and `a1ice` all collapse
 * to one, and whoever asks second is told the name is taken.
 */
export function skeleton(input: string): string {
  const lowered = input.normalize('NFKC').toLowerCase().replace(SEPARATORS, '');
  let out = '';
  for (const char of lowered) out += CONFUSABLES[char] ?? char;
  return out;
}

/**
 * Held as skeletons, not as the words themselves. `skeleton('payhive')` is
 * `payh1ve`, so comparing raw words against a folded candidate would never
 * match and the whole list would silently do nothing.
 *
 * Computed after skeleton() and the tables it reads, not beside the word list:
 * a const initialised at module load cannot call a function that dereferences
 * bindings declared further down the file.
 */
const RESERVED = new Set(RESERVED_WORDS.map(skeleton));

export interface NormalizedHandle {
  /** What is stored and shown back to people, e.g. "alice.dev". */
  handle: string;
  /** What uniqueness is enforced on, e.g. "a11ce.dev" -> "a11cedev". */
  skeleton: string;
}

/**
 * Validate a handle a user typed, returning the pair to store.
 *
 * Throws HandleError with a code the API can pass straight through, because
 * "why was my name rejected" deserves a specific answer rather than a generic
 * 400.
 */
export function normalizeHandle(raw: string): NormalizedHandle {
  const handle = raw.trim().toLowerCase();

  if (handle.length < HANDLE_MIN || handle.length > HANDLE_MAX) {
    throw new HandleError(
      `A handle is between ${HANDLE_MIN} and ${HANDLE_MAX} characters.`,
      'handle_length',
    );
  }
  if (!/^[a-z0-9._-]+$/.test(handle)) {
    throw new HandleError(
      'A handle can use letters, numbers, dots, underscores and hyphens.',
      'handle_charset',
    );
  }
  if (!/^[a-z]/.test(handle)) {
    throw new HandleError('A handle starts with a letter.', 'handle_start');
  }
  if (/[._-]$/.test(handle)) {
    throw new HandleError('A handle cannot end with a dot, underscore or hyphen.', 'handle_end');
  }
  if (/[._-]{2,}/.test(handle)) {
    throw new HandleError(
      'A handle cannot contain two separators in a row.',
      'handle_separators',
    );
  }

  const key = skeleton(handle);

  if (LOOKS_LIKE_PAYHIVE_ID.test(key)) {
    throw new HandleError(
      'That handle looks like a PayHive ID, which would be confusing to pay.',
      'handle_reserved',
    );
  }
  if (RESERVED.has(key)) {
    throw new HandleError('That handle is reserved.', 'handle_reserved');
  }

  return { handle, skeleton: key };
}

/**
 * Claim or change a handle.
 *
 * Runs in one transaction because "is it free" and "take it" have to be a
 * single decision; two people submitting the same name at once must not both
 * be told yes. The unique index on the skeleton is the real guarantee, and
 * this check exists to produce a decent error rather than a constraint
 * violation.
 */
export async function claimHandle(userId: string, raw: string): Promise<NormalizedHandle> {
  const next = normalizeHandle(raw);

  return db.transaction(async (tx) => {
    const [me] = await tx
      .select({
        handle: users.handle,
        handleSkeleton: users.handleSkeleton,
        handleUpdatedAt: users.handleUpdatedAt,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!me) throw new HandleError('User not found', 'user_not_found', 404);

    // Re-submitting the handle you already have is a no-op, not an error, and
    // must not burn the cooldown.
    if (me.handleSkeleton === next.skeleton) {
      if (me.handle !== next.handle) {
        await tx.update(users).set({ handle: next.handle }).where(eq(users.id, userId));
      }
      return next;
    }

    if (me.handleUpdatedAt) {
      const days = (Date.now() - me.handleUpdatedAt.getTime()) / 86_400_000;
      if (days < HANDLE_CHANGE_COOLDOWN_DAYS) {
        const wait = Math.ceil(HANDLE_CHANGE_COOLDOWN_DAYS - days);
        throw new HandleError(
          `You can change your handle again in ${wait} day${wait === 1 ? '' : 's'}.`,
          'handle_cooldown',
          429,
        );
      }
    }

    const [retired] = await tx
      .select({ skeleton: retiredHandles.skeleton })
      .from(retiredHandles)
      .where(eq(retiredHandles.skeleton, next.skeleton))
      .limit(1);

    if (retired) {
      // Deliberately the same message as "taken". Whether a name is in use or
      // burned is not the claimant's business, and saying so would map out
      // which handles once belonged to whom.
      throw new HandleError('That handle is not available.', 'handle_taken', 409);
    }

    const [clash] = await tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.handleSkeleton, next.skeleton), ne(users.id, userId)))
      .limit(1);

    if (clash) throw new HandleError('That handle is not available.', 'handle_taken', 409);

    // Burn the old one before taking the new one. A handle that has been
    // shared must never resolve to a different person later; failing to find
    // it is recoverable, paying a stranger is not.
    if (me.handle && me.handleSkeleton) {
      await tx.insert(retiredHandles).values({
        skeleton: me.handleSkeleton,
        handle: me.handle,
        userId,
      });
    }

    await tx
      .update(users)
      .set({ handle: next.handle, handleSkeleton: next.skeleton, handleUpdatedAt: new Date() })
      .where(eq(users.id, userId));

    return next;
  });
}

/**
 * Resolve what someone typed into the box to a payee.
 *
 * Accepts a PayHive ID or a handle, because the person paying should not have
 * to know which kind of thing they were given.
 */
export async function resolvePayee(
  executor: Executor,
  input: string,
): Promise<{ id: string; payhiveId: string; handle: string | null; displayName: string } | undefined> {
  const typed = input.trim();
  if (!typed) return undefined;

  const columns = {
    id: users.id,
    payhiveId: users.payhiveId,
    handle: users.handle,
    displayName: users.displayName,
  };

  const [byId] = await executor
    .select(columns)
    .from(users)
    .where(eq(users.payhiveId, typed.toUpperCase()))
    .limit(1);
  if (byId) return byId;

  // Fall back to the handle, matched on its skeleton so a payer who typed
  // `Alice` or `al.ice` still reaches alice.
  const key = skeleton(typed);
  if (!key) return undefined;

  const [byHandle] = await executor
    .select(columns)
    .from(users)
    .where(and(eq(users.handleSkeleton, key), isNotNull(users.handle)))
    .limit(1);

  return byHandle;
}
