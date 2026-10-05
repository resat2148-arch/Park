import type { ExpoConfig } from 'expo/config';

const config: ExpoConfig = {
  name: 'Park Sinyal',
  slug: 'park-sinyal',
  scheme: 'parksinyal',
  version: '1.0.0',
  orientation: 'portrait',
  icon: './assets/icon.png',
  userInterfaceStyle: 'light',
  ios: {
    bundleIdentifier: 'com.parksinyal.app',
    supportsTablet: false,
    infoPlist: {
      ITSAppUsesNonExemptEncryption: false,
    },
  },
  android: {
    package: 'com.parksinyal.app',
    adaptiveIcon: {
      backgroundColor: '#E6F4FE',
      foregroundImage: './assets/android-icon-foreground.png',
      backgroundImage: './assets/android-icon-background.png',
      monochromeImage: './assets/android-icon-monochrome.png',
    },
    predictiveBackGestureEnabled: false,
  },
  plugins: [
    [
      'expo-location',
      {
        locationWhenInUsePermission: 'Yakınındaki boş park yerlerini haritada göstermek için konumunu kullanıyoruz.',
        locationAlwaysAndWhenInUsePermission:
          'Aracınla park yerinden ayrıldığını anlayıp yerini bekleyen sürücülere bildirmek için uygulama kapalıyken de konumuna ihtiyacımız var.',
        locationAlwaysPermission:
          'Aracınla park yerinden ayrıldığını anlayıp yerini bekleyen sürücülere bildirmek için uygulama kapalıyken de konumuna ihtiyacımız var.',
        motionUsagePermission: 'Araçta mı yoksa yürüyor musun anlamak için hareket verisini kullanıyoruz; böylece yanlış sinyal vermeyiz.',
        isIosBackgroundLocationEnabled: true,
        isAndroidBackgroundLocationEnabled: true,
        isAndroidForegroundServiceEnabled: true,
        isAndroidMotionActivityEnabled: true,
      },
    ],
    'expo-task-manager',
    'expo-notifications',
    [
      'react-native-maps',
      {
        // Android'de Google Maps için zorunlu. iOS varsayılan olarak Apple Haritalar kullanır.
        androidGoogleMapsApiKey: process.env.GOOGLE_MAPS_ANDROID_API_KEY,
      },
    ],
  ],
};

export default config;
