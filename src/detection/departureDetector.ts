/**
 * Park/kalkış algılama motoru.
 *
 * Saf (pure) bir durum makinesidir: konum örneklerini sırayla alır, yeni durumu ve
 * olayları döndürür. Platform API'lerine bağımlı olmadığı için hem arka plan
 * görevinde hem testlerde aynen çalışır.
 *
 *   idle ──(sürüş hızı)──▶ driving ──(dur + yürüyerek uzaklaş)──▶ parked
 *                              ▲                                   │
 *                              └──(park yerinin yakınında sürüş)───┘  => "departed"
 *
 * "departed" olayı, park yerinin boşaldığı anlamına gelir; uygulama bu anda
 * haritaya sinyal gönderir.
 */
import { distanceMeters, type LatLng } from '../lib/geo';

export type MotionHint = 'automotive' | 'walking' | 'running' | 'cycling' | 'stationary' | null;

export type LocationSample = LatLng & {
  /** GPS hızı (m/s). Bilinmiyorsa null ya da negatif. */
  speed: number | null;
  /** Yatay doğruluk (m). */
  accuracy: number | null;
  /** ms (epoch) */
  timestamp: number;
  /** İşletim sisteminin hareket algılayıcısından gelen ipucu (varsa). */
  motion?: MotionHint;
};

export type ParkedSpot = LatLng & { since: number; source: 'auto' | 'manual' };

type Stop = LatLng & { at: number };

export type DetectorState = {
  phase: 'idle' | 'driving' | 'parked';
  drivingStreak: number;
  /** Sürüş artarda algılanmaya başladığı ilk nokta. */
  driveStart: LatLng | null;
  /** Sürüş sırasında aracın durduğu nokta (park adayı). */
  stop: Stop | null;
  parked: ParkedSpot | null;
  /** Kullanıcı park ettikten sonra araçtan uzaklaştı mı? */
  wentAway: boolean;
  returnNotified: boolean;
  last: LocationSample | null;
};

export type DetectorEvent =
  | { type: 'parked'; spot: ParkedSpot }
  | { type: 'returningToCar'; spot: ParkedSpot }
  | { type: 'departed'; spot: ParkedSpot; at: number };

export type DetectorConfig = {
  /** Bundan kötü doğruluktaki örnekler yok sayılır (m). */
  maxAccuracyM: number;
  /** Bu hızın üzeri sürüş kabul edilir (m/s). ~20 km/s */
  drivingSpeed: number;
  /** İşletim sistemi "araçta" diyorsa daha düşük eşik yeterli (m/s). */
  drivingSpeedWithMotion: number;
  /** Sürüş sayılması için artarda gereken örnek sayısı. */
  drivingStreakRequired: number;
  /** Bu hızın altı "durdu" kabul edilir (m/s). */
  stoppedSpeed: number;
  /** Yürüyüşün üst sınırı (m/s). Üstü trafikte ağır ilerleme sayılır. */
  walkMaxSpeed: number;
  /** Duruş noktasından bu kadar yürüyerek uzaklaşınca park edildi sayılır (m). */
  walkAwayDistance: number;
  walkAwayMinMs: number;
  /** Kalkış ancak park yerinin bu yarıçapında başladıysa sinyal verilir (m). */
  departureRadius: number;
  /** Araçtan bu kadar uzaklaşınca "uzakta" sayılır (m). */
  awayDistance: number;
  /** Uzaktayken araca bu mesafeye dönülünce "araca dönüyor" olayı (m). */
  returnDistance: number;
};

export const DEFAULT_CONFIG: DetectorConfig = {
  maxAccuracyM: 50,
  drivingSpeed: 5.5,
  drivingSpeedWithMotion: 2.5,
  drivingStreakRequired: 2,
  stoppedSpeed: 1.5,
  walkMaxSpeed: 2.5,
  walkAwayDistance: 40,
  walkAwayMinMs: 20_000,
  departureRadius: 200,
  awayDistance: 120,
  returnDistance: 35,
};

export const initialState: DetectorState = {
  phase: 'idle',
  drivingStreak: 0,
  driveStart: null,
  stop: null,
  parked: null,
  wentAway: false,
  returnNotified: false,
  last: null,
};

const point = (p: LatLng): LatLng => ({ latitude: p.latitude, longitude: p.longitude });

