// Fonların önceki raporları (aydan aya fark, değişim özeti). Sayfa ihtiyaç olunca ayrıca yükler.
import zlib from "zlib";
import { loadDb, loadGecmis } from "../../lib/store.mjs";
export default async () => {
  const db = await loadDb().catch(() => null);
  const g = await loadGecmis(db);
  return new Response(zlib.gzipSync(JSON.stringify(g)), { headers: { "content-type": "application/octet-stream", "x-format": "json-gzip", "cache-control": "no-cache" } });
};
