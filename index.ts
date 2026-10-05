import { registerRootComponent } from 'expo';

// Arka plan görevleri (konum + geofence) uygulama arka planda uyandırıldığında da
// tanımlı olmalı; bu yüzden ekranlardan önce, en üst seviyede yüklenir.
import './src/detection/tracker';

import App from './App';

registerRootComponent(App);
