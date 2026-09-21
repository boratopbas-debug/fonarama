// Portföy dağılım raporu ayrıştırıcı (PDF ve Excel) — sütun konumuna dayalı.
// Çıktı: [{isin, kod, ad, tur, oran, deger}]  oran = fon toplam değerine göre %
import * as XLSX from "xlsx";

let pdfjsPromise = null;
const pdfjs = () => (pdfjsPromise ||= (async () => {
  // Node'da worker'ı ana iş parçacığına yükle (globalThis.pdfjsWorker); paketleyicinin dosyayı dahil etmesini de sağlar
  await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
  return import("pdfjs-dist/legacy/build/pdf.mjs");
})());

export function stripKapHeader(buf, ext) {
  const b = Buffer.from(buf);
  const sigs = { pdf: [Buffer.from("%PDF")], xlsx: [Buffer.from([0x50, 0x4b, 0x03, 0x04])], xls: [Buffer.from([0xd0, 0xcf, 0x11, 0xe0])] };
  for (const sig of sigs[ext] || []) { const i = b.indexOf(sig); if (i > 0 && i < 600) return b.subarray(i); }
  return b;
}

const FIX = { "Ġ": "İ", "ġ": "ş", "Ģ": "Ş", "Ý": "İ", "ý": "ı", "Þ": "Ş", "þ": "ş", "Ð": "Ğ", "ð": "ğ" };
export const normText = s => String(s ?? "").replace(/[ĠġĢÝýÞþÐð]/g, c => FIX[c]).replace(/([A-Za-zÇĞİÖŞÜçğıöşü])>/g, "$1ı").replace(/([A-Za-zÇĞİÖŞÜçğıöşü])[=<](?=\s|$|:)/g, "$1ı");
export const fold = s => normText(s).toLocaleUpperCase("tr").replace(/[İI]/g, "I").replace(/Ş/g, "S").replace(/Ğ/g, "G").replace(/Ü/g, "U").replace(/Ö/g, "O").replace(/Ç/g, "C");

// satır = {tokens:[{s,x}]}  (x = token merkezinin yatay konumu)
export async function pdfToRows(buf) {
  const { getDocument } = await pdfjs();
  const doc = await getDocument({ data: new Uint8Array(buf), disableFontFace: true, useSystemFonts: false, isEvalSupported: false, verbosity: 0 }).promise;
  const rows = [];
  const maxPages = Math.min(doc.numPages, 60);
  let chars = 0, started = false;
  for (let p = 1; p <= maxPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const items = [];
    for (const it of tc.items) {
      if (!it.str || !it.str.trim()) continue;
      const x = it.transform[4], y = it.transform[5], w = it.width, h = Math.abs(it.transform[3]) || it.height || 6;
      const s = normText(it.str);
      chars += s.trim().length;
      // öğeyi boşluklardan tokenlara böl, x'i orantılı dağıt
      const cw = s.length ? w / s.length : h * 0.5;
      let re = /\S+(?: \S+)*/g, m;
      // çoklu boşlukla ayrılmış parçalar ayrı hücre; tek boşluklu kelimeler ayrı token
      for (const part of s.matchAll(/\S+/g)) {
        items.push({ s: part[0], x0: x + part.index * cw, x1: x + (part.index + part[0].length) * cw, y, h });
      }
    }
    items.sort((a, b) => b.y - a.y || a.x0 - b.x0);
    const pr = [];
    for (const it of items) {
      const r = pr.find(r => Math.abs(r.y - it.y) <= Math.max(1.5, it.h * 0.35));
      if (r) r.t.push(it); else pr.push({ y: it.y, t: [it] });
    }
    pr.sort((a, b) => b.y - a.y);
    for (const r of pr) {
      r.t.sort((a, b) => a.x0 - b.x0);
      // yakın kelimeleri birleştir (tek hücre metni) ama sayıları ayrı tut
      rows.push({ tokens: r.t.map(t => ({ s: t.s, x: (t.x0 + t.x1) / 2, x0: t.x0, x1: t.x1 })), page: p });
    }
    rows.push({ tokens: [], page: p, pageBreak: true });
    page.cleanup();
    // portföy tablosu bittiyse kalan sayfaları (alım-satım listeleri) okuma
    const pt0 = pr.map(r => fold(r.t.map(t => t.s).join(" ")));
    const pageText = pt0.map((l, i) => (l + " " + (pt0[i + 1] || "")).replace(/[:;]/g, " ").replace(/\s+/g, " "));
    if (pageText.some(l => START_F.test(l))) started = true;
    if ((started || p >= 3) && pageText.some(l => STOP_F.test(l))) break;
  }
  const numPages = doc.numPages, pagesRead = rows.filter(r => r.pageBreak).length;
  await doc.destroy();
  return { rows, chars, numPages, pagesRead };
}

