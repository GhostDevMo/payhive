import { useState } from 'react';
import { ApiError, api } from '../lib/api';

/**
 * Claim or change the handle people can pay you by.
 *
 * The PayHive ID is shown next to it and never changes — a handle is an extra
 * way to be reached, not a replacement — so nobody has to worry that choosing
 * one invalidates an address they have already given out.
 */
export default function HandleCard({
  payhiveId,
  handle,
  onChanged,
}: {
  payhiveId: string;
  handle: string | null | undefined;
  onChanged: (handle: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(handle ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  async function copy(text: string) {
    await navigator.clipboard.writeText(text).catch(() => undefined);
    setCopied(text);
    setTimeout(() => setCopied(null), 1600);
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const result = await api.setHandle(value.trim());
      onChanged(result.handle);
      setValue(result.handle);
      setEditing(false);
    } catch (caught) {
      // The server explains exactly why a name was refused — too short,
      // reserved, already taken, still in cooldown. Passing that through is
      // more useful than a generic failure.
      setError(caught instanceof ApiError ? caught.message : 'Could not save that handle.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-3 text-sm text-slate-500">
      <span>Anyone can pay you with </span>
      <button
        onClick={() => void copy(payhiveId)}
        title="Copy your PayHive ID"
        className="tnum font-mono text-slate-300 transition hover:text-hive-500"
      >
        {copied === payhiveId ? 'Copied' : payhiveId}
      </button>

      {handle && !editing && (
        <>
          <span> or </span>
          <button
            onClick={() => void copy(handle)}
            title="Copy your handle"
            className="font-mono text-slate-300 transition hover:text-hive-500"
          >
            {copied === handle ? 'Copied' : `@${handle}`}
          </button>
        </>
      )}

      {!editing && (
        <button
          onClick={() => {
            setValue(handle ?? '');
            setError(null);
            setEditing(true);
          }}
          className="ml-2 text-xs font-semibold text-hive-500 transition hover:text-hive-400"
        >
          {handle ? 'Change' : 'Choose a handle'}
        </button>
      )}

      {editing && (
        <form onSubmit={save} className="mt-2 flex flex-wrap items-start gap-2">
          <div>
            <div className="flex items-center gap-1.5">
              <span className="font-mono text-slate-500">@</span>
              <input
                autoFocus
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="yourname"
                maxLength={20}
                spellCheck={false}
                autoCapitalize="none"
                className="input w-48 font-mono"
              />
            </div>
            <p className="mt-1 text-xs text-slate-600">
              3–20 characters: letters, numbers, dots, underscores, hyphens.
            </p>
            {handle && (
              <p className="mt-1 text-xs text-slate-600">
                Changing it retires <span className="font-mono">@{handle}</span> permanently, so no
                one else can ever use it. You can change again in 30 days.
              </p>
            )}
            {error && <p className="mt-1 text-xs text-rose-400">{error}</p>}
          </div>

          <button type="submit" disabled={saving || !value.trim()} className="btn-primary !py-2">
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            onClick={() => {
              setEditing(false);
              setError(null);
            }}
            className="btn-ghost !py-2"
          >
            Cancel
          </button>
        </form>
      )}
    </div>
  );
}
