// TEFAS fon listesi + KAP portföy dağılım raporları → veritabanı
import { parseAttachment, quality, PARSER_VERSION } from "./parse.mjs";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
const KAP = "https://www.kap.org.tr";
const SUBJECT_PDR = "8aca490d502e34b801502e380044002b"; // Portföy Dağılım Raporu
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ymd = d => d.toISOString().slice(0, 10);

async function req(url, opts = {}, tries = opts.tries || 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), opts.timeout || 45000);
      const r = await fetch(url, { ...opts, signal: ctl.signal, headers: { "User-Agent": UA, ...(opts.headers || {}) } });
      clearTimeout(to);
      if (r.ok) return r;
      last = new Error(`HTTP ${r.status} ${url}`);
      if (r.status === 404) break;
    } catch (e) { last = e; }
    if (i < tries - 1) await sleep((opts.backoff ?? 1500) * (i + 1));
  }
  throw last;
}

export async function fetchTefasFunds(kind = "YAT") {
  const d = new Date();
  for (let back = 0; back < 10; back++) {
    const day = new Date(d.getTime() - back * 864e5);
    const s = ymd(day).replace(/-/g, "");
    const body = { fonTipi: kind, fonKodu: null, aramaMetni: null, fonTurKod: null, fonGrubu: null, sfonTurKod: null, fonTurAciklama: null, kurucuKod: null, basTarih: s, bitTarih: s, basSira: 1, bitSira: 100000, dil: "TR", sFonTurKod: "", fonKod: "", fonGrup: "", fonUnvanTip: "" };
    const r = await req("https://www.tefas.gov.tr/api/funds/fonGnlBlgSiraliGetir", {
      method: "POST", body: JSON.stringify(body),
      headers: { "Content-Type": "application/json", Accept: "*/*", Origin: "https://www.tefas.gov.tr", Referer: "https://www.tefas.gov.tr/tr/fon-verileri" }
    });
    const j = await r.json();
    const list = j.resultList || [];
    if (list.length > 100) {
      const out = {};
      for (const x of list) out[x.fonKodu] = { ad: x.fonUnvan, buyukluk: x.portfoyBuyukluk, yatirimci: x.kisiSayisi, fiyatTarihi: x.tarih };
      return out;
    }
  }
  throw new Error("TEFAS fon listesi alınamadı");
}

async function kapDay(day) {
  const p = { fromDate: day, toDate: day, fundTypeList: ["YF"], mkkMemberOidList: [], fundOidList: [], passiveFundOidList: [], disclosureClass: "", isLate: "", subjectList: [SUBJECT_PDR], discIndex: [], fromSrc: false, srcCategory: "" };
  const r = await req(`${KAP}/tr/api/disclosure/funds/byCriteria`, {
    method: "POST", body: JSON.stringify(p),
    headers: { "Content-Type": "application/json", Accept: "application/json", Referer: `${KAP}/tr/bildirim-sorgu` }
  });
  const j = await r.json();
  return Array.isArray(j) ? j : [];
}

