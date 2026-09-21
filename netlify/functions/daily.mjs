// Hafta içi her sabah otomatik yenileme: arka plan fonksiyonunu tetikler.
export default async () => {
  const base = process.env.URL;
  if (base) await fetch(`${base}/.netlify/functions/refresh-background`, { method: "POST" }).catch(() => {});
  return new Response("ok");
};
export const config = { schedule: "0 6-18/2 * * 1-5" }; // hafta içi 09:00-21:00 İstanbul, 2 saatte bir
