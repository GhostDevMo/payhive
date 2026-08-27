# PayHive

Wallets and instant peer-to-peer transfer, built on a double-entry ledger.

This is the first slice of the PayHive product: a user can create an account,
get a PayHive ID, fund a wallet, send money to another PayHive user, withdraw,
and see their history. FX, escrow and the marketplace are deliberately not here
yet — they are all operations on top of this ledger, so the ledger comes first.

---

## Run it

You need **Node 20+** and **Postgres 14+**. Nothing else — Docker is one option
for the database, not a requirement, and the app itself runs the same on
Windows, macOS and Linux.

### 1. Get a Postgres running

Pick whichever line applies. All three end up in the same place: a server on
`localhost:5432`.

**Windows** — download the installer from
[postgresql.org/download/windows](https://www.postgresql.org/download/windows/),
run it, and let it install pgAdmin too. Then in **SQL Shell (psql)**, or in
PowerShell with `psql -U postgres`:

```sql
CREATE USER payhive WITH PASSWORD 'payhive' CREATEDB;
CREATE DATABASE payhive OWNER payhive;
```

**macOS** — [Postgres.app](https://postgresapp.com/) is the least fuss (drag in,
click Initialize). Or via Homebrew:

```bash
brew install postgresql@16
brew services start postgresql@16
psql postgres -c "CREATE USER payhive WITH PASSWORD 'payhive' CREATEDB;"
psql postgres -c "CREATE DATABASE payhive OWNER payhive;"
```

**Docker** — if you already have it, `docker compose up -d` does all of the
above in one step. If you don't, skip it; installing Docker just for this is not
worth the disk.

### 2. Start the app

```bash
npm install                          # installs both workspaces

cp server/.env.example server/.env   # Windows: copy server\.env.example server\.env
npm run db:migrate                   # schema + ledger invariants

npm run dev                          # API on :4000, web on :5173
```

Open <http://localhost:5173>, create an account, and press **Add funds** — with
the default `PAYMENT_PROVIDER=mock` deposits settle instantly, so the whole app
is usable without a Stripe key or a webhook tunnel.

```bash
npm test          # 42 tests, including concurrency and DB-level invariants
npm run typecheck
```

`npm run dev` runs both processes through `concurrently`, so it behaves the same
in PowerShell, cmd, and a POSIX shell. If you'd rather have two terminals, run
`npm run dev:api` in one and `npm run dev:web` in the other.

### If the database connection fails

The whole configuration is one line in `server/.env`:

```
DATABASE_URL=postgres://payhive:payhive@localhost:5432/payhive
```

If you installed Postgres with different credentials, change that line rather
than trying to match the defaults — nothing else in the codebase hardcodes them.
On Windows, check the `postgresql-x64-16` service is running in Services if the
connection is refused.

### Moving between machines

Use git — it is the only transfer method that survives more than one round trip.

```bash
git init && git add -A && git commit -m "PayHive: wallet and P2P transfer"
git remote add origin <your-repo-url>
git push -u origin main
```

On the new machine, `git clone`, then follow steps 1 and 2 above. `node_modules`
and `.env` are gitignored on purpose: the first is rebuilt by `npm install`, and
the second holds secrets that should never reach a repository. The database does
not travel with the code — you create a fresh empty one and `npm run db:migrate`
rebuilds the schema.

If you copy the folder by hand instead, **delete `node_modules` before copying**.
It is the bulk of the size, and native binaries compiled for macOS will not run
on Windows.

---

## Deploy a staging environment

`render.yaml` describes a **single web service**: the API also serves the built
web client. That is deliberate. The browser asks for `/api` on its own origin,
so there is no CORS and the session cookie stays `SameSite=lax` — the same
property the Vite dev proxy provides in development.

Staging runs `PAYMENT_PROVIDER=mock`. No real money moves, so none of the
licensing in the Stripe section below applies to it.

**1. A database.** Create a project at [neon.tech](https://neon.tech) and copy
the connection string. Keep its `?sslmode=require` suffix — that suffix is what
turns TLS on in `server/src/db/index.ts`, and without it the connection is
refused.

**2. The service.** In Render: **New → Blueprint**, connect this repository. It
reads `render.yaml` and asks for the one value not in the file, `DATABASE_URL`.
Paste the Neon string. `ADMIN_TOKEN` is generated for you.

**3. First boot** runs `npm run db:migrate` against the empty Neon database and
builds the schema and the ledger invariants. Migrations run on every boot;
`invariants.sql` is idempotent, so restarts are a no-op.

**4. Check it.** Open the service URL, create an account, press **Add funds**.
Then prove the books, reading `ADMIN_TOKEN` from the Render dashboard:

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" https://<your-service>.onrender.com/api/admin/reconciliation
```

Two things about the free tier: the service sleeps after inactivity, so the
first request takes around a minute, and it is a single instance — fine for
staging, not a model for how this would run with real money behind it.

---

## How the money works

Everything that moves value is a **balanced journal entry**. There is one
function that writes to the ledger — `post()` in `server/src/lib/ledger.ts` —
and nothing else may change a balance.

```
deposit    system_funding  -100.00   ->   user wallet   +100.00
transfer   alice wallet     -25.50   ->   bob wallet     +25.50
withdraw   user wallet      -40.00   ->   system_payout  +40.00
```

The system accounts are what keep each entry two-sided. They represent the world
outside PayHive and are allowed to go negative; a user wallet is not.

Five rules are enforced, and each one is enforced twice — once in the
application, once in Postgres — because application code can be bypassed by a
migration, an admin script, or a future service, and the ledger is the one place
where "mostly correct" is worth nothing:

| Rule | Application | Database |
| --- | --- | --- |
| Postings of a transaction sum to zero per currency | `validate()` | deferred constraint trigger |
| A user wallet never goes negative | balance check under row lock | `CHECK (allow_negative OR balance >= 0)` |
| A posting matches its account's currency | `post()` | `BEFORE INSERT` trigger |
| A zero-amount posting is impossible | `validate()` | `CHECK (amount <> 0)` |
| A provider reference credits a wallet at most once | — | partial unique index |

**Money is never a float.** Amounts are `bigint` counts of minor units, all the
way from the database through the API to the browser, where they stay strings.
`server/src/lib/money.ts` also knows which currencies have zero minor units —
XOF and XAF are in PayHive's target corridors, and treating them like USD would
inflate every amount by 100x.

**Concurrency.** Accounts are locked `FOR UPDATE` in ascending id order. The
fixed global order is what stops two people paying each other simultaneously
from deadlocking. There are tests for both: 25 concurrent sends against a
balance that covers 10 leave exactly 10 successes and a zero balance, and 40
crossing transfers between two users complete with no failures.

**Reconciliation.** `GET /admin/reconciliation` proves the books: every cached
balance equals the sum of its postings, every journal entry sums to zero, and
every currency nets to zero across all accounts. Run it on a schedule and alert
on `ok: false`:

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" http://localhost:4000/admin/reconciliation
```

It reports every account's position, not the caller's own, so it sits behind
`ADMIN_TOKEN` rather than a user session. The guard fails closed — with no
`ADMIN_TOKEN` set the endpoint refuses every request, because a deployment that
forgot to configure it should break loudly rather than serve the books to
anyone who guesses the URL.

**Idempotency.** Every money-moving endpoint requires an `Idempotency-Key`.
A retry with the same key replays the original response and moves nothing; the
same key with a different body is rejected outright. The browser mints the key
once per attempt and reuses it across retries, so a user hammering *Send* on a
bad connection cannot double-pay.

---

## Stripe, and what it can and cannot be

`PAYMENT_PROVIDER=stripe` wires up real PaymentIntents for funding and Connect
transfers for payout. Two things to know before relying on it.

**Stripe is the rail in and out, never the rail between users.** A PayHive-to-
PayHive send is two rows in our own ledger. No third party is a party to it,
which is why it settles instantly and costs nothing per send.

**That is a compliance boundary, not just an architecture preference.** Stripe's
published restricted-business list names *peer-to-peer money transmission* as
**prohibited**, and puts *money transmitters, remittances, currency exchange and
other money service businesses* in the **restricted** category, which is
approvable but only with explicit underwriting. PayHive's business description
sits squarely in that restricted category. Before going live:

1. Talk to Stripe sales about PayHive's actual model and get the approval in
   writing. Do not launch on a standard account and hope the description goes
   unread — a frozen balance mid-corridor is worse than a delayed launch.
2. Note that Stripe does not settle NGN, which is a primary corridor. That gap
   is exactly what a partner like Nium fills, and it is why the provider seam
   exists.
3. Holding customer funds and moving them between people is money transmission
   in its own right. That needs state MTLs, or a sponsor bank or partner who
   holds the licence and lets PayHive operate as their agent. No amount of good
   software substitutes for that, and it should be settled before real money
   touches this system.

Swapping providers is one new file implementing `PaymentProvider`
(`server/src/providers/types.ts`) plus a config change. Nothing in the ledger,
the API, or the client moves.

---

## Layout

```
server/
  src/lib/money.ts       Integer money. No floats anywhere.
  src/lib/ledger.ts      post(), reconcile() — the only writer of balances.
  src/lib/wallet.ts      deposit / transfer / withdraw / history.
  src/lib/auth.ts        scrypt passwords, sessions, PayHive ID allocation.
  src/db/schema.ts       Tables.
  src/db/invariants.sql  The rules the database enforces itself.
  src/providers/         The seam: mock, stripe, and the interface they share.
  src/routes/            HTTP surface.
  tests/                 Money, ledger, concurrency, API, idempotency.
web/
  src/lib/api.ts         Typed client. Amounts stay strings.
  src/components/        Auth, dashboard, send, top-up, history.
```

PayHive IDs use Crockford base32 — no I, L, O or U — because people read these
aloud and retype them.

---

## What's next

Roughly in the order that keeps the ledger honest:

1. **KYC** before deposits above a threshold. The `kycStatus` field is stubbed.
2. **Stripe webhook end-to-end** with `stripe listen`, and a reconciliation job
   comparing our ledger against Stripe's balance transactions daily.
3. **Fees** — `allocate()` already splits amounts without losing a minor unit,
   and `system_fee` exists to receive them.
4. **FX**, which is the first entry with two currencies. It balances per
   currency through a pair of FX position accounts; the ledger already checks
   per-currency, so nothing there needs to change.
5. **Escrow**, which is a hold: a posting into a per-order escrow account,
   released or reversed on settlement.
6. **Mobile** via Capacitor over this same web client, or a native client
   against the same API.
