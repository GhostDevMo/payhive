/**
 * Where a native client keeps its session.
 *
 * The refresh token is a long-lived credential to somebody's money, on a device
 * that can be lost or stolen. localStorage is the wrong place for it: anything
 * running in the webview can read it, and it survives in plain text on disk.
 *
 * So on a device this goes to the platform's own secret store — Keychain on
 * iOS, the Keystore-backed store on Android. Both are encrypted at rest and
 * scoped to this app.
 *
 * On the web this is a no-op. A browser session is an httpOnly cookie that
 * JavaScript cannot read at all, which is stronger than anything this file
 * could offer, so there is nothing to persist.
 */

import { SecureStorage } from '@aparajita/capacitor-secure-storage';

export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
}

const KEY = 'payhive.session';

export const IS_NATIVE =
  typeof window !== 'undefined' &&
  Boolean(
    (window as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.(),
  );

export async function readTokens(): Promise<StoredTokens | null> {
  if (!IS_NATIVE) return null;
  try {
    const raw = await SecureStorage.get(KEY);
    return typeof raw === 'string' ? (JSON.parse(raw) as StoredTokens) : null;
  } catch {
    // A device with no stored session, or a keystore that refused. Either way
    // the user signs in again; failing to read is not worth crashing over.
    return null;
  }
}

export async function writeTokens(tokens: StoredTokens | null): Promise<void> {
  if (!IS_NATIVE) return;
  try {
    if (tokens) await SecureStorage.set(KEY, JSON.stringify(tokens));
    else await SecureStorage.remove(KEY);
  } catch {
    // Losing persistence costs the user a sign-in next launch. Losing the
    // running session would cost them the thing they are doing now.
  }
}
