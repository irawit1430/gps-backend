// config.example.js — framework-agnostic template.
// Adapt to your framework's env system:
//   Next.js:  process.env.NEXT_PUBLIC_*
//   Vite:     import.meta.env.VITE_*
//   Expo/RN:  process.env.EXPO_PUBLIC_*
//   Flutter:  const String.fromEnvironment('...')
// ONE per app. Never hardcode these URLs anywhere else in the codebase.

const env =
  (typeof process !== 'undefined' && process.env) ||
  (typeof window !== 'undefined' && window.__ENV__) ||
  {};

export const CONFIG = {
  // ─── Backend URLs (the ONLY thing that changes at cut-over) ───
  // Production:
  API_BASE_URL:
    env.NEXT_PUBLIC_API_BASE_URL ||
    env.VITE_API_BASE_URL ||
    env.EXPO_PUBLIC_API_BASE_URL ||
    'https://api.voltava.in',
  SOCKET_URL:
    env.NEXT_PUBLIC_SOCKET_URL ||
    env.VITE_SOCKET_URL ||
    env.EXPO_PUBLIC_SOCKET_URL ||
    'wss://api.voltava.in',

  // Fallback for local test without DNS/TLS (raw static IP, HTTP only):
  //   API_BASE_URL: 'http://8.234.123.112:3000',
  //   SOCKET_URL:   'ws://8.234.123.112:3000',

  // Convenience: everything under /api
  get API_BASE() {
    return `${this.API_BASE_URL}/api`;
  },

  // ─── Auth ───
  TOKEN_STORAGE_KEY: 'token',
  USER_STORAGE_KEY: 'user',

  // ─── Map defaults (override from GET /api/settings) ───
  MAP_CENTER: { lat: 28.7041, lng: 77.1025 },
  MAP_DEFAULT_ZOOM: 12,

  // ─── Polling fallback (only if the socket keeps failing) ───
  LOCATION_POLL_MS: 15000,
};
