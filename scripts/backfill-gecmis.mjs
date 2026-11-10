// Geçmiş portföy dağılım raporlarını KAP'tan geriye dönük çeker → data/gecmis.json.gz
// Her fon için şu anki raporundan önceki en fazla 3 raporu okur:
//   aylık raporlayanlar: önceki 3 ay; haftalık raporlayanlar: bir önceki hafta + ~4 ve ~8 hafta öncesi.
// Kullanım: DB_FILE=canli.json.gz node scripts/backfill-gecmis.mjs   (DB_FILE yoksa data/seed.json.gz)
import fs from "fs"; import zlib from "zlib";
import { fetchKapReports, fetchAndParse } from "../lib/pipeline.mjs";
import { snapshotFromRows, mergeGecmis, GECMIS_MAX } from "../lib/gecmis.mjs";

const DB_FILE = process.env.DB_FILE || "data/seed.json.gz";
const OUT = process.env.OUT_FILE || "data/gecmis.json.gz";
const GUN = +(process.env.LOOKBACK || 110);
const CONC = +(process.env.CONCURRENCY || 8);
const db = JSON.parse(zlib.gunzipSync(fs.readFileSync(DB_FILE)));
let gecmis = {};
try { gecmis = JSON.parse(zlib.gunzipSync(fs.readFileSync(OUT))).fonlar || {}; } catch {}

const today = new Date(), ymd = d => d.toISOString().slice(0, 10);
const reps = await fetchKapReports(ymd(new Date(today - GUN * 864e5)), ymd(today), m => process.stdout.write("."));
console.log(`\nKAP: ${reps.length} bildirim`);
const byFund = {};
for (const r of reps) (byFund[r.fon] ||= []).push({ ...r, donem: `${r.yil} ${r.donem || ""}`.trim() });

const todo = [];
for (const [fon, f] of Object.entries(db.fonlar)) {
  const rp = f.rapor; if (!rp || !db.satirlar[fon]?.length) continue;
  // ekrandaki verinin geldiği rapor (yeni rapor okunamadıysa eskiVeri)
  const base = rp.eskiVeri?.idx ? rp.eskiVeri : rp;
  const have = new Set((gecmis[fon] || []).map(s => s.idx));
  // aynı dönemin düzeltmelerinden en sonuncusu
  const per = {};
  for (const r of byFund[fon] || []) if (r.yayin < base.yayin && r.donem !== base.donem && r.idx !== base.idx && (!per[r.donem] || r.yayin > per[r.donem].yayin)) per[r.donem] = r;
  const prev = Object.values(per).sort((a, b) => b.yayin.localeCompare(a.yayin));
  let pick;
  if (/Hafta/.test(base.donem)) {
    const t0 = new Date(base.yayin).getTime();
    const near = d => prev.reduce((b, r) => { const x = Math.abs(t0 - new Date(r.yayin).getTime() - d * 864e5); return !b || x < b.x ? { r, x } : b; }, null)?.r;
    pick = [prev[0], near(28), near(56)];
  } else pick = prev.slice(0, 3);
  const seen = new Set();
  for (const r of pick) if (r && !seen.has(r.idx) && !have.has(r.idx)) { seen.add(r.idx); todo.push({ ...r, fon }); }
}
console.log(`Okunacak rapor: ${todo.length}`);

let i = 0, done = 0, hata = 0;
const save = () => fs.writeFileSync(OUT, zlib.gzipSync(JSON.stringify({ olusturma: new Date().toISOString(), fonlar: gecmis })));
const work = async () => {
  while (i < todo.length) {
    const rep = todo[i++];
    let r;
    try { r = await fetchAndParse(rep, true); if (r.status === "hata") r = await fetchAndParse(rep, false); } catch (e) { r = { status: "hata", holdings: [] }; }
    if (r.holdings?.length) {
      const rows = r.holdings.map(h => [h.isin, h.kod, h.ad, h.tur, Math.round(h.oran * 1e4) / 1e4, h.deger == null ? null : Math.round(h.deger * 100) / 100]);
      gecmis[rep.fon] = mergeGecmis(gecmis[rep.fon], [snapshotFromRows({ idx: rep.idx, yayin: rep.yayin, donem: rep.donem, kalite: r.kalite, toplamOran: r.toplamOran }, rows)]);
    } else hata++;
    if (++done % 100 === 0) { console.log(`${done}/${todo.length} (okunamayan ${hata})`); save(); }
  }
};
await Promise.all(Array.from({ length: CONC }, work));
save();
console.log(`Bitti: ${done} rapor, okunamayan ${hata}. Fon sayısı ${Object.keys(gecmis).length}, en fazla ${GECMIS_MAX} rapor/fon`);
