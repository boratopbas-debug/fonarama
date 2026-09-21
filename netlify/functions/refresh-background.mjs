// Arka plan fonksiyonu (15 dk'ya kadar çalışır). Butonla ya da günlük zamanlayıcıyla tetiklenir.
// İş bitmezse kendini yeniden başlatır (en fazla MAX_TUR tur).
import { loadDb, saveDb, getStatus, setStatus } from "../../lib/store.mjs";
import { refresh } from "../../lib/pipeline.mjs";
const MAX_TUR = 8;

export default async (req) => {
  const url = new URL(req.url);
  const tur = +(url.searchParams.get("tur") || 1);
  const st = await getStatus();
  // aynı anda iki çalışma olmasın (zincirin kendi devamı hariç)
  if (tur === 1 && st.durum === "calisiyor" && Date.now() - new Date(st.zaman).getTime() < 3 * 60e3) return;
  const baslangic = tur === 1 ? new Date().toISOString() : (st.baslangic || new Date().toISOString());
  const oncekiYeni = tur === 1 ? 0 : (st.toplamYeni || 0);
  const log = [];
  await setStatus({ durum: "calisiyor", baslangic, tur, toplamYeni: oncekiYeni, mesaj: tur === 1 ? "KAP ve TEFAS kontrol ediliyor" : `Devam ediliyor (tur ${tur})` });
  try {
    const db = await loadDb();
    const { db: out, stats } = await refresh(db, {
      concurrency: 6, deadlineMs: 12 * 60e3,
      log: m => { log.push(m); if (log.length > 40) log.shift(); },
      onProgress: async (p, d) => {
        await setStatus({ durum: "calisiyor", baslangic, tur, toplamYeni: oncekiYeni + p.done, mesaj: `Raporlar işleniyor: ${p.done}/${p.total}${tur > 1 ? ` (tur ${tur})` : ""}`, ...p });
        if (p.done % 150 === 0) await saveDb(d); // ara kayıt
      }
    });
    await saveDb(out);
    const toplamYeni = oncekiYeni + stats.yeni;
    if (stats.kalan > 0 && tur < MAX_TUR) {
      await setStatus({ durum: "calisiyor", baslangic, tur: tur + 1, toplamYeni, mesaj: `${toplamYeni} rapor işlendi, ${stats.kalan} kaldı, devam ediliyor` });
      await fetch(`${url.origin}${url.pathname}?tur=${tur + 1}`, { method: "POST" }).catch(() => {});
      return;
    }
    const mesaj = stats.kalan ? `${toplamYeni} rapor işlendi, ${stats.kalan} rapor kaldı. Kalanlar için tekrar yenile.`
      : stats.basarisizGunler?.length ? `${toplamYeni} yeni rapor işlendi. KAP ${stats.basarisizGunler.length} gün için yanıt vermedi, sonraki yenilemede tekrar denenecek.`
      : toplamYeni ? `${toplamYeni} yeni rapor işlendi` : "Yeni rapor yok, veriler güncel";
    await setStatus({ durum: "bitti", baslangic, bitis: new Date().toISOString(), ...stats, toplamYeni, mesaj });
  } catch (e) {
    await setStatus({ durum: "hata", baslangic, mesaj: String(e.message || e).slice(0, 300), log });
  }
};
