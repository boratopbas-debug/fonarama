import { loadDbGz } from "../../lib/store.mjs";
export default async () => {
  const gz = await loadDbGz();
  if (!gz) return new Response(JSON.stringify({ hata: "Veritabanı henüz oluşturulmadı. Verileri yenile." }), { status: 404, headers: { "content-type": "application/json" } });
  return new Response(gz, { headers: { "content-type": "application/octet-stream", "x-format": "json-gzip", "cache-control": "no-cache" } });
};