const ISIN_RE = /^[A-Z]{2}[A-Z0-9]{9}\d$/;
// ISIN kontrol hanesi (Luhn) doğrulaması
function isinCheck(s) {
  const digits = s.slice(0, 11).split("").map(c => /\d/.test(c) ? c : String(c.charCodeAt(0) - 55)).join("");
  let sum = 0, dbl = true;
  for (let i = digits.length - 1; i >= 0; i--) { let d = +digits[i]; if (dbl) { d *= 2; if (d > 9) d -= 9; } sum += d; dbl = !dbl; }
  return (10 - (sum % 10)) % 10 === +s[11];
}
const isIsin = s => ISIN_RE.test(s) && /\d/.test(s.slice(2, 11)) && isinCheck(s);
const NUM_TOK = /^[-(]?\d[\d.,]*%?\)?$/;
const DATE_TOK = /^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}$/;

function detectLocale(rows) {
  let tr = 0, us = 0;
  for (const r of rows) for (const t of r.tokens) {
    if (/^\d{1,3}(\.\d{3})+,\d+$/.test(t.s)) tr++;
    else if (/^\d{1,3}(,\d{3})+\.\d+$/.test(t.s)) us++;
    else if (/^\d+,\d{1,6}$/.test(t.s)) tr += 0.3;
    else if (/^\d+\.\d{1,2}$/.test(t.s)) us += 0.3;
  }
  return us > tr ? "us" : "tr";
}
function toNum(tok, loc) {
  let s = tok.replace(/[%()]/g, "");
  const neg = /^-/.test(s) || /^\(/.test(tok);
  s = s.replace(/^-/, "");
  if (!/\d/.test(s)) return null;
  const hasC = s.includes(","), hasD = s.includes(".");
  if (hasC && hasD) s = s.lastIndexOf(",") > s.lastIndexOf(".") ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  else if (hasC) s = (s.match(/,/g).length > 1 || (loc === "us" && /,\d{3}$/.test(s))) ? s.replace(/,/g, "") : s.replace(",", ".");
  else if (hasD) s = (s.match(/\./g).length > 1 || (loc === "tr" && /^\d{1,3}\.\d{3}$/.test(s))) ? s.replace(/\./g, "") : s;
  const n = parseFloat(s);
  return isNaN(n) ? null : (neg ? -n : n);
}

const SECTION_F = /(HISSE|TAHVIL|BONO|BORCLANMA|KIRA SERT|REPO|MEVDUAT|KATILMA|FON SEPET|YATIRIM FON|Y\.FONU|BORSA YATIRIM|VIOP|VOB|OPSIYON|VARANT|EUROBOND|YABANCI|ALTIN|KIYMETLI MADEN|TPP|BPP|TEMINAT|DIGER|FINANSMAN|VARLIGA DAYALI|GELIR ORTAKLI|MENKUL KIYMET|OZEL SEKTOR|DEVLET|HAZINE|TUREV|VADELI|SWAP|FORWARD|EMTIA|KATILIM HESAB|SERTIFIKA)/;
const START_F = /PORTFOY DEGERI TABLOSU|PORTFOY DAGILIM TABLOSU|PORTFOY DEGER TABLOSU/;
const STOP_F = /TOPLAM DEGERI TABLOSU|YAPILAN GIDERLER|PORTFOYDEN SATIS|PORTFOYE ALIS|NET VARLIK DEGERI TABLOSU|RUCHAN HAKKI|FON TOPLAM DEGER TABLOSU/;
const TOTAL_F = /^((ANA |ARA |ALT )?GRUP TOPLAM|GENEL TOPLAM|GRUP TOPLAMI|TOPLAM|GENEL TOPLAM|ARA TOPLAM|FON TOPLAM|PORTFOY TOPLAM|TOTAL|FON PORTFOY DEGERI|PORTFOY DEGERI|NET VARLIK|FON TOPLAM DEGERI)\b|\bTOPLAMI?\s*:?\s*$|^[A-Z ]+ TOPLAMI\b/;
const MONTH_F = /^(OCAK|SUBAT|MART|NISAN|MAYIS|HAZIRAN|TEMMUZ|AGUSTOS|EYLUL|EKIM|KASIM|ARALIK)[- ]?\d{4}$/;

// başlık satırından ağırlık ve değer sütunlarının x'ini çıkar
function headerCols(tokens) {
  const F = tokens.map(t => fold(t.s));
  const joined = F.join(" ");
  let wx = null, wScore = 0, vx = null; const pcts = [];
  for (let i = 0; i < tokens.length; i++) {
    const f = F[i], nxt = F[i + 1] || "", prev = F[i - 1] || "";
    if (/^GRUP\s?%?$|^GRUP\(%\)$/.test(f) && (/%/.test(f) || /%/.test(nxt))) pcts.push(tokens[i].x);
    let sc = 0;
    if (/^\(?FTD/.test(f) || /^TOPLAM\s?%$/.test(f) || (f === "TOPLAM" && /^\(?%\)?$/.test(nxt)) || /^FON\s?%$/.test(f)) sc = 5;
    else if (/^\(?FPD/.test(f)) sc = 2;
    else if (/^(FAIZ|ISKT\.?|ISKONTO|IC|NOM\.?|NOMINAL|KUPON|GETIRI|FIYAT)$/.test(prev) && /^ORANI?/.test(f)) sc = 0;
    else if (f === "ORAN" && /\(%\)|%/.test(nxt)) sc = 4;
    else if (/^ORAN(\(%\)|%)$/.test(f)) sc = 4;
    else if (f === "ORAN") sc = 3;
    else if (f === "ORANI" && /TOPLAM|FON/.test(prev)) sc = 4;
    else if (/^GRUP\s?%$/.test(f)) sc = 0;
    else if (f === "%" || f === "(%)") sc = /FPD|FTD|TOPLAM%/.test(joined) ? 0 : 2;
    else if (f === "AGIRLIK" || f === "AGIRLIGI" || f === "AGIRLIK(%)") sc = 4;
    if (sc > wScore) { wScore = sc; wx = tokens[i].x; }
    if ((f === "DEGER" || f === "DEGERI" || f === "DEG") && /TOPLAM|RAYIC|PIYASA|BORSA/.test(prev)) vx = (tokens[i].x + tokens[i - 1].x) / 2;
    else if (f === "RAYIC" && !vx) vx = tokens[i].x;
  }
  return { wx, wScore, vx, pcts };
}

// Raporun başındaki / IV. tablodaki fon toplam değeri (TL)
function findFundTotal(allRows, F, loc) {
  for (let i = 0; i < allRows.length; i++) {
    const f = F[i];
    if (!/TOPLAM DEGER|NET VARLIK DEGERI/.test(f) || /PORTFOY DEGER|TABLOSU|GRUP/.test(f)) continue;
    const nums = allRows[i].tokens.map(t => NUM_TOK.test(t.s) ? toNum(t.s, loc) : null).filter(v => v != null && v > 1e4);
    if (nums.length) return nums[0];
  }
  return null;
}
export function parseRows(allRows) {
  let F = allRows.map(r => fold(r.tokens.map(t => t.s).join(" ")));
  const FTD = findFundTotal(allRows, F, detectLocale(allRows));
  const J = F.map((l, i) => (l + " " + (F[i + 1] || "")).replace(/[:;]/g, " ").replace(/\s+/g, " ")); // bölünmüş başlıklar için
  let st = J.findIndex(l => START_F.test(l));
  if (st < 0) st = 0;
  let en = J.findIndex((l, i) => i > st && STOP_F.test(l) && !START_F.test(l));
  if (en < 0) en = allRows.length;
  const rows = allRows.slice(st, en); F = F.slice(st, en);
  const loc = detectLocale(rows);
  let W = null, V = null, wScore = 0, inHdr = false, OTH = []; // aktif sütun konumları
  const recs = [];
  let cur = null, section = "", cont = 0;
  for (let ri = 0; ri < rows.length; ri++) {
    const r = rows[ri], f = F[ri];
    if (r.pageBreak) { cur = null; continue; }
    if (!r.tokens.length) continue;
    const toks = r.tokens;
    const nums = [];
    for (const t of toks) {
      if (DATE_TOK.test(t.s)) continue;
      if (NUM_TOK.test(t.s)) { const v = toNum(t.s, loc); if (v !== null) nums.push({ v, x: t.x, s: t.s, dec: /[.,]\d+%?\)?$/.test(t.s) || /%/.test(t.s) }); }
    }
    const isins = toks.map(t => t.s.replace(/[^A-Z0-9]/g, "")).filter(isIsin);
    // başlık satırı
    if (nums.length <= 1 && /(ORAN|FTD|FPD|%|RAYIC|DEGER|NOMINAL|IHRAC)/.test(f) && !isins.length) {
      const h = headerCols(toks);
      if (!inHdr) { inHdr = true; wScore = 0; }
      if (h.wx != null && h.wScore > wScore) { W = h.wx; wScore = h.wScore; OTH = h.pcts.filter(x => Math.abs(x - h.wx) > 5); }
      if (h.vx != null) V = h.vx;
      cur = null; continue;
    }
    inHdr = false;
    if (TOTAL_F.test(f)) { cur = null; continue; }
    if (nums.length === 0 && !isins.length) {
      if (MONTH_F.test(f.trim()) || /^[A-Z0-9]{2,4}\s*-\s*\S/.test(f) && ri < rows.length && /FON/.test(f) && f.length > 25) { cur = null; continue; }
      if (SECTION_F.test(f) && f.length < 70 && toks[0].x < 120) { section = normText(toks.map(t => t.s).join(" ")).replace(/^[A-Za-zİ0-9]{1,3}\s*[-.)]+\s*/, "").slice(0, 60); cur = null; continue; }
    }
    if (/\s:\s|^\S.*\s:$/.test(toks.map(t => t.s).join(" ")) && !isins.length) { cur = null; continue; }
    if (/\bSAYFA\b|\bPAGE\b/.test(f) && !isins.length) { continue; }
    if (nums.length >= 2) {
      let oran = null, deger = null;
      const dec = nums.filter(n => Math.abs(n.v) <= 100.0001);
      if (W != null) {
        let best = null, bd = 1e9;
        for (const n of dec) { const d = Math.abs(n.x - W); if (d < bd) { bd = d; best = n; } }
        // başka bir yüzde sütununa (ör. Grup%) daha yakınsa ağırlık sayma
        if (best && OTH.some(o => Math.abs(best.x - o) < bd)) { best = null; }
        if (best && bd < 45) oran = best.v;
        else if (wScore >= 4) {
          // ağırlık sütunu boş: kimliği (ISIN/kod) olan satırlarda değerden hesapla; diğerlerinde eski yedek yönteme bırak
          const t0 = toks[0]?.s || "", t1 = toks[1]?.s || "";
          const ident = isins.length || /^[A-Z0-9]{2,6}(\.[EF])?$/.test(t0) || (/^\d{1,4}\.?$/.test(t0) && /^[A-Z0-9]{2,6}(\.[EF])?$/.test(t1));
          if (ident) oran = NaN;
        }
      }
      if (oran === null) {
        // yedek: sondaki yüzde bloğunun son değeri (ağırlık sütunu bilinmiyorsa)
        let k = nums.length, blk = [];
        while (k > 0 && blk.length < 4 && Math.abs(nums[k - 1].v) <= 100.0001 && nums[k - 1].dec) { blk.unshift(nums[k - 1]); k--; }
        if (blk.length) { oran = blk[blk.length - 1].v; deger = k > 0 ? nums[k - 1].v : null; }
      }
      if (V != null) {
        let best = null, bd = 1e9;
        for (const n of nums) { const d = Math.abs(n.x - V); if (d < bd) { bd = d; best = n; } }
        if (best && bd < 60) deger = best.v;
      }
      if (deger === null) { const big = nums.filter(n => Math.abs(n.v) > 100).map(n => n.v); if (big.length) deger = big[big.length - 1]; }
      if (oran === null) { if (cur && cont < 5) { cur.words.push(...toks.map(t => t.s)); cont++; } continue; }
      const numSet = new Set(nums.map(n => n.s));
      const words = toks.filter(t => !numSet.has(t.s) && !DATE_TOK.test(t.s) && !isIsin(t.s)).map(t => t.s);
      // ilk hücre (kod): ilk token grubu, x'e göre ilk boşluk aralığına kadar
      let code = "";
      // baştaki sıra numarasını atla ("1 AEFES.E ...")
      const c0 = toks.length > 1 && /^\d{1,4}\.?$/.test(toks[0].s) && /^[A-ZÇĞİÖŞÜ0-9_]{2,12}(\.[A-Z]{1,2})?$/.test(toks[1].s) ? 1 : 0;
      if (toks.length > c0 && !NUM_TOK.test(toks[c0].s) && !DATE_TOK.test(toks[c0].s)) {
        code = toks[c0].s;
        for (let j = c0 + 1; j < toks.length; j++) {
          const gap = toks[j].x0 - toks[j - 1].x1;
          if (gap > 6 || NUM_TOK.test(toks[j].s) || DATE_TOK.test(toks[j].s)) break;
          code += " " + toks[j].s;
        }
      }
      cur = { isin: isins[0] || "", code, words, section, oran, deger, sig: `${r.page || 0}|${toks.map(t => t.s).join(" ")}` };
      recs.push(cur); cont = 0;
      continue;
    }
    if (cur && cont < 5) {
      if (!cur.isin && isins.length) cur.isin = isins[0];
      cur.words.push(...toks.filter(t => !isIsin(t.s.replace(/[^A-Z0-9]/g, ""))).map(t => t.s));
      cont++;
    }
  }
  // ağırlık sütunu boş kalan satırlar: değer / fon toplam değeri, yoksa at
  for (const r of recs) if (Number.isNaN(r.oran)) {
    const ident = r.isin || /^[A-Z0-9]{2,6}(\.[EF])?$/.test((r.code || "").split(" ")[0]);
    r.oran = ident && FTD && r.deger ? Math.round(r.deger / FTD * 1e8) / 1e6 : null;
  }
  const out = clean(recs.filter(r => r.oran !== null));
  // yuvarlanmış ağırlıkları değer / fon toplam değeri ile hassaslaştır
  // (sadece yuvarlamanın anlamlı hata yarattığı yerlerde: küçük ağırlıklar ve çok lotlu kalemler)
  if (FTD) {
    let agree = 0, cmp = 0;
    for (const h of out) if (h.deger && Math.abs(h.oran) >= 0.5 && h.lot === 1) { cmp++; if (Math.abs(h.deger / FTD * 100 - h.oran) <= Math.max(0.05, Math.abs(h.oran) * 0.03)) agree++; }
    if (cmp >= 2 && agree / cmp >= 0.8) {
      for (const h of out) if (h.deger != null && (Math.abs(h.oran) < 1 || h.lot > 1)) {
        const calc = h.deger / FTD * 100;
        if (Math.abs(calc - h.oran) <= 0.0051 * h.lot + 0.01) h.oran = Math.round(calc * 1e6) / 1e6;
      }
    }
  }
  return out.map(({ lot, ...h }) => h);
}

const isTickerLike = s => /^[A-ZÇĞİÖŞÜ0-9]{2,6}$/.test(s) || /^[A-Z0-9]{1,6} (US|LN|GY|GR|FP|NA|SW|JP|HK|IM|SM|CN|AU|EQUITY)$/.test(s);
function clean(recs) {
  const out = [], seen = new Set();
  for (const r of recs) {
    let kod = normText(r.code).replace(/\s+/g, " ").trim().replace(/\.E$/, "").replace(/ US EQUITY$/, " US").replace(/ EQUITY$/, "");
    if (isIsin(kod)) { if (!r.isin) r.isin = kod; kod = ""; }
    if (kod === r.isin) kod = "";
    if (/^(TL|TRY|USD|EUR|GBP|CHF|JPY|XAU|ALTIN)$/.test(kod)) kod = "";
    if (kod && !isTickerLike(kod)) { const m = kod.match(/^([A-Z0-9]{2,6})\s*-/) || kod.match(/^([A-Z0-9]{3,6})(?:\.[EF])?\s/); if (m) kod = m[1]; }
    if (!isTickerLike(kod)) kod = kod.length <= 24 && /^[A-ZÇĞİÖŞÜ0-9 .\-/]+$/.test(kod) ? kod : "";
    const skip = new Set([r.isin, r.code, "TL", "USD", "EUR", "TRY", "GBP"]);
    let ad = r.words.filter(w => !skip.has(w) && !/^[\d.,%/-]+$/.test(w)).join(" ").replace(/\s+/g, " ").trim().slice(0, 90);
    if (!r.isin && !kod && !ad) continue;
    if (!r.isin && (r.deger == null || Math.abs(r.deger) < 1) ) continue;
    if (r.oran < -100 || r.oran > 100) continue;
    const dk = r.sig ? r.sig.replace(/^\d+\|/, "") + "|" + r.isin : [r.isin, kod, r.oran, r.deger].join("|");
    out.push({ isin: r.isin, kod, ad: normText(ad), tur: r.section, oran: r.oran, deger: r.deger });
  }
  // aynı kıymetin lot satırlarını birleştir
  const agg = new Map(), res = [];
  for (const h of out) {
    const key = (h.isin || h.kod) ? [h.isin, h.kod, h.tur].join("|") : null;
    if (!key) { res.push(h); continue; }
    const a = agg.get(key);
    if (!a) { const c = { ...h, lot: 1 }; agg.set(key, c); res.push(c); }
    else { a.oran = Math.round((a.oran + h.oran) * 1e6) / 1e6; a.deger = (a.deger ?? 0) + (h.deger ?? 0); a.lot++; if (!a.ad && h.ad) a.ad = h.ad; }
  }
  for (const h of res) if (!h.lot) h.lot = 1;
  return res;
}

export function xlsxToRows(buf) {
  const wb = XLSX.read(buf, { type: "buffer" });
  const rows = [];
  for (const sn of wb.SheetNames) {
    const aoa = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, raw: true, defval: null });
    for (const r of aoa) {
      const tokens = [];
      r.forEach((c, i) => {
        if (c == null || c === "") return;
        const str = typeof c === "number" ? String(c).replace(".", ",") : normText(String(c));
        const parts = str.split(/\s+/).filter(Boolean);
        parts.forEach((p, j) => tokens.push({ s: p, x: i * 100 + j * 4, x0: i * 100 + j * 4, x1: i * 100 + j * 4 + 3 }));
      });
      rows.push({ tokens });
    }
    rows.push({ tokens: [], pageBreak: true });
  }
  return rows;
}

export async function parseAttachment(buf, ext) {
  ext = (ext || "").toLowerCase();
  const b = stripKapHeader(buf, ext);
  if (ext === "pdf") {
    const { rows, chars } = await pdfToRows(b);
    if (chars < 80) return { holdings: [], status: "taranmis" };
    const h = parseRows(rows);
    return { holdings: h, status: h.length ? "ok" : "okunamadi" };
  }
  if (ext === "xlsx" || ext === "xls") {
    const h = parseRows(xlsxToRows(b));
    return { holdings: h, status: h.length ? "ok" : "okunamadi" };
  }
  return { holdings: [], status: "desteklenmiyor" };
}

export const PARSER_VERSION = 11;
export function quality(holdings) {
  const s = holdings.reduce((a, h) => a + (h.oran || 0), 0);
  return { toplamOran: Math.round(s * 100) / 100, kalite: s >= 85 && s <= 115 ? "iyi" : s > 115 ? "fazla" : s >= 40 ? "kismi" : "zayif" };
}
