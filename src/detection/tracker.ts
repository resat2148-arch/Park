/**
 * Arka plan konum takibi: işletim sisteminden gelen konumları algılama motoruna
 * besler, olaylara göre sinyal yayınlar ve bildirim gösterir.
 *
 * Bu dosya `index.ts` içinde en üst seviyede import edilmelidir; TaskManager
 * görevleri uygulama arka planda uyandırıldığında da tanımlı olmalıdır.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';

import type { LatLng } from '../lib/geo';
import { notify } from '../services/notify';
import { cancelSignal, publishSignal, type Signal } from '../services/signals';
import {
  clearParked,
  initialState,
  markParked,
  step,
  type DetectorEvent,
  type DetectorState,
  type LocationSample,
  type MotionHint,
} from './departureDetector';

export const LOCATION_TASK = 'park-sinyal-location';
export const GEOFENCE_TASK = 'park-sinyal-geofence';
const GEOFENCE_KEY = 'park-sinyal/geofence';
const STATE_KEY = 'park-sinyal/detector-state';
const MY_SIGNAL_KEY = 'park-sinyal/my-signal';

// ---------------------------------------------------------------------------
// Kalıcı durum + ön plandaki arayüz için basit yayıncı
// ---------------------------------------------------------------------------

export type TrackerSnapshot = { detector: DetectorState; mySignal: Signal | null };

const listeners = new Set<(s: TrackerSnapshot) => void>();

export async function loadSnapshot(): Promise<TrackerSnapshot> {
  const [rawState, rawSignal] = await Promise.all([
    AsyncStorage.getItem(STATE_KEY),
    AsyncStorage.getItem(MY_SIGNAL_KEY),
  ]);
  const mySignal: Signal | null = rawSignal ? JSON.parse(rawSignal) : null;
  return {
    detector: rawState ? { ...initialState, ...JSON.parse(rawState) } : initialState,
    mySignal: mySignal && mySignal.expiresAt > Date.now() ? mySignal : null,
  };
}

async function save(update: Partial<TrackerSnapshot>): Promise<void> {
  const writes: Promise<void>[] = [];
  if (update.detector) writes.push(AsyncStorage.setItem(STATE_KEY, JSON.stringify(update.detector)));
  if (update.mySignal !== undefined) {
    writes.push(
      update.mySignal
        ? AsyncStorage.setItem(MY_SIGNAL_KEY, JSON.stringify(update.mySignal))
        : AsyncStorage.removeItem(MY_SIGNAL_KEY),
    );
  }
  await Promise.all(writes);
  const snapshot = await loadSnapshot();
  listeners.forEach((l) => l(snapshot));
}

export function subscribeTracker(listener: (s: TrackerSnapshot) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Konum grupları sırayla işlenmeli; aksi halde durum yazımları birbirini ezer.
let queue: Promise<unknown> = Promise.resolve();
const serialized = <T>(fn: () => Promise<T>): Promise<T> => {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
};

// ---------------------------------------------------------------------------
// Kullanıcı eylemleri
// ---------------------------------------------------------------------------

export const setParkedHere = (at: LatLng) =>
  serialized(async () => {
    const { detector } = await loadSnapshot();
    await save({ detector: markParked(detector, at) });
    await syncGeofence();
  });

export const forgetParked = () =>
  serialized(async () => {
    const { detector } = await loadSnapshot();
    await save({ detector: clearParked(detector) });
    await syncGeofence();
  });

/** Kullanıcı elle "çıkıyorum" dediğinde: aracın kayıtlı yeri (yoksa mevcut konum) paylaşılır. */
export const shareMySpot = (fallback: LatLng, leavingInMin = 0) =>
  serialized(async () => {
    const { detector } = await loadSnapshot();
    const spot = detector.parked ?? fallback;
    const signal = await publishSignal(spot, 'manual', leavingInMin);
    // Hemen çıkıyorsa park kaydı biter; "X dk sonra" ise araç hâlâ orada.
    await save({ mySignal: signal, detector: leavingInMin === 0 ? clearParked(detector) : detector });
    await syncGeofence();
    return signal;
  });

