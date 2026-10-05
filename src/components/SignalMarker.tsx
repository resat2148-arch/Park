import { StyleSheet, Text, View } from 'react-native';
import { Marker } from 'react-native-maps';

import type { Signal } from '../services/signals';
import { colors } from '../theme';

export function signalColor(s: Signal, now: number): string {
  if (s.claimedByMe) return colors.mine;
  if (s.status === 'claimed') return colors.claimed;
  if (s.leavingInMin > 0 && s.createdAt + s.leavingInMin * 60_000 > now) return colors.soon;
  return colors.free;
}

function label(s: Signal, now: number): string {
  if (s.status === 'claimed' && !s.claimedByMe) return 'yolda';
  const readyAt = s.createdAt + s.leavingInMin * 60_000;
  if (readyAt > now) return `${Math.ceil((readyAt - now) / 60_000)} dk`;
  const ago = Math.floor((now - readyAt) / 60_000);
  return ago < 1 ? 'şimdi' : `${ago} dk`;
}

type Props = { signal: Signal; now: number; selected: boolean; onPress: () => void };

export function SignalMarker({ signal, now, selected, onPress }: Props) {
  const text = label(signal, now);
  const color = signalColor(signal, now);
  return (
    <Marker
      // Etiket değiştiğinde yeniden çizilsin; aksi halde tracksViewChanges kapalıyken eski kalır.
      key={`${signal.id}-${text}-${signal.status}-${selected}`}
      coordinate={signal}
      onPress={onPress}
      tracksViewChanges={false}
      anchor={{ x: 0.5, y: 1 }}
    >
      <View style={styles.wrap}>
        <View
          style={[
            styles.pin,
            { backgroundColor: color },
            selected && styles.selected,
            signal.isMine && styles.mine,
          ]}
        >
          <Text style={styles.p}>P</Text>
          <Text style={styles.label}>{text}</Text>
        </View>
        <View style={[styles.tail, { borderTopColor: color }]} />
      </View>
    </Marker>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center' },
  pin: {
    minWidth: 44,
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 10,
    alignItems: 'center',
    borderWidth: 2,
    borderColor: '#fff',
  },
  selected: { transform: [{ scale: 1.2 }] },
  mine: { opacity: 0.6 },
  p: { color: '#fff', fontWeight: '900', fontSize: 16, lineHeight: 18 },
  label: { color: '#fff', fontSize: 10, fontWeight: '600' },
  tail: {
    width: 0,
    height: 0,
    borderLeftWidth: 6,
    borderRightWidth: 6,
    borderTopWidth: 8,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
  },
});
