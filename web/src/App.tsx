import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, type User } from './lib/api';
import AuthScreen from './components/AuthScreen';
import Dashboard from './components/Dashboard';
import { Logo } from './components/Logo';

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    api
      .me()
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
  }, []);

  if (checking) {
    return (
      <div className="flex h-full items-center justify-center">
        <Logo className="h-8 w-8 animate-pulse text-hive-500" />
      </div>
    );
  }

  return user ? (
    <Dashboard user={user} onSignOut={signOut} />
  ) : (
    <AuthScreen onAuthenticated={setUser} />
  );
}
