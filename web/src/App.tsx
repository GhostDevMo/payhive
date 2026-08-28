import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, hydrateSession, type User } from './lib/api';
import AuthScreen from './components/AuthScreen';
import Dashboard from './components/Dashboard';
import Profile from './components/Profile';
import { Logo } from './components/Logo';

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(true);
  // Two screens is not worth a router. The moment there is a third, or a URL
  // someone needs to share, this should become one.
  const [view, setView] = useState<'wallet' | 'profile'>('wallet');
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

  if (!user) return <AuthScreen onAuthenticated={setUser} />;

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
