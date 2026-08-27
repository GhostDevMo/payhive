-- PayHive ledger invariants, enforced by the database.
--
-- The application already checks all of these. They are repeated here because
-- application code can be bypassed — by a migration script, an admin console,
-- a future service, or a bug — and the ledger is the one place in this system
-- where "mostly correct" is worth nothing. If a write would break the books,
-- the database refuses it.

-- 1. A posting of zero moves nothing and is always a bug.
ALTER TABLE postings DROP CONSTRAINT IF EXISTS postings_amount_nonzero;
ALTER TABLE postings ADD CONSTRAINT postings_amount_nonzero CHECK (amount <> 0);

-- 2. A posting must be in its account's currency. Without this a USD wallet
--    could accumulate NGN postings and its balance would be meaningless.
CREATE OR REPLACE FUNCTION posting_currency_matches_account() RETURNS trigger AS $$
DECLARE
  account_currency char(3);
BEGIN
  SELECT currency INTO account_currency FROM accounts WHERE id = NEW.account_id;
  IF account_currency IS NULL THEN
    RAISE EXCEPTION 'Posting references unknown account %', NEW.account_id;
  END IF;
  IF account_currency <> NEW.currency THEN
    RAISE EXCEPTION 'Posting currency % does not match account currency % for account %',
      NEW.currency, account_currency, NEW.account_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS postings_currency_check ON postings;
CREATE TRIGGER postings_currency_check
  BEFORE INSERT OR UPDATE ON postings
  FOR EACH ROW EXECUTE FUNCTION posting_currency_matches_account();

-- 3. Double entry: the postings of a transaction must sum to zero per currency.
--
--    DEFERRABLE INITIALLY DEFERRED is the whole trick. The check runs at COMMIT,
--    not per row, so the second leg of a transfer is allowed to be inserted
--    after the first without the intermediate state being rejected — but an
--    entry that is still one-sided when the transaction tries to commit cannot
--    get in.
CREATE OR REPLACE FUNCTION transaction_must_balance() RETURNS trigger AS $$
DECLARE
  offending record;
BEGIN
  SELECT currency, SUM(amount) AS total
    INTO offending
    FROM postings
   WHERE transaction_id = NEW.transaction_id
   GROUP BY currency
  HAVING SUM(amount) <> 0
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'Unbalanced transaction %: % sums to % (must be 0)',
      NEW.transaction_id, offending.currency, offending.total;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS postings_balance_check ON postings;
CREATE CONSTRAINT TRIGGER postings_balance_check
  AFTER INSERT OR UPDATE OR DELETE ON postings
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION transaction_must_balance();

-- 4. A user wallet may never go negative. System accounts may, and must —
--    they are the counterparty representing the world outside PayHive.
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_no_overdraft;
ALTER TABLE accounts ADD CONSTRAINT accounts_no_overdraft
  CHECK (allow_negative OR balance >= 0);
