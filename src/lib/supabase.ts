import 'react-native-url-polyfill/auto';

import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';
import { AppState } from 'react-native';

const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

export const isBackendConfigured = Boolean(url && anonKey);

export const supabase = createClient(url ?? 'http://localhost:54321', anonKey ?? 'missing-key', {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});

// Uygulama ön plandayken oturum yenilensin, arka plandayken dursun.
AppState.addEventListener('change', (state) => {
  if (state === 'active') supabase.auth.startAutoRefresh();
  else supabase.auth.stopAutoRefresh();
});

/**
 * Kayıt ekranı olmadan çalışmak için anonim oturum açar (Supabase Anonymous Sign-ins).
 * Arka plan görevinden de çağrılabilir.
 */
export async function ensureSession(): Promise<string> {
  if (!isBackendConfigured) throw new Error('Supabase yapılandırılmamış (.env dosyasına bakın)');
  const { data } = await supabase.auth.getSession();
  if (data.session) return data.session.user.id;
  const { data: signIn, error } = await supabase.auth.signInAnonymously();
  if (error || !signIn.user) throw error ?? new Error('Anonim oturum açılamadı');
  return signIn.user.id;
}
