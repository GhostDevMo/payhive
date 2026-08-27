import { useState, type FormEvent } from 'react';
import { ApiError, api, type User } from '../lib/api';
import { Logo } from './Logo';
import HandleCard from './HandleCard';
import BankAccounts from './BankAccounts';

/**
 * Account settings.
 *
 * Grouped by what a change costs rather than by what it touches: the name
 * anyone can change, the email needs the password because it is how an account
 * is recovered, and the password signs every other device out.
 */
export default function Profile({
  user,
  currency,
  onUserChanged,
  onBack,
}: {
  user: User;
  currency: string;
  onUserChanged: (user: User) => void;
  onBack: () => void;
}) {
  return (
    <div className="mx-auto min-h-full w-full max-w-3xl px-4 pb-16 pt-6 sm:px-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-2.5">
          <Logo className="h-6 w-6 text-hive-500" />
          <span className="text-lg font-semibold tracking-tight text-white">Account</span>
        </div>
        <button onClick={onBack} className="btn-ghost !px-3 !py-1.5 text-xs">
          Back to wallet
        </button>
      </header>

      <div className="mt-7 space-y-5">
        <section className="card">
          <h2 className="text-sm font-semibold text-white">How you get paid</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            Your PayHive ID is permanent. A handle is an extra address that points at the same
            wallet.
          </p>
          <HandleCard
            payhiveId={user.payhiveId}
            handle={user.handle}
            onChanged={(handle) => onUserChanged({ ...user, handle })}
          />
        </section>

        <DetailsCard user={user} onUserChanged={onUserChanged} />

        <BankAccounts currency={currency} />

        <PasswordCard />

        <section className="card">
          <h2 className="text-sm font-semibold text-white">Verification</h2>
          <p className="mt-2 text-sm text-slate-400">
            Status: <span className="text-slate-200">{user.kycStatus ?? 'unverified'}</span>
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Identity checks are not switched on yet. They are required before deposits above a
            threshold.
          </p>
        </section>
      </div>
    </div>
  );
}

function DetailsCard({
  user,
  onUserChanged,
}: {
  user: User;
  onUserChanged: (user: User) => void;
}) {
  const [displayName, setDisplayName] = useState(user.displayName);
  const [email, setEmail] = useState(user.email);
  const [currentPassword, setCurrentPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  const emailChanged = email.trim().toLowerCase() !== user.email.toLowerCase();
  const nameChanged = displayName.trim() !== user.displayName;
  const dirty = emailChanged || nameChanged;

  async function save(event: FormEvent) {
    event.preventDefault();
    if (saving || !dirty) return;
    setSaving(true);
    setError(null);
    setSaved(false);

    try {
      const result = await api.updateProfile({
        ...(nameChanged ? { displayName: displayName.trim() } : {}),
        ...(emailChanged ? { email: email.trim(), currentPassword } : {}),
      });
      onUserChanged(result.user);
      setCurrentPassword('');
      setSaved(true);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not save your details.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="card">
      <h2 className="text-sm font-semibold text-white">Your details</h2>
      <p className="mt-0.5 text-xs text-slate-500">
        Your display name is what someone sees when they confirm a payment to you.
      </p>

      <form onSubmit={save} className="mt-4 space-y-3.5">
        <div>
          <label className="label" htmlFor="displayName">
            Display name
          </label>
          <input
            id="displayName"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            maxLength={80}
            className="input"
          />
        </div>

        <div>
          <label className="label" htmlFor="email">
            Email
          </label>
          <input
            id="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="input"
          />
        </div>

        {emailChanged && (
          <div>
            <label className="label" htmlFor="currentPassword">
              Current password
            </label>
            <input
              id="currentPassword"
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              placeholder="••••••••"
              className="input"
            />
            <p className="mt-1 text-xs text-slate-500">
              Your email is how you get back into your account, so changing it needs your password.
            </p>
          </div>
        )}

        {error && <p className="text-xs text-rose-400">{error}</p>}
        {saved && <p className="text-xs text-emerald-400">Saved.</p>}

        <button type="submit" disabled={!dirty || saving} className="btn-primary">
          {saving ? 'Saving…' : 'Save changes'}
        </button>
      </form>
    </section>
  );
}

function PasswordCard() {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [saving, setSaving] = useState(false);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(null);
    setDone(false);

    try {
      await api.changePassword({ currentPassword, newPassword });
      setCurrentPassword('');
      setNewPassword('');
      setDone(true);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not change your password.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="card">
      <h2 className="text-sm font-semibold text-white">Password</h2>
      <p className="mt-0.5 text-xs text-slate-500">
        Changing it signs out every other device. This session stays signed in.
      </p>

      <form onSubmit={save} className="mt-4 space-y-3.5">
        <div>
          <label className="label" htmlFor="oldPassword">
            Current password
          </label>
          <input
            id="oldPassword"
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            placeholder="••••••••"
            className="input"
          />
        </div>

        <div>
          <label className="label" htmlFor="newPassword">
            New password
          </label>
          <input
            id="newPassword"
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            placeholder="At least 10 characters"
            className="input"
          />
        </div>

        {error && <p className="text-xs text-rose-400">{error}</p>}
        {done && <p className="text-xs text-emerald-400">Password changed.</p>}

        <button
          type="submit"
          disabled={saving || !currentPassword || newPassword.length < 10}
          className="btn-primary"
        >
          {saving ? 'Saving…' : 'Change password'}
        </button>
      </form>
    </section>
  );
}
