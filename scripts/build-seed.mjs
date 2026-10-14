// Yerelde sıfırdan tam veritabanı: npm run build-seed  → data/seed.json.gz
import fs from "fs"; import zlib from "zlib"; import { refresh } from "../lib/pipeline.mjs";
const { db, stats } = await refresh(null, { lookbackDays: 120, concurrency: 8, log: console.log, deadlineMs: 3 * 3600e3 });
fs.writeFileSync("data/seed.json.gz", zlib.gzipSync(JSON.stringify(db)));
console.log(stats);
