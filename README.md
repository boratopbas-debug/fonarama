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

## Otomatik yenileme (GitHub Actions, ayar gerektirmez)

KAP, Netlify fonksiyonlarının çalıştığı AWS IP'lerinden gelen bağlantıların büyük kısmını düşürüyor
("fetch failed"). Bu yüzden asıl yenileme `.github/workflows/refresh.yml` ile GitHub'da çalışır:
KAP/TEFAS'tan veriyi çeker, `data/seed.json.gz` dosyasına yazar ve repoya kaydeder; Netlify her kayıtta
siteyi kendiliğinden yeniden yükler. Hafta içi 2 saatte bir kendiliğinden çalışır, token/secret gerekmez.

Elle çalıştırmak için: GitHub → Actions → "Verileri yenile" → Run workflow (1–3 dk).
Site, repodaki veri ile Netlify Blobs'taki veriden hangisi daha yeniyse onu gösterir.

## Fon araştırma ekranları

- **Fon → içerik** sayfası artık şunları da gösterir:
  - **Röntgen:** kalem sayısı ve etkin pozisyon (1/HHI), ilk 10 kalem, en büyük kalem, döviz ve altın maruziyeti,
    yerli hisse kısmında BIST 100'e göre **active share** ve BIST 100 dışı hisse payı, ilişkili taraf payı.
  - **Kırmızı bayraklar:** yoğunlaşma (borçlanma araçlarında ihraççı bazında), ilişkili taraf (kurucunun grup
    şirketleri ve grup bankasındaki mevduat), kategori uyumu, endekse yakınlık, likidite, ani değişim, veri kalitesi.
  - **Önceki rapora göre değişim:** yeni girenler, çıkanlar, artanlar, azalanlar ve devir oranı; Excel'e aktarılabilir.
  - **İzlemeye al:** fon bu tarayıcıdaki izleme listesine eklenir.
- **Varlık → fonlar** sayfasında önceki rapora göre o varlığa giren / çıkan / artıran / azaltan fonlar.
- **Karşılaştır:** en fazla 4 fon; içerik çakışması (ortak kalemlerde küçük ağırlıkların toplamı), yan yana özet, kalem kalem tablo.
- **Değişimler ve bayraklar:** tüm fonlarda (ya da izleme listesinde / bir kurucuda) en çok fonun girdiği ve çıktığı
  kalemler, portföyünü en çok değiştiren fonlar ve bayrak taraması; hepsi Excel'e aktarılabilir.

Karşılaştırma aylık raporlayanlarda bir önceki ayla, haftalık raporlayanlarda ~4 hafta öncesiyle yapılır
(fon sayfasında başka bir önceki rapor seçilebilir).

### Geçmiş raporlar

- Her yenilemede, yerine yeni rapor gelen fonun eski satırları Netlify Blobs'taki `gecmis.json.gz`'ye yazılır
  (fon başına en fazla 6 rapor). Sayfa bunu `/api/gecmis`'ten ayrıca yükler.
- `data/gecmis.json.gz`: KAP'tan geriye dönük taranmış önceki raporlar (her fon için önceki 3 rapor). Site ikisini birleştirir.
  Yeniden oluşturmak için: `DB_FILE=<canlı veri .json.gz> node scripts/backfill-gecmis.mjs`

### İlişkili taraf eşlemesi

`public/gruplar.json` kurucu → grup şirketleri eşlemesidir (taslak, düzeltilebilir). Kalem adında aranan ifadeler ve
BIST kodları tanımlanır; kurucunun kendi fonları otomatik bulunur. Yerli hisselerde endeks fonunun (DZE, BIST 100)
ağırlığının üstündeki kısım ayrıca hesaplanır, çünkü endeks fonlarının grup hissesi tutması doğaldır.

## Taranmış raporlar (OCR)

Bazı fonlar portföy raporunu taranmış görüntü PDF olarak yayımlıyor (metin yok). Bunlar Netlify'da okunamaz;
`.github/workflows/ocr.yml` hafta içi her sabah (10:17 İstanbul) GitHub'da çalışır: canlı siteden son raporu
taranmış olan fonları bulur, KAP'tan indirip Tesseract ile (Türkçe) okur ve sonucu `data/ocr.json.gz`'ye yazar.
Repoya kayıt siteyi yeniden yükletir; site OCR sonucunu ilgili fonun raporu hâlâ o taranmış raporsa uygular.
Elle çalıştırmak için: GitHub → Actions → "Taranmış raporlar (OCR)" → Run workflow. İki kez okunamayan rapor tekrar denenmez.

## Fon evreni

TEFAS'ta işlem gören fonlar **ve** TEFAS listesinde olup KAP'ta portföy dağılım raporu yayımlayan fonlar.
İkinci grup, sadece banka şubesinden satılan büyük fonları kapsıyor (TZL, TZV, TI1, GTL, FI5 …).

## Sınırlar

- Nitelikli yatırımcıya özel fonlar ve TEFAS'ta işlem görmeyen serbest fonlar portföy dağılım
  raporu yayımlamak zorunda değil (yayımlayanlar evrene girer). Bu fonlar için sadece TEFAS'ın varlık sınıfı dağılımı
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
