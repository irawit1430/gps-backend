// api-client.example.js — minimal shared client for HTTP + authenticated Socket.IO.
// Framework-agnostic. Adapt to axios / React Query / Dio (Flutter) as needed.

import { CONFIG } from './config';
import { io } from 'socket.io-client';

// ─── Storage helpers (swap for SecureStore / Keychain on mobile) ───
export const getToken = () =>
  typeof window !== 'undefined' ? localStorage.getItem(CONFIG.TOKEN_STORAGE_KEY) : null;
export const setToken = (t) => localStorage.setItem(CONFIG.TOKEN_STORAGE_KEY, t);
export const getUser = () =>
  JSON.parse(localStorage.getItem(CONFIG.USER_STORAGE_KEY) || 'null');
export const setUser = (u) =>
  localStorage.setItem(CONFIG.USER_STORAGE_KEY, JSON.stringify(u));
export const clearAuth = () => {
  localStorage.removeItem(CONFIG.TOKEN_STORAGE_KEY);
  localStorage.removeItem(CONFIG.USER_STORAGE_KEY);
};

// ─── Central HTTP wrapper ───
// - Attaches Bearer token
// - Global 401 → clear + go to login
// - Surfaces 400 validation issues on the error
// - Throws with .status and .issues for callers to display
export async function api(path, { method = 'GET', body, auth = true, headers = {} } = {}) {
  const hdrs = { 'Content-Type': 'application/json', ...headers };
  if (auth) {
    const token = getToken();
    if (token) hdrs.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(`${CONFIG.API_BASE}${path}`, {
    method,
    headers: hdrs,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401) {
    clearAuth();
    if (typeof window !== 'undefined') window.location.href = '/login';
    throw new Error('Session expired');
  }
  if (res.status === 429) {
    const e = new Error('Too many attempts. Try again shortly.');
    e.status = 429;
    throw e;
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.issues = data.issues; // [{ path, message }]
    throw err;
  }
  return data;
}

// ─── Auth ───
export async function login(email, password) {
  const data = await api('/auth/login', {
    method: 'POST',
    auth: false,
    body: { email, password },
  });
  setToken(data.token);
  setUser(data.user);
  return data.user; // { id, name, email, role, schoolId, mustResetPassword, preferences }
}

export function logout() {
  clearAuth();
  if (typeof window !== 'undefined') window.location.href = '/login';
}

// ─── Authenticated Socket.IO (REQUIRED on new backend) ───
export function connectSocket() {
  const socket = io(CONFIG.SOCKET_URL, {
    auth: { token: getToken() },
    transports: ['websocket'],
  });

  socket.on('connect_error', (err) => {
    if (String(err.message || '').startsWith('Unauthorized')) {
      clearAuth();
      if (typeof window !== 'undefined') window.location.href = '/login';
    } else {
      console.error('[socket] connect_error:', err.message);
    }
  });

  return socket;
}

// ─── Example usage ───
// const user = await login('admin@voltava.in', '••••');
// if (user.mustResetPassword) navigate('/reset-password');
//
// const stats = await api('/stats');
// const buses = await api(`/schools/${user.schoolId}/buses`);
//
// const socket = connectSocket();
// socket.on('location_update', (d) => updateBusMarker(d));
// socket.on('emergency_alert', (a) => showSosBanner(a));
