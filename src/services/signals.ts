import type { LatLng } from '../lib/geo';
import { ensureSession, supabase } from '../lib/supabase';

export type SignalStatus = 'active' | 'claimed' | 'taken' | 'gone' | 'cancelled';

export type Signal = LatLng & {
  id: string;
  source: 'auto' | 'manual';
  /** 0 = şu an boşaldı, >0 = sürücü X dk içinde çıkacak */
  leavingInMin: number;
  status: SignalStatus;
  createdAt: number;
  expiresAt: number;
  distanceM: number | null;
  isMine: boolean;
  claimedByMe: boolean;
};

type SignalViewRow = {
  id: string;
  lat: number;
  lng: number;
  source: 'auto' | 'manual';
  leaving_in_min: number;
  status: SignalStatus;
  created_at: string;
  expires_at: string;
  distance_m?: number | null;
  is_mine?: boolean;
  claimed_by_me?: boolean;
};

const toSignal = (r: SignalViewRow): Signal => ({
  id: r.id,
  latitude: r.lat,
  longitude: r.lng,
  source: r.source,
  leavingInMin: r.leaving_in_min,
  status: r.status,
  createdAt: Date.parse(r.created_at),
  expiresAt: Date.parse(r.expires_at),
  distanceM: r.distance_m ?? null,
  isMine: r.is_mine ?? true,
  claimedByMe: r.claimed_by_me ?? false,
});

/** Sunucu hata kodlarını kullanıcıya gösterilecek Türkçe mesaja çevirir. */
export function signalErrorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String((e as { message?: string })?.message ?? e);
  if (msg.includes('signal_unavailable')) return 'Bu yer artık müsait değil, başka biri yola çıkmış olabilir.';
  if (msg.includes('rate_limited')) return 'Çok sık sinyal gönderdin, biraz sonra tekrar dene.';
  if (msg.includes('yapılandırılmamış')) return msg;
  return 'Bağlantı hatası, tekrar dene.';
}

export async function fetchNearbySignals(center: LatLng, radiusM = 1500): Promise<Signal[]> {
  await ensureSession();
  const { data, error } = await supabase.rpc('nearby_signals', {
    p_lat: center.latitude,
    p_lng: center.longitude,
    p_radius_m: radiusM,
  });
  if (error) throw error;
  return (data as SignalViewRow[]).map(toSignal);
}

export async function publishSignal(
  spot: LatLng,
  source: 'auto' | 'manual',
  leavingInMin = 0,
): Promise<Signal> {
  await ensureSession();
  const { data, error } = await supabase.rpc('publish_signal', {
    p_lat: spot.latitude,
    p_lng: spot.longitude,
    p_source: source,
    p_leaving_in_min: leavingInMin,
  });
  if (error) throw error;
  return toSignal(data as SignalViewRow);
}

export async function cancelSignal(id: string): Promise<void> {
  const { error } = await supabase.rpc('cancel_signal', { p_id: id });
  if (error) throw error;
}

export async function claimSignal(id: string): Promise<Signal> {
  await ensureSession();
  const { data, error } = await supabase.rpc('claim_signal', { p_id: id });
  if (error) throw error;
  return { ...toSignal(data as SignalViewRow), isMine: false, claimedByMe: true };
}

/** parked: true = park ettim, false = yer doluydu, null = vazgeçtim */
export async function finishClaim(id: string, parked: boolean | null): Promise<void> {
  const { error } = await supabase.rpc('finish_claim', { p_id: id, p_parked: parked });
  if (error) throw error;
}

/**
 * Tablodaki her değişiklikte (yeni sinyal, sahiplenme, iptal) `onChange` çağrılır.
 * Satırları RLS süzer; istemci değişiklikte yakın listeyi yeniden çeker.
 */
export function subscribeSignalChanges(onChange: () => void): () => void {
  const channel = supabase
    .channel('parking_signals')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'parking_signals' }, onChange)
    .subscribe();
  return () => {
    void supabase.removeChannel(channel);
  };
}