const parseTrDate = s => { const m = String(s).match(/(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/); return m ? `${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:${m[6]}` : ""; };

// [from, to] aralığındaki portföy dağılım raporu bildirimleri (gün gün; 2000 sınırına takılmamak için)
async function kapDayRetry(day) {
  let last;
  for (let i = 0; i < 4; i++) { try { return await kapDay(day); } catch (e) { last = e; await sleep(3000 * (i + 1)); } }
  throw last;
}
export async function fetchKapReports(fromDate, toDate, log = () => {}, failed = []) {
  const out = [];
  for (let d = new Date(toDate); d >= new Date(fromDate); d = new Date(d.getTime() - 864e5)) {
    const day = ymd(d);
    let list = [];
    try { list = await kapDayRetry(day); }
    catch (e) { log(`KAP ${day}: alınamadı (${e.message})`); failed.push(day); continue; }
    for (const x of list) if (x.fundCode) out.push({ fon: x.fundCode, idx: x.disclosureIndex, yayin: parseTrDate(x.publishDate), yil: x.year, donem: x.ruleType, ek: x.attachmentCount });
    if (list.length) log(`KAP ${day}: ${list.length} bildirim`);
    await sleep(150);
  }
  return out;
}

export function latestPerFund(reports) {
  const best = {};
  for (const r of reports) { const b = best[r.fon]; if (!b || r.yayin > b.yayin || (r.yayin === b.yayin && r.idx > b.idx)) best[r.fon] = r; }
  return best;
}

async function fetchAndParse(rep, fast = true) {
  const R = fast ? { tries: 2, backoff: 700 } : { tries: 4, backoff: 2500 };
  const det = await (await req(`${KAP}/tr/api/notification/attachment-detail/${rep.idx}`, { headers: { Accept: "application/json" }, ...R })).json();
  const atts = (det?.[0]?.attachments || []).filter(a => /^(pdf|xlsx|xls)$/i.test(a.fileExtension));
  if (!atts.length) return { status: "ek_yok", holdings: [] };
  let best = null;
  for (const a of atts.slice(0, 4)) {
    try {
      let buf;
      const cdir = process.env.FON_CACHE_DIR, cfile = cdir ? `${cdir}/${a.objId}` : null;
      if (cfile) { try { buf = (await import("fs")).readFileSync(cfile); } catch { buf = null; } }
      for (let t = 0; t < (fast ? 2 : 3) && !buf; t++) {
        buf = Buffer.from(await (await req(`${KAP}/tr/api/file/download/${a.objId}`, { timeout: 90000, ...R })).arrayBuffer());
        const head = buf.subarray(0, 600);
        if (head.indexOf("%PDF") >= 0 || head.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04])) >= 0 || head.indexOf(Buffer.from([0xd0, 0xcf, 0x11, 0xe0])) >= 0) break;
        buf = null; await sleep((fast ? 800 : 2500) * (t + 1));
      }
      if (!buf) throw new Error("KAP geçerli dosya döndürmedi");
      if (cfile) (await import("fs")).writeFileSync(cfile, buf);
      const r = await parseAttachment(buf, a.fileExtension.toLowerCase());
      const q = quality(r.holdings);
      const score = r.holdings.length ? -Math.abs(100 - q.toplamOran) : -1e9;
      if (!best || score > best.score) best = { ...r, ...q, score, dosya: a.fileName, objId: a.objId };
    } catch (e) {
      if (!best) best = { status: "hata", holdings: [], hata: String(e.message || e).slice(0, 120), score: -1e10 };
    }
  }
  return best;
}

