import { getStatus } from "../../lib/store.mjs";
export default async () => new Response(JSON.stringify(await getStatus()), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
