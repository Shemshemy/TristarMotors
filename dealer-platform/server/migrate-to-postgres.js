import { DatabaseSync } from "node:sqlite";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, neonConfig } from "@neondatabase/serverless";
import { ObjectStorage } from "./object-storage.js";

const sourcePath = resolve(process.argv[2] || fileURLToPath(new URL("../data/inventory.sqlite", import.meta.url)));
if (!process.env.DATABASE_URL) throw new Error("Set DATABASE_URL before running this migration.");
const source = new DatabaseSync(sourcePath, { readOnly: true });
neonConfig.webSocketConstructor ??= globalThis.WebSocket;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
let client;
try {
  client = await pool.connect();
} catch {
  source.close();
  await pool.end();
  console.error("Could not connect to Neon from this network. Run this importer in the Render Shell after deploying the updated app.");
  process.exit(1);
}
const storage = new ObjectStorage();
await client.query(`CREATE TABLE IF NOT EXISTS inventory (id TEXT PRIMARY KEY,data_json JSONB NOT NULL,status TEXT NOT NULL CHECK(status IN ('In Stock','Pending','Sold')),created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
await client.query(`CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL)`);
const rows = source.prepare("SELECT id,data_json,status FROM inventory ORDER BY rowid").all();
const localUploads = join(resolve(sourcePath, ".."), "uploads");
const uploaded = new Map();
let imported = 0;
let skipped = 0;
await client.query("BEGIN");
try {
  for (const row of rows) {
    const duplicate = await client.query("SELECT 1 FROM inventory WHERE id=$1", [row.id]);
    if (duplicate.rowCount) { skipped += 1; continue; }
    let car = JSON.parse(row.data_json);
    car.status = row.status;
    if (storage.configured) {
      const mapUrl = async (url) => {
        if (typeof url !== "string" || !url.startsWith("/images/cars/uploads/")) return url;
        const filename = decodeURIComponent(url.split("/").at(-1));
        if (!uploaded.has(filename)) {
          const { readFile } = await import("node:fs/promises");
          uploaded.set(filename, storage.upload(`cars/${filename}`, await readFile(join(localUploads, filename))));
        }
        return uploaded.get(filename);
      };
      car.image = await mapUrl(car.image);
      car.gallery = await Promise.all((car.gallery || []).map(mapUrl));
      car.frames = await Promise.all((car.frames || []).map(mapUrl));
      for (const [category, urls] of Object.entries(car.galleryByCategory || {})) car.galleryByCategory[category] = await Promise.all(urls.map(mapUrl));
    }
    await client.query("INSERT INTO inventory(id,data_json,status) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING", [row.id, car, row.status]);
    imported += 1;
  }
  await client.query("INSERT INTO app_meta(key,value) VALUES('website_inventory_v1','true') ON CONFLICT(key) DO NOTHING");
  await client.query("COMMIT");
  console.log(`Imported ${imported} inventory records; skipped ${skipped} records already in PostgreSQL.`);
} catch (error) { await client.query("ROLLBACK"); throw error; }
finally { source.close(); client.release(); await pool.end(); }