/** Yanlış algılama ya da vazgeçme: sinyal geri çekilir, araç yine park halinde sayılır. */
export const undoMySignal = () =>
  serialized(async () => {
    const { detector, mySignal } = await loadSnapshot();
    if (!mySignal) return;
    await cancelSignal(mySignal.id);
    await save({ mySignal: null, detector: detector.parked ? detector : markParked(detector, mySignal) });
    await syncGeofence();
  });

// ---------------------------------------------------------------------------
// Olay işleme
// ---------------------------------------------------------------------------

async function handleEvent(event: DetectorEvent): Promise<void> {
  switch (event.type) {
    case 'parked':
      await notify('🚗 Park yerin kaydedildi', 'Aracınla ayrıldığında yerin bekleyenlere otomatik bildirilecek.');
      break;
    case 'returningToCar':
      await notify('Aracına dönüyorsun', 'Çıkmak üzereysen uygulamadan "Çıkıyorum" diyerek yerini erkenden paylaşabilirsin.');
      break;
    case 'departed': {
      const { mySignal } = await loadSnapshot();
      // Kullanıcı az önce elle paylaştıysa tekrar gönderme.
      if (mySignal && mySignal.status === 'active' && Date.now() - mySignal.createdAt < 15 * 60_000) break;
      try {
        const signal = await publishSignal(event.spot, 'auto');
        await save({ mySignal: signal });
        await notify('📍 Park yerin paylaşıldı', 'Yakında yer arayanlar artık görüyor. Yanlışsa uygulamadan geri alabilirsin.');
      } catch (e) {
        console.warn('Sinyal gönderilemedi', e);
      }
      break;
    }
  }
}

function motionFrom(obj: Location.MotionActivityObject): MotionHint {
  const order: [Location.MotionActivityType, MotionHint][] = [
    [Location.MotionActivityType.Automotive, 'automotive'],
    [Location.MotionActivityType.Cycling, 'cycling'],
    [Location.MotionActivityType.Running, 'running'],
    [Location.MotionActivityType.Walking, 'walking'],
    [Location.MotionActivityType.Stationary, 'stationary'],
  ];
  for (const [type, hint] of order) {
    const a = obj.activities[type];
    if (a?.detected && a.confidence >= Location.MotionActivityConfidence.Medium) return hint;
  }
  return null;
}

let motionAllowed: boolean | null = null;

/** Hareket sensöründen tek seferlik ipucu (izin yoksa ya da yanıt gecikirse null). */
async function readMotionHint(): Promise<MotionHint> {
  try {
    motionAllowed ??= (await Location.getMotionActivityPermissionsAsync()).granted;
    if (!motionAllowed) return null;
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500));
    const result = await Promise.race([Location.getMotionActivityAsync(), timeout]);
    return result ? motionFrom(result) : null;
  } catch {
    return null;
  }
}

export const processLocations = (locations: Location.LocationObject[]) =>
  serialized(async () => {
    let { detector } = await loadSnapshot();
    const events: DetectorEvent[] = [];
    const sorted = [...locations].sort((a, b) => a.timestamp - b.timestamp);
    // Hız belirsizken (yavaş ilerleme / durma) hareket sensörüne danış. Tek okuma tüm gruba yeter.
    const ambiguous = sorted.some((l) => (l.coords.speed ?? 0) > 0.5 && (l.coords.speed ?? 0) < 5.5);
    const motion = ambiguous ? await readMotionHint() : null;

    for (const loc of sorted) {
      const sample: LocationSample = {
        latitude: loc.coords.latitude,
        longitude: loc.coords.longitude,
        speed: loc.coords.speed,
        accuracy: loc.coords.accuracy,
        timestamp: loc.timestamp,
        motion,
      };
      const r = step(detector, sample);
      detector = r.state;
      events.push(...r.events);
    }
    await save({ detector });
    for (const e of events) await handleEvent(e);
  });