// Ana güncelleme. db: önceki veritabanı (veya boş). opts.lookbackDays: ilk kurulum için
// TEFAS'ta işlem gören fonlar (tefasDurum = true)
export async function fetchTefasTraded(kind = "YAT") {
  const body = { dil: "TR", fonTipi: kind, kurucuKodu: null, sfonTurKod: null, fonTurAciklama: null, islem: 1, fonTurKod: null, fonGrubu: null, donemGetiri1a: "1", donemGetiri3a: "0", donemGetiri6a: "0", donemGetiri1y: "0", donemGetiriyb: "0", donemGetiri3y: "0", donemGetiri5y: "0", basTarih: null, bitTarih: null, calismaTipi: 2, getiriOrani: "1" };
  const r = await req("https://www.tefas.gov.tr/api/funds/fonGetiriBazliBilgiGetir", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", Accept: "*/*", Origin: "https://www.tefas.gov.tr", Referer: "https://www.tefas.gov.tr/tr/fon-verileri" } });
  const list = ((await r.json()).resultList || []).filter(x => x.tefasDurum !== false);
  return list.length > 300 ? new Set(list.map(x => x.fonKodu)) : null;
}

// TEFAS varlık sınıfı dağılımı (günlük, tüm fonlar tek istekte)
const DAGILIM_ADLARI = { hs: "Hisse senedi", yhs: "Yabancı hisse", dt: "Devlet tahvili", hb: "Hazine bonosu", fb: "Finansman bonosu", ost: "Özel sektör tahvili", bb: "Banka bonosu", eut: "Eurobond", kibd: "Kamu dış borçlanma", osdb: "Özel sektör dış borçlanma", kba: "Kamu iç borç. (döviz)", tpp: "Takasbank para piyasası", bpp: "Borsa para piyasası", r: "Repo", tr: "Ters repo", vm: "Vadeli mevduat", vmtl: "Mevduat (TL)", vmd: "Mevduat (döviz)", vmau: "Mevduat (altın)", kh: "Katılım hesabı", khtl: "Katılım hesabı (TL)", khd: "Katılım hesabı (döviz)", khau: "Katılım hesabı (altın)", kks: "Kamu kira sertifikası", kkstl: "Kamu kira sert. (TL)", kksd: "Kamu kira sert. (döviz)", kksyd: "Kamu yurt dışı kira sert.", osks: "Özel sektör kira sert.", oksyd: "Özel sektör yurt dışı kira sert.", km: "Kıymetli maden", kmbyf: "Kıymetli maden BYF", kmkba: "Kıymetli maden kamu borç.", kmkks: "Kıymetli maden kira sert.", ymk: "Yabancı menkul kıymet", yba: "Yabancı borçlanma aracı", ybkb: "Yabancı kamu borç.", ybosb: "Yabancı özel sektör borç.", ybyf: "Yabancı BYF", fkb: "Fon katılma belgesi", yyf: "Yatırım fonu", byf: "Borsa yatırım fonu", gykb: "Gayrimenkul yat. fonu", gyy: "Gayrimenkul yatırımı", gsykb: "Girişim sermayesi fonu", gsyy: "Girişim sermayesi yatırımı", t: "Türev araçlar", vint: "Vadeli işlem nakit teminatı", gas: "Gayrimenkul sertifikası", vdm: "Varlığa dayalı menkul kıymet", dot: "Döviz ödemeli bono", db: "Döviz ödemeli tahvil", btaa: "Borsa taahhütlü alım", btas: "Borsa taahhütlü satım", d: "Diğer" };
export async function fetchTefasAllocation(kind = "YAT") {
  const d = new Date();
  for (let back = 0; back < 10; back++) {
    const s = ymd(new Date(d.getTime() - back * 864e5)).replace(/-/g, "");
    const body = { fonTipi: kind, fonKodu: null, aramaMetni: null, fonTurKod: null, fonGrubu: null, sfonTurKod: null, fonTurAciklama: null, kurucuKod: null, basTarih: s, bitTarih: s, basSira: 1, bitSira: 100000, dil: "TR", sFonTurKod: "", fonKod: "", fonGrup: "", fonUnvanTip: "" };
    const r = await req("https://www.tefas.gov.tr/api/funds/dagilimSiraliGetirT", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", Accept: "*/*", Origin: "https://www.tefas.gov.tr", Referer: "https://www.tefas.gov.tr/tr/fon-verileri" } });
    const list = (await r.json()).resultList || [];
    if (list.length > 100) {
      const out = {};
      for (const x of list) {
        const a = {};
        for (const [k, v] of Object.entries(x)) if (DAGILIM_ADLARI[k] && typeof v === "number" && Math.abs(v) >= 0.01) a[k] = Math.round(v * 100) / 100;
        out[x.fonKodu] = { tarih: x.tarih, d: a };
      }
      return out;
    }
  }
  return null;
}
export { DAGILIM_ADLARI };

