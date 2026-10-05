import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Vibration } from 'react-native';

import { distanceMeters, formatDistance, type LatLng } from '../lib/geo';
import { isBackendConfigured } from '../lib/supabase';
import { notify } from '../services/notify';
import { fetchNearbySignals, subscribeSignalChanges, type Signal } from '../services/signals';

const RADIUS_M = 1500;
const REFETCH_MOVE_M = 200;
const POLL_MS = 30_000;

/**
 * Konumun çevresindeki canlı sinyalleri tutar. Realtime değişikliklerde, belirli
 * aralıklarla ve kullanıcı yeterince yer değiştirdiğinde listeyi yeniler.
 * `alertNew` açıksa yeni boşalan yerler için titreşim + bildirim verir.
 */
export function useNearbySignals(center: LatLng | null, alertNew: boolean) {
  const [signals, setSignals] = useState<Signal[]>([]);
  const [error, setError] = useState<string | null>(null);
  const centerRef = useRef(center);
  const fetchedAt = useRef<LatLng | null>(null);
  const seen = useRef<Set<string> | null>(null);
  const alertRef = useRef(alertNew);
  useEffect(() => {
    centerRef.current = center;
    alertRef.current = alertNew;
  }, [center, alertNew]);

  const refresh = useCallback(async () => {
    const c = centerRef.current;
    if (!c || !isBackendConfigured) return;
    try {
      const list = await fetchNearbySignals(c, RADIUS_M);
      fetchedAt.current = c;
      setError(null);
      setSignals(list);

      const fresh = list.filter((s) => s.status === 'active' && !s.isMine && !seen.current?.has(s.id));
      if (seen.current && alertRef.current && fresh.length > 0 && AppState.currentState === 'active') {
        const nearest = fresh.reduce((a, b) => ((a.distanceM ?? 1e9) <= (b.distanceM ?? 1e9) ? a : b));
        Vibration.vibrate([0, 200, 100, 200]);
        void notify('🅿️ Yakınında yer boşaldı', `${formatDistance(nearest.distanceM ?? 0)} ötede. Haritada gör.`);
      }
      seen.current = new Set([...(seen.current ?? []), ...list.map((s) => s.id)]);
    } catch (e) {
      setError('Sinyaller alınamadı');
      console.warn(e);
    }
  }, []);

  // Konum ilk geldiğinde ve belirgin şekilde değiştiğinde
  useEffect(() => {
    if (!center) return;
    if (!fetchedAt.current || distanceMeters(fetchedAt.current, center) > REFETCH_MOVE_M) void refresh();
  }, [center, refresh]);

  // Realtime + yedek olarak periyodik yenileme
  useEffect(() => {
    if (!isBackendConfigured) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const debounced = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void refresh(), 400);
    };
    const unsubscribe = subscribeSignalChanges(debounced);
    const poll = setInterval(() => void refresh(), POLL_MS);
    const appState = AppState.addEventListener('change', (s) => s === 'active' && void refresh());
    return () => {
      unsubscribe();
      clearInterval(poll);
      appState.remove();
      if (timer) clearTimeout(timer);
    };
  }, [refresh]);

  return { signals, error, refresh };
}