TaskManager.defineTask<{ locations: Location.LocationObject[] }>(LOCATION_TASK, async ({ data, error }) => {
  if (error || !data?.locations?.length) return;
  await processLocations(data.locations);
  await syncGeofence();
});

// iOS, kullanıcı uygulamayı kapatsa bile bölge (geofence) olaylarında uygulamayı
// arka planda uyandırır. Aracın etrafına çit kurarak kalkışı yine yakalarız:
// çitten çıkışta anlık konumu motora besleyip sürekli takibi yeniden başlatırız.
TaskManager.defineTask(GEOFENCE_TASK, async ({ error }) => {
  if (error) return;
  try {
    const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
    await processLocations([pos]);
    await startTracking();
  } catch (e) {
    console.warn('Geofence işlenemedi', e);
  }
});

async function syncGeofence(): Promise<void> {
  try {
    const { detector } = await loadSnapshot();
    const running = await Location.hasStartedGeofencingAsync(GEOFENCE_TASK);
    if (!detector.parked || !(await isTracking())) {
      if (running) await Location.stopGeofencingAsync(GEOFENCE_TASK);
      return;
    }
    if (!(await Location.getBackgroundPermissionsAsync()).granted) return;
    const key = `${detector.parked.latitude},${detector.parked.longitude}`;
    if (running && (await AsyncStorage.getItem(GEOFENCE_KEY)) === key) return;
    await Location.startGeofencingAsync(GEOFENCE_TASK, [
      {
        identifier: 'car',
        latitude: detector.parked.latitude,
        longitude: detector.parked.longitude,
        radius: 150,
        notifyOnEnter: true,
        notifyOnExit: true,
      },
    ]);
    await AsyncStorage.setItem(GEOFENCE_KEY, key);
  } catch (e) {
    console.warn('Geofence kurulamadı', e);
  }
}

// ---------------------------------------------------------------------------
// Takibi başlat / durdur
// ---------------------------------------------------------------------------

export type PermissionResult = 'granted' | 'foreground-only' | 'denied';

export async function requestTrackingPermissions(): Promise<PermissionResult> {
  const fg = await Location.requestForegroundPermissionsAsync();
  if (!fg.granted) return 'denied';
  const bg = await Location.requestBackgroundPermissionsAsync();
  // Hareket izni opsiyonel: algılamayı iyileştirir, yoksa yalnızca hız kullanılır.
  try {
    motionAllowed = (await Location.requestMotionActivityPermissionsAsync()).granted;
  } catch {
    motionAllowed = false;
  }
  return bg.granted ? 'granted' : 'foreground-only';
}

export async function startTracking(): Promise<void> {
  if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK)) return;
  await Location.startLocationUpdatesAsync(LOCATION_TASK, {
    accuracy: Location.Accuracy.High,
    distanceInterval: 15,
    timeInterval: 5000,
    activityType: Location.ActivityType.AutomotiveNavigation,
    pausesUpdatesAutomatically: false,
    showsBackgroundLocationIndicator: false,
    foregroundService: {
      notificationTitle: 'Park Sinyal açık',
      notificationBody: 'Aracınla ayrıldığında park yerin bekleyenlere bildirilir.',
      notificationColor: '#16a34a',
    },
  });
}

export async function stopTracking(): Promise<void> {
  if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK)) {
    await Location.stopLocationUpdatesAsync(LOCATION_TASK);
  }
  if (await Location.hasStartedGeofencingAsync(GEOFENCE_TASK)) {
    await Location.stopGeofencingAsync(GEOFENCE_TASK);
  }
}

export const isTracking = () => Location.hasStartedLocationUpdatesAsync(LOCATION_TASK);
