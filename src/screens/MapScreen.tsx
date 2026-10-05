import * as Location from 'expo-location';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, AppState, Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import MapView, { Marker } from 'react-native-maps';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ClaimPanel, DriverPanel, SpotPanel } from '../components/BottomPanel';
import { SignalMarker } from '../components/SignalMarker';
import {
  forgetParked,
  isTracking,
  loadSnapshot,
  requestTrackingPermissions,
  setParkedHere,
  shareMySpot,
  startTracking,
  stopTracking,
  subscribeTracker,
  undoMySignal,
  type TrackerSnapshot,
} from '../detection/tracker';
import { useNearbySignals } from '../hooks/useNearbySignals';
import { distanceMeters, type LatLng } from '../lib/geo';
import { isBackendConfigured } from '../lib/supabase';
import { requestNotificationPermission } from '../services/notify';
import { claimSignal, finishClaim, signalErrorMessage, type Signal } from '../services/signals';
import { colors } from '../theme';

const ISTANBUL = { latitude: 41.0082, longitude: 28.9784, latitudeDelta: 0.05, longitudeDelta: 0.05 };

function openNavigation(to: LatLng) {
  const url = Platform.select({
    ios: `maps://?daddr=${to.latitude},${to.longitude}&dirflg=d`,
    default: `https://www.google.com/maps/dir/?api=1&destination=${to.latitude},${to.longitude}&travelmode=driving`,
  });
  void Linking.openURL(url);
}

