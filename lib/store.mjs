import { getStore } from "@netlify/blobs";
import fs from "fs"; import path from "path"; import zlib from "zlib";

// Netlify içinde kimlik bilgisi otomatik gelir; GitHub Actions'ta NETLIFY_SITE_ID + NETLIFY_AUTH_TOKEN ile bağlanır
const disErisim = process.env.NETLIFY_SITE_ID && process.env.NETLIFY_AUTH_TOKEN
  ? { siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_AUTH_TOKEN } : {};
export const store = () => getStore({ name: "fon-icerik", consistency: "strong", ...disErisim });

export function readSeed() {
  const cands = [path.join(process.cwd(), "data/seed.json.gz"), path.join(process.env.LAMBDA_TASK_ROOT || "/var/task", "data/seed.json.gz")];
  for (const c of cands) { try { return JSON.parse(zlib.gunzipSync(fs.readFileSync(c)).toString("utf8")); } catch {} }
  return null;
}
// Blobs'taki veritabanı, gömülü seed'den eski bir parser sürümüyle oluşturulmuşsa seed'i kullan
let seedCache;
const seed = () => (seedCache === undefined ? (seedCache = readSeed()) : seedCache);
function pickNewer(blobDb) {
  const sd = seed();
  if (!blobDb) return sd;
  if (sd && (sd.parserVersion || 0) > (blobDb.parserVersion || 0)) return sd;
  // GitHub'daki otomatik yenileme veriyi repoya (seed) yazıyor: hangisi daha yeniyse o
  if (sd && (sd.guncelleme || "") > (blobDb.guncelleme || "")) return sd;
  return blobDb;
}

// ---------- OCR sonuçları (GitHub Actions'ta üretilir: data/ocr.json.gz) ----------
// Fonun gösterilmesi gereken raporu taranmış PDF ise bu raporun idx'i, değilse null
export const ocrHedef = rp => !rp ? null : rp.sonTaranmis?.idx || (rp.status === "taranmis" ? rp.idx : null);
let ocrCache;
function readOcr() {
  if (ocrCache !== undefined) return ocrCache;
  const cands = [path.join(process.cwd(), "data/ocr.json.gz"), path.join(process.env.LAMBDA_TASK_ROOT || "/var/task", "data/ocr.json.gz")];
  for (const c of cands) { try { return (ocrCache = JSON.parse(zlib.gunzipSync(fs.readFileSync(c)).toString("utf8"))); } catch {} }
  return (ocrCache = null);
}
// Taranmış raporu OCR ile okunmuş fonlara OCR satırlarını yerleştir. Değişiklik olduysa true döner.
export function applyOcr(db, ov = readOcr()) {
  if (!db || !ov?.fonlar) return false;
  let n = 0;
  for (const [fon, e] of Object.entries(ov.fonlar)) {
    const f = db.fonlar?.[fon]; if (!f?.rapor || ocrHedef(f.rapor) !== e.idx || !e.rows?.length) continue;
    f.rapor = { idx: e.idx, yayin: e.yayin, donem: e.donem, dosya: e.dosya || "", objId: e.objId || "", status: "ok", kalite: e.kalite, toplamOran: e.toplamOran, pv: f.rapor.pv, ocr: true };
    db.satirlar[fon] = e.rows; n++;
  }
  return n > 0;
}

export async function loadDb() {
  const buf = await store().get("db.json.gz", { type: "arrayBuffer" });
  const db = pickNewer(buf ? JSON.parse(zlib.gunzipSync(Buffer.from(buf)).toString("utf8")) : null);
  applyOcr(db);
  return db;
}
export async function loadDbGz() {
  const buf = await store().get("db.json.gz", { type: "arrayBuffer" });
  if (buf) {
    const gz = Buffer.from(buf);
    const bdb = JSON.parse(zlib.gunzipSync(gz).toString("utf8"));
    if (pickNewer(bdb) === bdb) return applyOcr(bdb) ? zlib.gzipSync(JSON.stringify(bdb)) : gz;
  }
  const sd = seed();
  if (sd) applyOcr(sd);
  return sd ? zlib.gzipSync(JSON.stringify(sd)) : null;
}
export async function saveDb(db) { const gz = zlib.gzipSync(JSON.stringify(db)); await store().set("db.json.gz", gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.byteLength)); }
export async function getStatus() { return (await store().get("status.json", { type: "json" })) || { durum: "bos" }; }
export async function setStatus(st) { await store().setJSON("status.json", { ...st, zaman: new Date().toISOString() }); }

// ---------- geçmiş raporlar (aydan aya fark) ----------
import { mergeAll, pruneCurrent } from "./gecmis.mjs";
function readGecmisSeed() {
  const cands = [path.join(process.cwd(), "data/gecmis.json.gz"), path.join(process.env.LAMBDA_TASK_ROOT || "/var/task", "data/gecmis.json.gz")];
  for (const c of cands) { try { return JSON.parse(zlib.gunzipSync(fs.readFileSync(c)).toString("utf8")); } catch {} }
  return null;
}
// Blobs'taki geçmiş + repodaki geriye dönük taranmış geçmiş, birleştirilmiş
export async function loadGecmis(db) {
  let blob = null;
  try { const buf = await store().get("gecmis.json.gz", { type: "arrayBuffer" }); if (buf) blob = JSON.parse(zlib.gunzipSync(Buffer.from(buf)).toString("utf8")); } catch {}
  const g = mergeAll(blob, readGecmisSeed());
  return db ? pruneCurrent(g, db) : g;
}
export async function saveGecmis(g) { const gz = zlib.gzipSync(JSON.stringify({ ...g, guncelleme: new Date().toISOString() })); await store().set("gecmis.json.gz", gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.byteLength)); }
