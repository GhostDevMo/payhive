import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, hydrateSession, type User } from './lib/api';
import AuthScreen from './components/AuthScreen';
import Dashboard from './components/Dashboard';
import Profile from './components/Profile';
import { ChooseNewPassword, ConfirmEmail, ForgotPassword } from './components/ResetPassword';
import { Logo } from './components/Logo';

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(true);
  // Two screens is not worth a router. The moment there is a third, or a URL
  // someone needs to share, this should become one.
  const [view, setView] = useState<'wallet' | 'profile'>('wallet');
  const [forgot, setForgot] = useState(false);

  /**
   * Links arrive as query parameters because the app is a single page and, in
   * a native shell, has no server to route paths for it. Read once on load;
   * the parameter is stripped so a reload cannot try to redeem a spent token.
   */
  const [link] = useState(() => {
    if (typeof window === 'undefined') return null;
    const params = new URLSearchParams(window.location.search);
    const reset = params.get('reset');
    const verify = params.get('verify');
    if (reset || verify) {
      window.history.replaceState({}, '', window.location.pathname);
    }
    return reset ? { kind: 'reset' as const, token: reset }
      : verify ? { kind: 'verify' as const, token: verify }
      : null;
  });
  const [linkDone, setLinkDone] = useState(false);
  const [currency, setCurrency] = useState('USD');

  useEffect(() => {
    // A native launch restores its saved session before asking who we are;
    // on the web this resolves immediately and the cookie does the work.
    hydrateSession()
      .then(() => api.me())
      .then((r) => setUser(r.user))
      .catch((error) => {
        // A 401 here is the normal signed-out case, not a failure worth showing.
        if (!(error instanceof ApiError && error.status === 401)) console.error(error);
      })
      .finally(() => setChecking(false));
  }, []);

  const signOut = useCallback(async () => {
    await api.logout().catch(() => undefined);
    setUser(null);
    setView('wallet');
  }, []);

  if (checking) {
    return (
      <div className="flex h-full items-center justify-center">
        <Logo className="h-8 w-8 animate-pulse text-hive-500" />
      </div>
    );
  }

  // An emailed link takes precedence over whatever else the app would show:
  // whoever opened it is here to do that one thing.
  if (link && !linkDone) {
    return link.kind === 'reset' ? (
      <ChooseNewPassword token={link.token} onDone={() => setLinkDone(true)} />
    ) : (
      <ConfirmEmail
        token={link.token}
        onDone={() => {
          setLinkDone(true);
          // The address may have just moved, so re-read who we are.
          api.me().then((r) => setUser(r.user)).catch(() => setUser(null));
        }}
      />
    );
  }

  if (!user) {
    return forgot ? (
      <ForgotPassword onBack={() => setForgot(false)} />
    ) : (
      <AuthScreen onAuthenticated={setUser} onForgotPassword={() => setForgot(true)} />
    );
  }

  return view === 'profile' ? (
    <Profile
      user={user}
      currency={currency}
      onUserChanged={setUser}
      onBack={() => setView('wallet')}
    />
  ) : (
    <Dashboard
      user={user}
      onSignOut={signOut}
      onUserChanged={setUser}
      onOpenProfile={() => setView('profile')}
      onCurrencyChanged={setCurrency}
    />
  );
}