export default function MapScreen() {
  const mapRef = useRef<MapView>(null);
  const [me, setMe] = useState<LatLng | null>(null);
  const [snapshot, setSnapshot] = useState<TrackerSnapshot | null>(null);
  const [tracking, setTracking] = useState(false);
  const [seeking, setSeeking] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [myClaim, setMyClaim] = useState<Signal | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [locationDenied, setLocationDenied] = useState(false);

  const { signals, error, refresh } = useNearbySignals(me, seeking && !myClaim);

  // Konum izni + ön planda konum takibi (haritayı ve yakındaki sinyalleri besler)
  useEffect(() => {
    let sub: Location.LocationSubscription | null = null;
    (async () => {
      const perm = await Location.requestForegroundPermissionsAsync();
      if (!perm.granted) {
        setLocationDenied(true);
        return;
      }
      const first = await Location.getLastKnownPositionAsync().catch(() => null);
      if (first) setMe(first.coords);
      sub = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.Balanced, distanceInterval: 25 },
        (loc) => setMe({ latitude: loc.coords.latitude, longitude: loc.coords.longitude }),
      );
    })();
    return () => sub?.remove();
  }, []);

  // Algılayıcı durumu (arka plan görevi tarafından da güncellenir)
  useEffect(() => {
    const reload = () => {
      void loadSnapshot().then(setSnapshot);
      void isTracking().then(setTracking);
    };
    reload();
    const unsub = subscribeTracker(setSnapshot);
    const appState = AppState.addEventListener('change', (s) => s === 'active' && reload());
    const tick = setInterval(() => setNow(Date.now()), 15_000);
    return () => {
      unsub();
      appState.remove();
      clearInterval(tick);
    };
  }, []);

  const centeredOnce = useRef(false);
  useEffect(() => {
    if (me && !centeredOnce.current) {
      centeredOnce.current = true;
      mapRef.current?.animateToRegion({ ...me, latitudeDelta: 0.012, longitudeDelta: 0.012 }, 600);
    }
  }, [me]);

  const live = useMemo(() => signals.filter((s) => s.expiresAt > now), [signals, now]);
  const selected = live.find((s) => s.id === selectedId) ?? null;
  const claim = live.find((s) => s.claimedByMe) ?? myClaim;
  const parked = snapshot?.detector.parked ?? null;
  // Paylaştığım yerin güncel durumu (ör. biri "gidiyorum" dedi) canlı listeden gelir.
  const mySignal = snapshot?.mySignal
    ? (live.find((s) => s.id === snapshot.mySignal?.id) ?? snapshot.mySignal)
    : null;
  const nearbyFree = live.filter((s) => s.status === 'active' && !s.isMine).length;

  const run = useCallback(async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      Alert.alert('Olmadı', signalErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const toggleTracking = () =>
    run(async () => {
      if (tracking) {
        await stopTracking();
        setTracking(false);
        return;
      }
      const result = await requestTrackingPermissions();
      if (result === 'denied') {
        Alert.alert('Konum izni gerekli', 'Aracının kalktığını anlamak için konum iznine ihtiyacımız var.', [
          { text: 'Vazgeç', style: 'cancel' },
          { text: 'Ayarlar', onPress: () => void Linking.openSettings() },
        ]);
        return;
      }
      if (result === 'foreground-only') {
        Alert.alert(
          '"Her zaman" izni önerilir',
          'Uygulama kapalıyken de yerini paylaşabilmemiz için Ayarlar > Konum bölümünden "Her zaman" seçeneğini aç.',
          [
            { text: 'Sonra', style: 'cancel' },
            { text: 'Ayarlar', onPress: () => void Linking.openSettings() },
          ],
        );
      }
      await requestNotificationPermission();
      await startTracking();
      setTracking(true);
    });

  const requireMe = (): LatLng | null => {
    if (!me) Alert.alert('Konum bekleniyor', 'Konumun henüz alınamadı, birkaç saniye sonra tekrar dene.');
    return me;
  };

  const onParkedHere = () => {
    const at = requireMe();
    if (at) void run(() => setParkedHere(at));
  };

  const leave = (minutes: number) => {
    const at = requireMe();
    if (!at) return;
    void run(async () => {
      await shareMySpot(at, minutes);
      await refresh();
    });
  };

  const onClaim = (s: Signal) =>
    run(async () => {
      const claimed = await claimSignal(s.id);
      setMyClaim({ ...claimed, distanceM: s.distanceM });
      setSelectedId(null);
      await refresh();
      openNavigation(claimed);
    });

  const onFinish = (parkedThere: boolean | null) => {
    if (!claim) return;
    void run(async () => {
      await finishClaim(claim.id, parkedThere);
      // Yere park ettiysen, sen ayrılırken bu yer yeniden paylaşılacak.
      if (parkedThere) await setParkedHere(claim);
      setMyClaim(null);
      await refresh();
    });
  };

  return (
    <View style={styles.container}>
      <MapView
        ref={mapRef}
        style={StyleSheet.absoluteFill}
        initialRegion={me ? { ...me, latitudeDelta: 0.012, longitudeDelta: 0.012 } : ISTANBUL}
        showsUserLocation
        showsMyLocationButton
        onPress={() => setSelectedId(null)}
      >
        {live.map((s) => (
          <SignalMarker
            key={s.id}
            signal={s}
            now={now}
            selected={s.id === selectedId}
            onPress={() => setSelectedId(s.id)}
          />
        ))}
        {parked && !mySignal && (
          <Marker coordinate={parked} title="Aracın" description="Park ettiğin yer" tracksViewChanges={false}>
            <Text style={styles.carMarker}>🚗</Text>
          </Marker>
        )}
      </MapView>

      <SafeAreaView edges={['top']} style={styles.top} pointerEvents="box-none">
        <View style={styles.topBar}>
          <Text style={styles.brand}>Park Sinyal</Text>
          <Pressable
            onPress={() => setSeeking((v) => !v)}
            style={[styles.chip, seeking && { backgroundColor: colors.free, borderColor: colors.free }]}
          >
            <Text style={[styles.chipText, seeking && { color: '#fff' }]}>
              {seeking ? '🔔 Yer arıyorum' : '🔕 Bildirim kapalı'}
            </Text>
          </Pressable>
        </View>
        {!isBackendConfigured && (
          <Text style={styles.banner}>Sunucu ayarlı değil: .env dosyasına Supabase bilgilerini ekleyin.</Text>
        )}
        {locationDenied && (
          <Text style={styles.banner} onPress={() => void Linking.openSettings()}>
            Konum izni kapalı. Açmak için dokun.
          </Text>
        )}
        {error && <Text style={styles.banner}>{error}</Text>}
      </SafeAreaView>

      <SafeAreaView edges={['bottom']} style={styles.sheet}>
        {claim ? (
          <ClaimPanel
            claim={claim}
            now={now}
            distanceM={me ? distanceMeters(me, claim) : null}
            onNavigate={() => openNavigation(claim)}
            onFinish={onFinish}
          />
        ) : selected ? (
          <SpotPanel signal={selected} now={now} busy={busy} onClaim={() => onClaim(selected)} onClose={() => setSelectedId(null)} />
        ) : (
          <DriverPanel
            tracking={tracking}
            now={now}
            onToggleTracking={toggleTracking}
            parked={parked}
            mySignal={mySignal}
            nearbyCount={nearbyFree}
            busy={busy}
            onParkedHere={onParkedHere}
            onLeaveNow={() => leave(0)}
            onLeaveSoon={() => leave(5)}
            onUndoSignal={() => void run(undoMySignal)}
            onForgetCar={() => void run(forgetParked)}
          />
        )}
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#e5e7eb' },
  top: { position: 'absolute', top: 0, left: 0, right: 0, paddingHorizontal: 12 },
  topBar: {
    marginTop: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.surface,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 10,
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 8,
    elevation: 4,
  },
  brand: { fontSize: 18, fontWeight: '800', color: colors.text },
  chip: { borderWidth: 1, borderColor: colors.border, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6 },
  chipText: { fontSize: 13, fontWeight: '600', color: colors.text },
  banner: {
    marginTop: 8,
    backgroundColor: '#fef3c7',
    color: '#92400e',
    padding: 10,
    borderRadius: 10,
    overflow: 'hidden',
    fontSize: 13,
  },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.surface,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 16,
    paddingTop: 16,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 12,
  },
  carMarker: { fontSize: 28 },
});
