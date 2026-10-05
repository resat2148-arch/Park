import {
  DEFAULT_CONFIG,
  initialState,
  markParked,
  step,
  type DetectorEvent,
  type DetectorState,
  type LocationSample,
} from '../departureDetector';

// Kadıköy civarı bir başlangıç noktası. Enlemde 1 m ≈ 0.000009°.
const ORIGIN = { latitude: 40.99, longitude: 29.03 };
const M = 1 / 111_320;

/** Kuzeye `meters` kadar ilerlemiş nokta. */
const north = (meters: number) => ({ latitude: ORIGIN.latitude + meters * M, longitude: ORIGIN.longitude });

type Leg = { fromM: number; toM: number; speed: number; motion?: LocationSample['motion'] };

/** Sabit hızla ilerleyen bir yolculuğu 5 sn aralıklı örneklere çevirir. */
function simulate(start: DetectorState, t0: number, legs: Leg[]) {
  let state = start;
  let t = t0;
  const events: DetectorEvent[] = [];
  for (const leg of legs) {
    const dist = Math.abs(leg.toM - leg.fromM);
    const n = leg.speed === 0 ? 6 : Math.max(1, Math.ceil(dist / (leg.speed * 5)));
    for (let i = 1; i <= n; i++) {
      t += 5000;
      const pos = north(leg.fromM + ((leg.toM - leg.fromM) * i) / n);
      const r = step(state, { ...pos, speed: leg.speed, accuracy: 8, timestamp: t, motion: leg.motion ?? null });
      state = r.state;
      events.push(...r.events);
    }
  }
  return { state, events, t };
}

describe('departureDetector', () => {
  it('sürüp durduktan sonra yürüyerek uzaklaşınca park edildi olayı üretir', () => {
    const { state, events } = simulate(initialState, 0, [
      { fromM: 0, toM: 1000, speed: 12 }, // sürüş
      { fromM: 1000, toM: 1000, speed: 0 }, // durdu (park manevrası)
      { fromM: 1000, toM: 1100, speed: 1.4 }, // yürüyerek uzaklaşıyor
    ]);
    expect(events.map((e) => e.type)).toEqual(['parked']);
    expect(state.phase).toBe('parked');
    const spot = (events[0] as Extract<DetectorEvent, { type: 'parked' }>).spot;
    expect(Math.abs(spot.latitude - north(1000).latitude) / M).toBeLessThan(5);
  });

  it('kırmızı ışıkta bekleyip devam edince park sanmaz', () => {
    const { state, events } = simulate(initialState, 0, [
      { fromM: 0, toM: 500, speed: 12 },
      { fromM: 500, toM: 500, speed: 0 },
      { fromM: 500, toM: 1500, speed: 12 },
    ]);
    expect(events).toEqual([]);
    expect(state.phase).toBe('driving');
  });

  it('trafikte ağır ilerlemeyi yürüyüş sanmaz', () => {
    const { events } = simulate(initialState, 0, [
      { fromM: 0, toM: 500, speed: 12 },
      { fromM: 500, toM: 500, speed: 0 },
      { fromM: 500, toM: 700, speed: 3.5 }, // tampon tampona
      { fromM: 700, toM: 700, speed: 0 },
      { fromM: 700, toM: 760, speed: 2, motion: 'automotive' },
    ]);
    expect(events).toEqual([]);
  });

  it('park yerine dönüp aracı çalıştırınca "departed" (yer boşaldı) olayı üretir', () => {
    const parked = simulate(initialState, 0, [
      { fromM: 0, toM: 1000, speed: 12 },
      { fromM: 1000, toM: 1000, speed: 0 },
      { fromM: 1000, toM: 1400, speed: 1.4 }, // işine yürüdü
    ]);
    const { state, events } = simulate(parked.state, parked.t + 3 * 3600_000, [
      { fromM: 1400, toM: 1002, speed: 1.4 }, // araca geri yürüdü
      { fromM: 1002, toM: 1002, speed: 0 }, // bindi, çalıştırdı
      { fromM: 1002, toM: 1500, speed: 9 }, // kalktı
    ]);
    expect(events.map((e) => e.type)).toEqual(['returningToCar', 'departed']);
    expect(state.phase).toBe('driving');
    expect(state.parked).toBeNull();
  });

  it('park yerinden uzakta taksiye/otobüse binerse sinyal vermez', () => {
    const parked = simulate(markParked(initialState, north(0), 0), 0, [
      { fromM: 0, toM: 800, speed: 1.4 }, // yürüyerek uzaklaştı
    ]);
    const { state, events } = simulate(parked.state, parked.t, [{ fromM: 800, toM: 3000, speed: 11 }]);
    expect(events).toEqual([]);
    expect(state.phase).toBe('driving');
  });

  it('bisiklet hızı sürüş sayılmaz', () => {
    const { state, events } = simulate(markParked(initialState, north(0), 0), 0, [
      { fromM: 0, toM: 2000, speed: 6, motion: 'cycling' },
    ]);
    expect(events.filter((e) => e.type === 'departed')).toEqual([]);
    expect(state.phase).toBe('parked');
  });

  it('düşük doğruluklu örnekleri yok sayar', () => {
    const s = markParked(initialState, north(0), 0);
    const r = step(s, { ...north(50), speed: 20, accuracy: 300, timestamp: 1000 });
    expect(r.state).toBe(s);
    expect(r.events).toEqual([]);
  });

  it('hız bilinmiyorsa ardışık konumlardan hesaplar', () => {
    let state = markParked(initialState, north(0), 0);
    const events: DetectorEvent[] = [];
    for (let i = 1; i <= 4; i++) {
      const r = step(state, { ...north(i * 60), speed: null, accuracy: 10, timestamp: i * 5000 });
      state = r.state;
      events.push(...r.events);
    }
    expect(events.map((e) => e.type)).toEqual(['departed']);
    expect(DEFAULT_CONFIG.drivingStreakRequired).toBe(2);
  });
});
