import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

let channelReady: Promise<unknown> | null = null;

function ensureChannel() {
  if (Platform.OS !== 'android') return Promise.resolve();
  channelReady ??= Notifications.setNotificationChannelAsync('park', {
    name: 'Park sinyalleri',
    importance: Notifications.AndroidImportance.HIGH,
  });
  return channelReady;
}

export async function requestNotificationPermission(): Promise<boolean> {
  const current = await Notifications.getPermissionsAsync();
  if (current.granted) return true;
  return (await Notifications.requestPermissionsAsync()).granted;
}

/** Anında yerel bildirim gösterir; bildirim izni yoksa sessizce geçer. */
export async function notify(title: string, body: string): Promise<void> {
  try {
    await ensureChannel();
    await Notifications.scheduleNotificationAsync({
      content: { title, body },
      trigger: Platform.OS === 'android' ? { channelId: 'park' } : null,
    });
  } catch {
    // bildirim zorunlu değil
  }
}
