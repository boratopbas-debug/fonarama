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
export async function loadDb() {
  const buf = await store().get("db.json.gz", { type: "arrayBuffer" });
  return pickNewer(buf ? JSON.parse(zlib.gunzipSync(Buffer.from(buf)).toString("utf8")) : null);
}
export async function loadDbGz() {
  const buf = await store().get("db.json.gz", { type: "arrayBuffer" });
  if (buf) {
    const gz = Buffer.from(buf);
    const bdb = JSON.parse(zlib.gunzipSync(gz).toString("utf8"));
    if (pickNewer(bdb) === bdb) return gz;
  }
  const sd = seed();
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
