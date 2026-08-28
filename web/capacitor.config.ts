import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor wraps the built web client in a native shell.
 *
 * The important consequence is the origin. The app is served from
 * capacitor://localhost (iOS) or http://localhost (Android), not from the API's
 * origin, so every request is cross-site: the session cookie is dropped and the
 * client authenticates with a bearer token instead. That is why VITE_API_URL
 * must be set when building for native — a relative /api path has nothing to
 * resolve against here.
 */
const config: CapacitorConfig = {
  appId: 'app.payhive.wallet',
  appName: 'PayHive',
  webDir: 'dist',
  android: {
    // Cleartext stays off: the API is HTTPS, and a wallet has no business
    // accepting a downgrade.
    allowMixedContent: false,
  },
  server: {
    androidScheme: 'https',
  },
};

export default config;
