// GitHub Actions'ta çalışan yenileme. Netlify fonksiyonları AWS'de çalıştığı için KAP bağlantıların
// yarısını düşürüyor; burada süre sınırı da yok, tüm kuyruk tek seferde biter.
// Gerekli ortam değişkenleri: NETLIFY_SITE_ID, NETLIFY_AUTH_TOKEN (GitHub repo secrets).
// Yerelde denemek için: DRY_RUN=1 DB_FILE=db.json.gz node scripts/refresh-ci.mjs
import fs from "fs"; import zlib from "zlib";
import { refresh } from "../lib/pipeline.mjs";

const DRY = !!process.env.DRY_RUN;
const S = DRY ? null : await import("../lib/store.mjs");
const loadDb = async () => DRY ? (process.env.DB_FILE ? JSON.parse(zlib.gunzipSync(fs.readFileSync(process.env.DB_FILE))) : null) : S.loadDb();
const saveDb = async db => DRY ? fs.writeFileSync(process.env.OUT_FILE || "db.out.json.gz", zlib.gzipSync(JSON.stringify(db))) : S.saveDb(db);
const setStatus = async st => DRY ? console.log("[durum]", st.mesaj) : S.setStatus({ ...st, kaynak: "github" });

if (!DRY && !(process.env.NETLIFY_SITE_ID && process.env.NETLIFY_AUTH_TOKEN)) {
  console.error("NETLIFY_SITE_ID ve NETLIFY_AUTH_TOKEN secret'ları tanımlı değil (README'deki kurulum adımına bak).");
  process.exit(1);
}

const baslangic = new Date().toISOString();
await setStatus({ durum: "calisiyor", baslangic, tur: 1, toplamYeni: 0, mesaj: "KAP ve TEFAS kontrol ediliyor" });
try {
  const db = await loadDb();
  const { db: out, stats } = await refresh(db, {
    concurrency: +(process.env.CONCURRENCY || 6), deadlineMs: 5 * 3600e3,
    log: m => console.log(m),
    onProgress: async (p, d) => {
      await setStatus({ durum: "calisiyor", baslangic, tur: 1, toplamYeni: p.done, mesaj: `Raporlar işleniyor: ${p.done}/${p.total}`, ...p });
      if (p.done % 150 === 0) await saveDb(d); // ara kayıt
    }
  });
  await saveDb(out);
  const mesaj = stats.kalan ? `${stats.yeni} rapor işlendi, ${stats.kalan} rapor kaldı. Kalanlar için tekrar yenile.`
    : stats.basarisizGunler?.length ? `${stats.yeni} yeni rapor işlendi. KAP ${stats.basarisizGunler.length} gün için yanıt vermedi, sonraki yenilemede tekrar denenecek.`
    : stats.yeni ? `${stats.yeni} yeni rapor işlendi` : "Yeni rapor yok, veriler güncel";
  await setStatus({ durum: "bitti", baslangic, bitis: new Date().toISOString(), ...stats, toplamYeni: stats.yeni, mesaj });
  console.log(mesaj, stats);
} catch (e) {
  console.error(e);
  await setStatus({ durum: "hata", baslangic, mesaj: String(e.message || e).slice(0, 300) });
  process.exit(1);
}
