import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Switch, Text, View } from 'react-native';

import type { ParkedSpot } from '../detection/departureDetector';
import { formatAgo, formatDistance } from '../lib/geo';
import type { Signal } from '../services/signals';
import { colors } from '../theme';

type ButtonProps = { title: string; onPress: () => void; color?: string; outline?: boolean; disabled?: boolean };

export function Button({ title, onPress, color = colors.free, outline, disabled }: ButtonProps) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.button,
        outline ? { borderColor: color, borderWidth: 1.5 } : { backgroundColor: color },
        (pressed || disabled) && { opacity: 0.6 },
      ]}
    >
      <Text style={[styles.buttonText, outline && { color }]}>{title}</Text>
    </Pressable>
  );
}

const Row = ({ children }: { children: ReactNode }) => <View style={styles.row}>{children}</View>;

/** Yer arayan kullanıcı bir sinyale "gidiyorum" dedikten sonra */
export function ClaimPanel(props: {
  claim: Signal;
  now: number;
  distanceM: number | null;
  onNavigate: () => void;
  onFinish: (parked: boolean | null) => void;
}) {
  const { claim, distanceM, now } = props;
  return (
    <View>
      <Text style={styles.title}>Park yerine gidiyorsun</Text>
      <Text style={styles.sub}>
        {distanceM != null ? `${formatDistance(distanceM)} kaldı · ` : ''}
        Yer {Math.max(0, Math.ceil((claim.expiresAt - now) / 60_000))} dk boyunca sana ayrıldı
      </Text>
      <Button title="Yol tarifi" onPress={props.onNavigate} color={colors.mine} />
      <Row>
        <Button title="Park ettim ✓" onPress={() => props.onFinish(true)} />
        <Button title="Yer doluydu" onPress={() => props.onFinish(false)} color={colors.danger} outline />
      </Row>
      <Pressable onPress={() => props.onFinish(null)}>
        <Text style={styles.link}>Vazgeç</Text>
      </Pressable>
    </View>
  );
}

/** Haritada seçilen bir sinyal */
export function SpotPanel(props: {
  signal: Signal;
  now: number;
  onClaim: () => void;
  onClose: () => void;
  busy: boolean;
}) {
  const { signal, now } = props;
  const readyAt = signal.createdAt + signal.leavingInMin * 60_000;
  const upcoming = readyAt > now;
  const claimed = signal.status === 'claimed' && !signal.claimedByMe;
  return (
    <View>
      <Text style={styles.title}>
        {signal.isMine ? 'Senin paylaştığın yer' : upcoming ? 'Birazdan boşalacak yer' : 'Boşalan park yeri'}
      </Text>
      <Text style={styles.sub}>
        {signal.distanceM != null ? `${formatDistance(signal.distanceM)} · ` : ''}
        {upcoming
          ? `Sürücü ~${Math.ceil((readyAt - now) / 60_000)} dk içinde çıkacak`
          : `${formatAgo(readyAt, now)} boşaldı`}
        {signal.source === 'auto' ? ' · otomatik algılandı' : ''}
      </Text>
      {claimed ? (
        <Text style={[styles.sub, { color: colors.claimed }]}>Başka bir sürücü bu yere gidiyor.</Text>
      ) : (
        !signal.isMine && <Button title="Gidiyorum" onPress={props.onClaim} disabled={props.busy} />
      )}
      <Pressable onPress={props.onClose}>
        <Text style={styles.link}>Kapat</Text>
      </Pressable>
    </View>
  );
}

/** Varsayılan panel: sürücünün kendi aracı ve otomatik algılama */
export function DriverPanel(props: {
  tracking: boolean;
  now: number;
  onToggleTracking: () => void;
  parked: ParkedSpot | null;
  mySignal: Signal | null;
  nearbyCount: number;
  busy: boolean;
  onParkedHere: () => void;
  onLeaveNow: () => void;
  onLeaveSoon: () => void;
  onUndoSignal: () => void;
  onForgetCar: () => void;
}) {
  const { parked, mySignal } = props;
  return (
    <View>
      <View style={styles.trackRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Otomatik algılama</Text>
          <Text style={styles.sub}>
            {props.tracking
              ? 'Aracınla ayrıldığında yerin otomatik paylaşılır.'
              : 'Açarsan araca binip çıktığını anlar, yerini bekleyenlere bildiririz.'}
          </Text>
        </View>
        <Switch value={props.tracking} onValueChange={props.onToggleTracking} trackColor={{ true: colors.free }} />
      </View>

      <View style={styles.divider} />

      {mySignal ? (
        <>
          <Text style={styles.title}>📍 Yerin paylaşıldı</Text>
          <Text style={styles.sub}>
            {mySignal.status === 'claimed' ? 'Bir sürücü yerine geliyor. Teşekkürler!' : 'Yakındaki sürücüler görüyor.'}
          </Text>
          <Button title="Geri al (hâlâ park halindeyim)" onPress={props.onUndoSignal} outline color={colors.danger} />
        </>
      ) : parked ? (
        <>
          <Text style={styles.title}>🚗 Aracın park halinde</Text>
          <Text style={styles.sub}>
            {formatAgo(parked.since, props.now)} {parked.source === 'auto' ? 'otomatik kaydedildi' : 'kaydettin'}
          </Text>
          <Row>
            <Button title="Çıkıyorum" onPress={props.onLeaveNow} disabled={props.busy} />
            <Button title="5 dk sonra çıkıyorum" onPress={props.onLeaveSoon} color={colors.soon} disabled={props.busy} />
          </Row>
          <Pressable onPress={props.onForgetCar}>
            <Text style={styles.link}>Park kaydını sil</Text>
          </Pressable>
        </>
      ) : (
        <>
          <Text style={styles.sub}>
            {props.nearbyCount > 0
              ? `Yakınında ${props.nearbyCount} boş yer var. Haritadan birine dokun.`
              : 'Yakınında şu an boşalan yer yok. Yeni yer açılınca haber vereceğiz.'}
          </Text>
          <Row>
            <Button title="Buraya park ettim" onPress={props.onParkedHere} color={colors.car} disabled={props.busy} />
            <Button title="Çıkıyorum" onPress={props.onLeaveNow} outline disabled={props.busy} />
          </Row>
        </>
      )}
      {props.busy && <ActivityIndicator style={{ marginTop: 8 }} />}
    </View>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: 17, fontWeight: '700', color: colors.text },
  sub: { fontSize: 14, color: colors.muted, marginTop: 4, marginBottom: 10 },
  row: { flexDirection: 'row', gap: 8 },
  trackRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  divider: { height: 1, backgroundColor: colors.border, marginVertical: 12 },
  button: {
    flex: 1,
    minHeight: 48,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
    marginBottom: 8,
  },
  buttonText: { color: '#fff', fontSize: 15, fontWeight: '700', textAlign: 'center' },
  link: { color: colors.muted, textAlign: 'center', paddingVertical: 8, textDecorationLine: 'underline' },
});
