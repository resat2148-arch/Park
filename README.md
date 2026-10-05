# Park Sinyal 🅿️

Büyük şehirlerde park yeri bulma sorununa çözüm: **park yerinden çıkan sürücünün telefonu, araç kalktığı anda bunu algılar ve haritaya "burası boşaldı" sinyali gönderir.** Yakında yer arayan sürücüler bu sinyali anında haritada görür, "Gidiyorum" diyerek yeri kendine ayırır ve yol tarifiyle gelir.

Android ve iOS için tek kod tabanı: **Expo (React Native) + TypeScript**, sunucu: **Supabase (Postgres + PostGIS + Realtime)**.

## Nasıl çalışır?

```
 ÇIKAN SÜRÜCÜ (telefon cebinde)                 SUPABASE                    YER ARAYAN
 ─────────────────────────────                 ────────                    ──────────
 sürüyor ─▶ durdu ─▶ yürüyerek uzaklaştı
            └─ "park edildi" (yer kaydedildi)
 ... saatler sonra ...
 araca döndü ─▶ çalıştırdı, kalktı
            └─ "departed" ──publish_signal()──▶ parking_signals ──Realtime──▶ haritada yeşil P
                                                       ▲                       "Gidiyorum"
                                                       └──── claim_signal() ◀──┘  (yer ona ayrılır,
                                                                                  diğerleri "yolda" görür)
                                                             finish_claim() ◀── "Park ettim" / "Yer doluydu"
```

### Araç kalkışı nasıl algılanıyor?

`src/detection/departureDetector.ts` içindeki saf (platformdan bağımsız, test edilebilir) durum makinesi:

| Durum | Geçiş koşulu |
|---|---|
| `idle → driving` | Artarda 2 örnek ≥ 20 km/s (ya da işletim sistemi "araçta" diyorsa ≥ 9 km/s) |
| `driving → parked` | Araç durdu, ardından kullanıcı **yürüme hızında** ≥ 40 m uzaklaştı (GPS hata payı düşülür). Kırmızı ışık ve trafik sıkışıklığı park sayılmaz. |
| `parked → driving` | Sürüş tekrar başladı. Sürüş **park yerinin 200 m yakınında** başladıysa ⇒ **`departed` = yer boşaldı, sinyal gönder.** Uzakta başladıysa (taksi, otobüs) sinyal verilmez. |
| `returningToCar` | Araçtan uzaklaşıp geri dönünce bildirim: "Çıkıyorsan yerini erkenden paylaş" |

Sinyaller:
- **GPS hızı + konum** (`expo-location` arka plan konum görevi)
- **Hareket sensörü** (Android Activity Recognition / iOS Core Motion: araçta mı, yürüyor mu, bisiklette mi) — hız belirsizken yanlış alarmı önler
- **Geofence**: park edilen aracın çevresine 150 m'lik sanal çit. iOS kullanıcı uygulamayı kapatsa bile çitten çıkışta uygulamayı arka planda uyandırır.

Otomatik algılamanın yanında elle kontrol de var: **"Buraya park ettim"**, **"Çıkıyorum"**, **"5 dk sonra çıkıyorum"** ve yanlış algılamada **"Geri al"**.

### Aynı yere 5 kişinin koşmasını engelleme

Yer arayan biri "Gidiyorum" dediğinde sinyal `claimed` olur; diğer kullanıcılar onu turuncu ("yolda") görür ve sahiplenemez. Varınca "Park ettim" ya da "Yer doluydu" der. Yere park eden kişinin aracı otomatik olarak oraya kaydedilir; o çıkarken yer yine paylaşılır — döngü kendini besler.

## Proje yapısı

```
index.ts                         Giriş; arka plan görevleri burada kaydedilir
App.tsx
app.config.ts                    İzin metinleri, arka plan modları, harita anahtarı
src/
  detection/
    departureDetector.ts         Park/kalkış durum makinesi (saf TS)
    tracker.ts                   Arka plan konum + geofence görevleri, olay → sinyal
    __tests__/                   Senaryo testleri (sürüş, kırmızı ışık, taksi, bisiklet...)
  services/
    signals.ts                   Supabase RPC + Realtime
    notify.ts                    Yerel bildirimler
  hooks/useNearbySignals.ts      Yakındaki sinyaller (realtime + yedek yoklama)
  screens/MapScreen.tsx          Harita ve tüm akış
  components/                    Harita işaretçisi, alt panel
  lib/                           Supabase istemcisi, mesafe hesapları
supabase/migrations/             Veritabanı şeması, RLS, RPC'ler
```

## Kurulum

### 1. Supabase

1. [supabase.com](https://supabase.com) üzerinde bir proje oluştur.
2. **Authentication → Sign In / Providers → Anonymous sign-ins**'i aç (kullanıcılar kayıt olmadan başlar).
3. Şemayı uygula — SQL Editor'a `supabase/migrations/20261005000000_parking_signals.sql` içeriğini yapıştır ya da CLI ile:
   ```bash
   npx supabase link --project-ref <proje-ref>
   npx supabase db push
   ```
4. `.env.example` dosyasını `.env` olarak kopyala ve URL + anon key'i yaz.

### 2. Harita anahtarı

- **iOS**: Apple Haritalar kullanılır, anahtar gerekmez.
- **Android**: Google Cloud'da *Maps SDK for Android* anahtarı al, `.env` içinde `GOOGLE_MAPS_ANDROID_API_KEY` olarak ver.

### 3. Çalıştırma

Arka plan konum ve hareket sensörü Expo Go'da çalışmaz; **development build** gerekir:

```bash
npm install
npx expo run:android        # ya da: npx expo run:ios   (yerel Android Studio / Xcode ile)
# veya bulutta:
npx eas-cli@latest build --profile development --platform android
```

### Geliştirme komutları

```bash
npm test            # algılama motoru testleri
npm run typecheck
npm run lint
```

## Güvenlik ve gizlilik

- Tabloya doğrudan yazma kapalıdır; tüm yazmalar kontrollü RPC'lerden geçer (`publish_signal`, `claim_signal`, `finish_claim`, `cancel_signal`).
- Kullanıcı başına aynı anda tek canlı sinyal, saatte en fazla 6 sinyal.
- Sinyaller 10 dakika sonra (birazdan çıkacaksa + o süre) kendiliğinden görünmez olur.
- Sunucuya yalnızca **boşalan yerin konumu** gider; sürekli konum takibi cihazda kalır.

## Bilinen sınırlar ve yol haritası

- **Pil**: Otomatik algılama açıkken yüksek doğruluklu konum kullanılır. Sonraki adım: park halindeyken yalnızca geofence + düşük doğruluk, sürüşte yüksek doğruluk.
- **Motor çalışınca anında algılama**: Şu an kalkış hareketle (ilk ~50–100 m) algılanıyor. Araç Bluetooth'una / CarPlay / Android Auto bağlantısına bakan native modül eklenirse sinyal motor çalıştığı anda, araç hareket etmeden gider.
- **Uygulama kapalıyken yer arayanlara bildirim**: Şu an ön planda titreşim + bildirim var. Arka plan için Expo Push + Supabase Edge Function (yeni sinyalde yakındaki "yer arıyorum" kullanıcılarına push) eklenecek.
- **Ölçek**: Realtime değişikliklerde istemci yakın listeyi yeniden çeker. Çok yoğun şehirlerde geohash hücresine göre kanal bölme yapılmalı.
- **Güven puanı**: "Yer doluydu" geri bildirimleri ile sık yanlış sinyal veren kullanıcıların sinyalleri düşük öncelikli gösterilebilir.