function effectiveSpeed(last: LocationSample | null, s: LocationSample): number {
  if (s.speed != null && s.speed >= 0) return s.speed;
  if (!last) return 0;
  const dt = (s.timestamp - last.timestamp) / 1000;
  return dt > 0 ? distanceMeters(last, s) / dt : 0;
}

export function step(
  state: DetectorState,
  sample: LocationSample,
  cfg: DetectorConfig = DEFAULT_CONFIG,
): { state: DetectorState; events: DetectorEvent[] } {
  if (sample.accuracy != null && sample.accuracy > cfg.maxAccuracyM) {
    return { state, events: [] };
  }

  const events: DetectorEvent[] = [];
  const speed = effectiveSpeed(state.last, sample);
  const automotive = sample.motion === 'automotive';
  const onFoot =
    sample.motion === 'walking' || sample.motion === 'running' || sample.motion === 'cycling';
  const isDriving =
    !onFoot &&
    (speed >= cfg.drivingSpeed || (automotive && speed >= cfg.drivingSpeedWithMotion));

  const next: DetectorState = {
    ...state,
    drivingStreak: isDriving ? state.drivingStreak + 1 : 0,
    driveStart: isDriving ? (state.driveStart ?? point(sample)) : null,
    last: sample,
  };
  const drivingConfirmed = next.drivingStreak >= cfg.drivingStreakRequired;

  if (state.phase === 'parked' && state.parked) {
    const spot = state.parked;
    if (drivingConfirmed) {
      // Araç hareket etti. Sürüş park yerinin yakınında başladıysa yer boşalmıştır;
      // uzakta başladıysa kullanıcı muhtemelen taksi/otobüs vb. kullanıyor.
      if (distanceMeters(next.driveStart!, spot) <= cfg.departureRadius) {
        events.push({ type: 'departed', spot, at: sample.timestamp });
      }
      return {
        state: { ...next, phase: 'driving', parked: null, stop: null, wentAway: false, returnNotified: false },
        events,
      };
    }
    const dist = distanceMeters(sample, spot);
    if (dist >= cfg.awayDistance) next.wentAway = true;
    if (next.wentAway && !next.returnNotified && dist <= cfg.returnDistance) {
      next.returnNotified = true;
      events.push({ type: 'returningToCar', spot });
    }
    return { state: next, events };
  }

  if (drivingConfirmed) next.phase = 'driving';
  if (next.phase !== 'driving') return { state: next, events };

  if (isDriving || speed > cfg.walkMaxSpeed || (automotive && speed > cfg.stoppedSpeed)) {
    // Hâlâ araçta (ya da trafikte ağır ilerliyor): duruş adayını iptal et.
    next.stop = null;
  } else if (!next.stop && speed <= cfg.stoppedSpeed) {
    next.stop = { ...point(sample), at: sample.timestamp };
  }

  if (next.stop && !automotive) {
    // GPS sapması yüzünden kırmızı ışıkta "yürüdü" sanmamak için doğruluk payını düş.
    const walked = distanceMeters(next.stop, sample) - (sample.accuracy ?? 0);
    const elapsed = sample.timestamp - next.stop.at;
    if (walked >= cfg.walkAwayDistance && elapsed >= cfg.walkAwayMinMs) {
      const spot: ParkedSpot = { ...point(next.stop), since: next.stop.at, source: 'auto' };
      events.push({ type: 'parked', spot });
      return {
        state: { ...next, phase: 'parked', parked: spot, stop: null, wentAway: false, returnNotified: false },
        events,
      };
    }
  }
  return { state: next, events };
}

/** Kullanıcı aracın yerini elle işaretlediğinde. */
export function markParked(state: DetectorState, at: LatLng, now: number = Date.now()): DetectorState {
  return {
    ...state,
    phase: 'parked',
    parked: { ...point(at), since: now, source: 'manual' },
    stop: null,
    drivingStreak: 0,
    driveStart: null,
    wentAway: false,
    returnNotified: false,
  };
}

/** Park bilgisi temizlenir (ör. kullanıcı elle "çıkıyorum" dedi). */
export function clearParked(state: DetectorState): DetectorState {
  return { ...state, phase: 'idle', parked: null, stop: null, wentAway: false, returnNotified: false };
}
