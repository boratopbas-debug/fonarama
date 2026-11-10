// Taranmış (metinsiz) PDF raporlar için OCR: pdftoppm → tesseract (tur+eng) TSV → satır/token → parseOcrRows
// Gerekenler: poppler-utils (pdftoppm), tesseract-ocr + tesseract-ocr-tur. Netlify'da yok; GitHub Actions'ta çalışır.
import fs from "fs"; import os from "os"; import path from "path"; import { execFileSync } from "child_process";
import { stripKapHeader, normText, parseOcrRows } from "./parse.mjs";

export function ocrPdfRows(buf, { dpi = 300, psm = 6, maxPages = 8 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-"));
  try {
    fs.writeFileSync(path.join(dir, "a.pdf"), stripKapHeader(buf, "pdf"));
    execFileSync("pdftoppm", ["-r", String(dpi), "-gray", "-l", String(maxPages), "-png", path.join(dir, "a.pdf"), path.join(dir, "p")]);
    const pages = fs.readdirSync(dir).filter(f => /^p.*\.png$/.test(f)).sort();
    const rows = [];
    for (const pg of pages) {
      const tsv = execFileSync("tesseract", [path.join(dir, pg), "stdout", "-l", "tur+eng", "--psm", String(psm), "tsv"], { maxBuffer: 64e6, stdio: ["ignore", "pipe", "ignore"] }).toString();
      const L = new Map();
      for (const line of tsv.split("\n").slice(1)) {
        const c = line.split("\t"); if (c.length < 12 || c[0] !== "5") continue;
        const s = normText(c[11]).trim(); if (!s || +c[10] < 20) continue; // düşük güvenli kelimeleri at
        const k = `${c[2]}-${c[3]}-${c[4]}`, left = +c[6], w = +c[8], top = +c[7];
        (L.get(k) || L.set(k, { top, t: [] }).get(k)).t.push({ s, x0: left, x1: left + w, x: left + w / 2 });
      }
      // aynı yükseklikteki satır parçalarını (tesseract'ın ayırdığı bloklar) birleştir
      const merged = [];
      for (const l of [...L.values()].sort((a, b) => a.top - b.top)) { const p = merged[merged.length - 1]; if (p && Math.abs(p.top - l.top) < 12) p.t.push(...l.t); else merged.push({ top: l.top, t: [...l.t] }); }
      for (const l of merged) rows.push({ tokens: l.t.sort((a, b) => a.x0 - b.x0) });
      rows.push({ tokens: [], pageBreak: true });
    }
    return rows;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// İki sayfa düzeni ayarıyla dener, toplamı %100'e en yakın kabul edilebilir sonucu döndürür (yoksa null)
export function ocrParse(buf) {
  let best = null;
  for (const psm of [6, 4]) {
    const r = parseOcrRows(ocrPdfRows(buf, { psm }));
    if (r.ok && (!best || Math.abs(100 - r.toplamOran) < Math.abs(100 - best.toplamOran))) best = { ...r, psm };
    if (best && Math.abs(100 - best.toplamOran) < 3) break;
  }
  return best;
}
