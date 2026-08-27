import { and, eq } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import { accounts, users } from '../src/db/schema.js';
import { allocatePayhiveId, hashPassword } from '../src/lib/auth.js';
import { deposit } from '../src/lib/wallet.js';
import { money, type Currency } from '../src/lib/money.js';

export interface TestUser {
  id: string;
  payhiveId: string;
  email: string;
  password: string;
}

let counter = 0;

export async function createUser(displayName = 'Test User'): Promise<TestUser> {
  counter += 1;
  const email = `user${counter}.${Date.now()}@payhive.test`;
  const password = 'correct-horse-battery-staple';
  const payhiveId = await allocatePayhiveId();

  const [created] = await db
    .insert(users)
    .values({ email, passwordHash: await hashPassword(password), displayName, payhiveId })
    .returning({ id: users.id, payhiveId: users.payhiveId });

  return { id: created!.id, payhiveId: created!.payhiveId, email, password };
}

/** Fund a wallet the way a real deposit would: through the ledger. */
export async function fund(
  userId: string,
  minorUnits: bigint,
  currency: Currency = 'USD',
): Promise<void> {
  await deposit({
    userId,
    amount: money(minorUnits, currency),
    providerRef: `test_${counter}_${Math.random().toString(36).slice(2)}`,
  });
}

export async function balanceOf(userId: string, currency: Currency = 'USD'): Promise<bigint> {
  const rows = await db
    .select({ balance: accounts.balance })
    .from(accounts)
    .where(
      and(
        eq(accounts.userId, userId),
        eq(accounts.currency, currency.toUpperCase()),
        eq(accounts.kind, 'user_wallet'),
      ),
    )
    .limit(1);
  return rows[0] ? BigInt(rows[0].balance) : 0n;
}