// Ana güncelleme. db: önceki veritabanı (veya boş).
export async function refresh(db, { lookbackDays = 120, concurrency = 6, log = () => {}, deadlineMs = 13 * 60e3, onProgress = () => {} } = {}) {
  const t0 = Date.now();
  db = db || { fonlar: {}, satirlar: {}, guncelleme: null, kapSonKontrol: null };
  const [tefasAll, dagilim, traded] = await Promise.all([fetchTefasFunds("YAT"), fetchTefasAllocation("YAT").catch(() => null), fetchTefasTraded("YAT").catch(() => null)]);
  // evren: TEFAS'ta işlem gören fonlar (liste alınamazsa öncekini koru, o da yoksa hepsi)
  const tradedSet = traded || (db.tefasIslem ? new Set(db.tefasIslem) : null);
  const tefas = tradedSet ? Object.fromEntries(Object.entries(tefasAll).filter(([k]) => tradedSet.has(k))) : tefasAll;
  if (traded) db.tefasIslem = [...traded];
  log(`TEFAS: ${Object.keys(tefasAll).length} fon, işlem gören ${Object.keys(tefas).length}`);
  const today = new Date();
  const from = db.kapSonKontrol ? new Date(new Date(db.kapSonKontrol).getTime() - 3 * 864e5) : new Date(today.getTime() - lookbackDays * 864e5);
  const failedDays = [];
  const reps = await fetchKapReports(ymd(from), ymd(today), log, failedDays);
  const latest = latestPerFund(reps);
  for (const [k, v] of Object.entries(tefas)) db.fonlar[k] = { ...(db.fonlar[k] || {}), ad: v.ad, buyukluk: v.buyukluk, yatirimci: v.yatirimci };
  if (dagilim) { db.dagilim = {}; for (const k of Object.keys(tefas)) if (dagilim[k]) db.dagilim[k] = dagilim[k]; }
  // iş listesi: yeni/değişen raporlar, önceki hatalar, eski parser sürümüyle okunanlar
  const todo = [], seen = new Set();
  const add = r => { if (!seen.has(r.fon)) { seen.add(r.fon); todo.push(r); } };
  for (const r of Object.values(latest)) {
    const cur = db.fonlar[r.fon]?.rapor;
    if (tefas[r.fon] && (!cur || (cur.idx !== r.idx && r.yayin >= (cur.yayin || "")))) add(r);
  }
  const nNew = todo.length;
  for (const [k, f] of Object.entries(db.fonlar)) {
    const rp = f.rapor; if (!tefas[k] || !rp?.idx) continue;
    if (rp.status === "hata" && (rp.deneme || 0) < 6) add({ fon: k, idx: rp.idx, yayin: rp.yayin, yil: "", donem: rp.donem, deneme: (rp.deneme || 0) + 1 });
  }
  const nRetry = todo.length - nNew;
  for (const [k, f] of Object.entries(db.fonlar)) {
    const rp = f.rapor; if (!tefas[k] || !rp?.idx) continue;
    if (rp.status !== "hata" && rp.status !== "ek_yok" && !rp.ocr && !rp.eskiVeri && (rp.pv || 0) < PARSER_VERSION) add({ fon: k, idx: rp.idx, yayin: rp.yayin, yil: "", donem: rp.donem });
  }
  log(`İşlenecek rapor: ${todo.length} (yeni ${nNew}, yeniden deneme ${nRetry}, yeni parser ile tekrar okuma ${todo.length - nNew - nRetry})`);
  let done = 0, stopped = false;
  const later = [];
  const store = (rep, r) => {
    const prev = db.fonlar[rep.fon].rapor;
    // yeni rapor taranmış ama elimizde önceki bir raporun okunmuş verisi varsa onu koru
    if (r.status === "taranmis" && prev && (prev.status === "ok" || prev.eskiVeri) && (db.satirlar[rep.fon] || []).length) {
      const base = prev.eskiVeri ? prev : { ...prev, eskiVeri: { donem: prev.donem, yayin: prev.yayin, idx: prev.idx, ocr: !!prev.ocr } };
      db.fonlar[rep.fon].rapor = { ...base, sonTaranmis: { idx: rep.idx, yayin: rep.yayin, donem: `${rep.yil} ${rep.donem || ""}`.trim() }, pv: PARSER_VERSION };
      return;
    }
    db.fonlar[rep.fon].rapor = { idx: rep.idx, yayin: rep.yayin, donem: `${rep.yil} ${rep.donem || ""}`.trim(), dosya: r.dosya || "", objId: r.objId || "", status: r.status, kalite: r.kalite || "zayif", toplamOran: r.toplamOran ?? 0, pv: PARSER_VERSION, ...(r.hata ? { hata: r.hata } : {}) };
    db.satirlar[rep.fon] = r.holdings.map(h => [h.isin, h.kod, h.ad, h.tur, round(h.oran, 4), h.deger == null ? null : Math.round(h.deger * 100) / 100]);
  };
  const fail = (rep, e) => {
    const prev = db.fonlar[rep.fon].rapor;
    // önceki başarılı okuma varsa koru; yoksa hata olarak işaretle
    if (prev && prev.idx === rep.idx && prev.status === "ok") return;
    db.fonlar[rep.fon].rapor = { idx: rep.idx, yayin: rep.yayin, donem: `${rep.yil} ${rep.donem || ""}`.trim(), status: "hata", kalite: "zayif", toplamOran: 0, deneme: rep.deneme || 1, hata: String(e.message || e).slice(0, 120) };
  };
  const tick = async () => { done++; if (done % 5 === 0 || done === todo.length) { if (done % 25 === 0) log(`İşlenen ${done}/${todo.length}`); await onProgress({ done, total: todo.length, gecen: Math.round((Date.now() - t0) / 1000) }, db); } };
  let i = 0;
  const worker = async () => {
    while (i < todo.length) {
      if (Date.now() - t0 > deadlineMs) { stopped = true; return; }
      const rep = todo[i++];
      try {
        const r = await fetchAndParse(rep, true);
        if (r.status === "hata") { later.push(rep); continue; }
        store(rep, r); await tick();
      } catch (e) { later.push(rep); }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  // ikinci geçiş: KAP'ın hata verdiği raporları yavaş ve sabırlı dene
  if (later.length) log(`İkinci geçiş: ${later.length} rapor`);
  let j = 0;
  const slow = async () => {
    while (j < later.length) {
      if (Date.now() - t0 > deadlineMs) { stopped = true; return; }
      const rep = later[j++];
      try { const r = await fetchAndParse(rep, false); if (r.status === "hata") fail(rep, new Error(r.hata || "hata")); else store(rep, r); }
      catch (e) { fail(rep, e); }
      await tick();
    }
  };
  await Promise.all(Array.from({ length: 2 }, slow));
  for (const k of Object.keys(db.fonlar)) if (!tefas[k]) { delete db.fonlar[k]; delete db.satirlar[k]; }
  db.eslesme = buildTickerMap(db);
  db.guncelleme = new Date().toISOString();
  db.parserVersion = PARSER_VERSION;
  if (!stopped) db.kapSonKontrol = failedDays.length ? ymd(new Date(new Date(failedDays.sort()[0]).getTime() - 864e5)) : ymd(today);
  const kalan = todo.length - done;
  return { db, stats: { yeni: done, kalan, tamamlandi: !stopped && !failedDays.length, basarisizGunler: failedDays, sure: Math.round((Date.now() - t0) / 1000) } };
}

const round = (x, d) => Math.round(x * 10 ** d) / 10 ** d;

// Raporlardan ticker → ISIN eşlemesi (aynı satırda ikisi birlikte geçenler)
export function buildTickerMap(db) {
  const cnt = {};
  for (const rows of Object.values(db.satirlar)) for (const [isin, kod] of rows) {
    if (!isin || !kod || !/^[A-ZÇĞİÖŞÜ0-9]{3,6}$/.test(kod)) continue;
    if (!/^TR/.test(isin)) continue;
    (cnt[kod] ||= {})[isin] = (cnt[kod][isin] || 0) + 1;
  }
  const map = {};
  for (const [k, v] of Object.entries(cnt)) {
    const [isin, n] = Object.entries(v).sort((a, b) => b[1] - a[1])[0];
    // ISIN içinde ticker geçiyorsa ya da en az 2 kez görüldüyse güven
    if (n >= 2 || isin.includes(k.slice(0, 4))) map[k] = isin;
  }
  return map;
}
