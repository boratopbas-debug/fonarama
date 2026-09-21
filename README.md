# Hangi fonda ne var?

TEFAS'taki yatırım fonlarının KAP'taki en güncel **Portföy Dağılım Raporu**'nu okuyup
ISIN / hisse kodu → fon → ağırlık araması yapan site.

## Kurulum (Netlify CLI)

Gerekenler: Node.js 18+ (https://nodejs.org) ve bir Netlify hesabı.

```bash
cd fon-icerik-arama
npm install
npx netlify-cli login          # tarayıcıda Netlify hesabınla giriş
npx netlify-cli init           # "Create & configure a new site" seç, build komutu boş, publish: public
npx netlify-cli deploy --prod  # yükler ve adresi verir
```

Sonraki güncellemelerde (kodu değiştirirsen) sadece `npx netlify-cli deploy --prod`.

## Nasıl çalışır

- `data/seed.json.gz` — ilk veritabanı (hazır geliyor). Site ilk açıldığında bunu gösterir.
- **Verileri yenile** butonu `/.netlify/functions/refresh-background` fonksiyonunu tetikler:
  TEFAS fon listesini çeker, son kontrolden bu yana KAP'a düşen yeni portföy dağılım
  raporlarını bulur, eklerini (PDF/Excel) indirip okur, veritabanını Netlify Blobs'a yazar.
  Arka plan fonksiyonu olduğu için 15 dakikaya kadar çalışabilir; ilerleme ekranda görünür.
- Hafta içi 09:00–21:00 arası (İstanbul) 2 saatte bir otomatik yenileme çalışır (`daily.mjs`),
  böylece butona bastığında genelde işlenecek az rapor kalır.
- Ayın ilk günlerinde (yüzlerce fon aynı anda rapor atar) tek yenilemede bitmezse
  ekranda "x rapor kaldı" yazar; tekrar **Verileri yenile**'ye basmak yeter.

## Yenileme ne kadar sürer?

- Yeni rapor yoksa: ~5 saniye.
- Normal bir gün (onlarca rapor): 10–60 saniye.
- Ayın ilk iş günleri / hafta başı (yüzlerce rapor): birkaç dakika; 12 dakikayı aşarsa
  fonksiyon kendini otomatik devam ettirir.
- KAP'ın hata verdiği raporlar işçiyi bekletmez; turun sonunda ikinci geçişte denenir,
  yine olmazsa sonraki yenilemelerde (en fazla 6 kez) otomatik tekrar denenir.

**Hızlandırma:** Netlify fonksiyonları varsayılan olarak ABD'de çalışır. Planın izin veriyorsa
Site configuration → Functions → Region ayarından Frankfurt (eu-central-1) seç; KAP'a
her istek belirgin şekilde hızlanır.

## Sınırlar

- Nitelikli yatırımcıya özel fonlar ve TEFAS'ta işlem görmeyen serbest fonlar portföy dağılım
  raporu yayımlamak zorunda değil. Bu fonlar için sadece TEFAS'ın varlık sınıfı dağılımı
  (hisse %, tahvil %, mevduat % …) gösterilir; hangi hisseyi tuttukları kamuya açık değil.
- Taranmış görüntü (metinsiz) PDF raporlar okunamaz; sayfanın altındaki listede görünür.
- Parser güncellenirse (`PARSER_VERSION`), bir sonraki yenileme eski sürümle okunmuş raporları
  kendiliğinden yeniden işler.
- Parser satır/sütun düzenine göre çalışır; formatı çok farklı raporlar kısmi okunabilir.
  Her fonun "okuma kalitesi" (okunan ağırlıkların toplamı) Excel'deki Fonlar sayfasında var.
- Kaynak KAP/TEFAS'ın herkese açık web API'leri; resmi dokümante API değil, değişirse
  `lib/pipeline.mjs` güncellenmeli.

## Sıfırdan veritabanı (opsiyonel)

```bash
npm run build-seed   # son 120 günün raporlarını baştan tarar (~15 dk) → data/seed.json.gz
```
