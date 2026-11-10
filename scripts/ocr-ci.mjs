// Taranmış raporlar için OCR (GitHub Actions'ta çalışır, bkz. .github/workflows/ocr.yml).
// Canlı siteden veriyi okur, son raporu taranmış PDF olan fonları bulur, KAP'tan indirip OCR ile okur,
// sonucu data/ocr.json.gz'ye yazar. Site bu dosyayı yüklerken uygular (lib/store.mjs → applyOcr).
// Yerelde: node scripts/ocr-ci.mjs   (tesseract-ocr, tesseract-ocr-tur, poppler-utils gerekir)
import fs from "fs"; import zlib from "zlib";
import { ocrParse } from "../lib/ocr.mjs";
import { quality } from "../lib/parse.mjs";
import { ocrHedef } from "../lib/store.mjs";

const SITE = process.env.SITE_URL || "https://fonara.netlify.app";
const OUT = process.env.OCR_FILE || "data/ocr.json.gz";
const KAP = "https://www.kap.org.tr", UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function get(url, json) {
  let last;
  for (let i = 0; i < 4; i++) {
    try { const r = await fetch(url, { headers: { "User-Agent": UA, Accept: json ? "application/json" : "*/*" }, signal: AbortSignal.timeout(90000) }); if (r.ok) return json ? r.json() : Buffer.from(await r.arrayBuffer()); last = new Error("HTTP " + r.status); }
    catch (e) { last = e; }
    await sleep(2500 * (i + 1));
  }
  throw last;
}

const db = JSON.parse(zlib.gunzipSync(Buffer.from(await (await fetch(`${SITE}/api/data`, { signal: AbortSignal.timeout(120000) })).arrayBuffer())));
let ov = { fonlar: {}, denenen: {} };
try { ov = { fonlar: {}, denenen: {}, ...JSON.parse(zlib.gunzipSync(fs.readFileSync(OUT))) }; } catch {}

const hedef = [];
for (const [fon, f] of Object.entries(db.fonlar)) {
  const idx = ocrHedef(f.rapor); if (!idx) continue;
  if (ov.fonlar[fon]?.idx === idx || (ov.denenen[idx]?.n || 0) >= 2) continue;
  const rp = f.rapor, st = rp.sonTaranmis || rp;
  hedef.push({ fon, idx, yayin: st.yayin, donem: st.donem });
}
console.log(`OCR bekleyen rapor: ${hedef.length}`);

let ok = 0;
for (const h of hedef) {
  try {
    const det = await get(`${KAP}/tr/api/notification/attachment-detail/${h.idx}`, true);
    const atts = (det?.[0]?.attachments || []).filter(a => /^pdf$/i.test(a.fileExtension)).slice(0, 3);
    let best = null;
    for (const a of atts) {
      const buf = await get(`${KAP}/tr/api/file/download/${a.objId}`);
      if (buf.subarray(0, 600).indexOf("%PDF") < 0) continue;
      const r = ocrParse(buf);
      if (r && (!best || Math.abs(100 - r.toplamOran) < Math.abs(100 - best.r.toplamOran))) best = { r, a };
    }
    if (!best) { ov.denenen[h.idx] = { n: (ov.denenen[h.idx]?.n || 0) + 1, tarih: new Date().toISOString().slice(0, 10) }; console.log(`${h.fon}: okunamadı`); continue; }
    const q = quality(best.r.holdings);
    ov.fonlar[h.fon] = { idx: h.idx, yayin: h.yayin, donem: h.donem, dosya: best.a.fileName, objId: best.a.objId, kalite: q.kalite, toplamOran: q.toplamOran,
      rows: best.r.holdings.map(x => [x.isin, x.kod, x.ad, x.tur, Math.round(x.oran * 1e4) / 1e4, x.deger == null ? null : Math.round(x.deger * 100) / 100]) };
    ok++; console.log(`${h.fon}: %${q.toplamOran} (${q.kalite}), ${best.r.holdings.length} kalem`);
  } catch (e) { console.log(`${h.fon}: hata ${e.message}`); }
  await sleep(500);
}
// artık geçerli olmayan kayıtlar: fonun daha yeni, taranmamış raporu gelmiş
for (const [fon, e] of Object.entries(ov.fonlar)) { const rp = db.fonlar[fon]?.rapor; if (!rp || (ocrHedef(rp) !== e.idx && rp.idx !== e.idx)) delete ov.fonlar[fon]; }
ov.guncelleme = new Date().toISOString();
fs.writeFileSync(OUT, zlib.gzipSync(JSON.stringify(ov)));
console.log(`Bitti: ${ok}/${hedef.length} rapor OCR ile okundu, dosyada ${Object.keys(ov.fonlar).length} fon`);
