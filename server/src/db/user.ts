/**
 * Account maintenance from the command line.
 *
 * This exists because PayHive has no password reset yet, and "no way back into
 * an account" is not an acceptable state even before launch. It is an operator
 * tool, not a feature: it runs against whatever DATABASE_URL is set, and anyone
 * who can run it already has full access to the database, so it grants no
 * privilege that was not already there.
 *
 *   npm run user:list                          -- who exists
 *   npm run user:password -- someone@mail.com  -- set a new password
 *
 * The new password is read from stdin rather than taken as an argument, so it
 * does not end up in shell history or in the process list.
 */

import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { desc, eq, sql } from 'drizzle-orm';
import { db, pool, DATABASE_URL } from './index.js';
import { sessions, users } from './schema.js';
import { hashPassword } from '../lib/auth.js';

/** Never print the credential itself when naming the database. */
function describeTarget(): string {
  try {
    const url = new URL(DATABASE_URL);
    return `${url.hostname}${url.pathname}`;
  } catch {
    return '(unparseable DATABASE_URL)';
  }
}

async function list(): Promise<void> {
  const rows = await db
    .select({
      email: users.email,
      displayName: users.displayName,
      payhiveId: users.payhiveId,
      handle: users.handle,
      createdAt: users.createdAt,
    })
    .from(users)
    .orderBy(desc(users.createdAt))
    .limit(50);

  console.log(`[payhive] ${describeTarget()} — ${rows.length} user(s)\n`);
  if (rows.length === 0) {
    console.log('  (none)');
    return;
  }
  for (const row of rows) {
    const handle = row.handle ? ` @${row.handle}` : '';
    console.log(`  ${row.email}  ${row.payhiveId}${handle}  "${row.displayName}"`);
  }
}

async function setPassword(email: string): Promise<void> {
  const normalised = email.trim().toLowerCase();

  const [user] = await db
    .select({ id: users.id, email: users.email, displayName: users.displayName })
    .from(users)
    .where(eq(sql`lower(${users.email})`, normalised))
    .limit(1);

  if (!user) {
    console.error(`[payhive] No account with ${normalised} on ${describeTarget()}.`);
    console.error('          Run `npm run user:list` to see which accounts exist.');
    process.exitCode = 1;
    return;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const password = (await rl.question(`New password for ${user.email}: `)).trim();
  rl.close();

  if (password.length < 10) {
    console.error('[payhive] Password must be at least 10 characters. Nothing changed.');
    process.exitCode = 1;
    return;
  }

  await db
    .update(users)
    .set({ passwordHash: await hashPassword(password) })
    .where(eq(users.id, user.id));

  // Same reasoning as changing a password in the app: if the reason for the
  // reset is that someone else had it, their session must not survive it.
  const removed = await db.delete(sessions).where(eq(sessions.userId, user.id)).returning({
    id: sessions.id,
  });

  console.log(`[payhive] Password updated for ${user.email}.`);
  console.log(`[payhive] ${removed.length} existing session(s) signed out.`);
}

async function main(): Promise<void> {
  const [command, argument] = process.argv.slice(2);

  switch (command) {
    case 'list':
      await list();
      break;
    case 'password':
      if (!argument) {
        console.error('Usage: npm run user:password -- someone@example.com');
        process.exitCode = 1;
        break;
      }
      await setPassword(argument);
      break;
    default:
      console.error('Usage:\n  npm run user:list\n  npm run user:password -- someone@example.com');
      process.exitCode = 1;
  }

  await pool.end();
}

main().catch(async (error) => {
  console.error('[payhive]', error);
  await pool.end();
  process.exit(1);
});
