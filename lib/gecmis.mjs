// Fonların önceki portföy dağılım raporları (aydan aya / haftadan haftaya fark için).
// Yapı: { olusturma, fonlar: { FON: [ {idx, yayin, donem, kalite, toplamOran, rows:[[isin,kod,ad,tur,oran,deger],...]}, ... ] } }
// Her fonda en yeni rapor başta, en fazla GECMIS_MAX rapor tutulur. Şu anki rapor burada değil, ana veritabanında.
export const GECMIS_MAX = 6;

export const snapshotFromRows = (rp, rows) => ({
  idx: rp.idx, yayin: rp.yayin || "", donem: rp.donem || "",
  kalite: rp.kalite || "", toplamOran: rp.toplamOran ?? null, rows
});

export function mergeGecmis(a = [], b = []) {
  const m = new Map();
  // toplamı %115'i aşan (yanlış okunmuş) raporlar fark hesabını bozar: alma
  for (const s of [...(a || []), ...(b || [])]) if (s?.idx && s.rows?.length && !(s.toplamOran > 115) && !m.has(s.idx)) m.set(s.idx, s);
  // aynı dönemin düzeltmeleri: sadece en son yayımlananı tut
  const per = new Map();
  for (const s of m.values()) { const p = per.get(s.donem); if (!p || s.yayin > p.yayin) per.set(s.donem, s); }
  return [...per.values()].sort((x, y) => y.yayin.localeCompare(x.yayin)).slice(0, GECMIS_MAX);
}

// İki geçmiş dosyasını birleştir (Blobs + repodaki seed)
export function mergeAll(g1, g2) {
  const out = { olusturma: [g1?.olusturma, g2?.olusturma].filter(Boolean).sort().pop() || null, fonlar: {} };
  const keys = new Set([...Object.keys(g1?.fonlar || {}), ...Object.keys(g2?.fonlar || {})]);
  for (const k of keys) { const v = mergeGecmis(g1?.fonlar?.[k], g2?.fonlar?.[k]); if (v.length) out.fonlar[k] = v; }
  return out;
}

// Ana veritabanındaki şu anki raporu geçmişten çıkar (aynı rapor iki kez görünmesin)
export function pruneCurrent(g, db) {
  for (const [k, list] of Object.entries(g.fonlar)) {
    const rp = db?.fonlar?.[k]?.rapor; if (!rp) continue;
    const cur = rp.eskiVeri?.idx || rp.idx, curDonem = rp.eskiVeri?.donem || rp.donem;
    const kept = list.filter(s => s.idx !== cur && s.donem !== curDonem && s.yayin <= (rp.eskiVeri?.yayin || rp.yayin || "9999"));
    if (kept.length) g.fonlar[k] = kept; else delete g.fonlar[k];
  }
  return g;
}
