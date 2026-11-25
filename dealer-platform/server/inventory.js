import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Pool } from "pg";
import { starterCars } from "../src/data.js";

export const INVENTORY_STATUSES = ["In Stock", "Pending", "Sold"];
function normalizeFuel(fuel) { return String(fuel).toLowerCase() === "gasoline" ? "Petrol" : fuel; }
function normalizeDrivetrain(value) {
  const v = String(value || "").trim(); const n = v.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (!n) return v; if (/4matic/.test(n)) return "4MATIC"; if (/front wheel drive|\bfwd\b/.test(n)) return "FWD";
  if (/rear wheel drive|\brwd\b/.test(n)) return "RWD"; if (/all wheel drive|\bawd\b/.test(n)) return "AWD"; return v;
}
function normalizeCar(car) {
  let price = car.price == null || car.price === "" ? null : Number(car.price);
  if (price !== null && Number.isFinite(price) && price > 0 && price < 1000) price = Math.round(price * 1_000_000);
  return { ...car, make: car.make || "Mercedes-Benz", price, body: car.body || car.type || "Sedan", type: car.type || car.body || "Sedan", fuel: normalizeFuel(car.fuel), drivetrain: normalizeDrivetrain(car.drivetrain) };
}

export class InventoryDatabase {
  constructor(filename) {
    if (filename) this.initializeSqlite(filename);
  }
  static async open({ databaseUrl, filename }) {
    const store = new InventoryDatabase();
    if (databaseUrl) {
      store.pool = new Pool({ connectionString: databaseUrl, ssl: process.env.PGSSL === "disable" ? false : { rejectUnauthorized: false } });
      store.client = await store.pool.connect();
      await store.client.query(`CREATE TABLE IF NOT EXISTS inventory (id TEXT PRIMARY KEY, data_json JSONB NOT NULL, status TEXT NOT NULL CHECK (status IN ('In Stock','Pending','Sold')), created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
      await store.client.query(`CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
      const { rows } = await store.client.query("SELECT value FROM app_meta WHERE key = 'website_inventory_v1'");
      if (!rows.length) {
        await store.client.query("BEGIN");
        try {
          for (const car of starterCars) { const c = normalizeCar(car); await store.client.query("INSERT INTO inventory(id,data_json,status) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING", [c.id, c, c.status]); }
          await store.client.query("INSERT INTO app_meta(key,value) VALUES('website_inventory_v1','true') ON CONFLICT(key) DO NOTHING");
          await store.client.query("COMMIT");
        } catch (error) { await store.client.query("ROLLBACK"); throw error; }
      }
      return store;
    }
    if (!filename) throw new Error("Provide DATABASE_URL or a local SQLite filename");
    store.initializeSqlite(filename);
    return store;
  }
  initializeSqlite(filename) {
    mkdirSync(dirname(filename), { recursive: true }); this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS inventory (id TEXT PRIMARY KEY,data_json TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('In Stock','Pending','Sold'))); CREATE TABLE IF NOT EXISTS app_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
    const migrated = this.db.prepare("SELECT value FROM app_meta WHERE key='website_inventory_v1'").get();
    if (!migrated) { const insert=this.db.prepare("INSERT OR IGNORE INTO inventory VALUES(?,?,?)"); this.db.exec("BEGIN"); try { for (const car of starterCars) { const c=normalizeCar(car); insert.run(c.id,JSON.stringify(c),c.status); } this.db.prepare("INSERT INTO app_meta VALUES('website_inventory_v1','true')").run(); this.db.exec("COMMIT"); } catch(e) { this.db.exec("ROLLBACK"); throw e; } }
  }
  list() {
    if (this.pool) return this.client.query("SELECT data_json,status FROM inventory ORDER BY created_at,id").then(({rows})=>rows.map(r=>({...normalizeCar(r.data_json),status:r.status})));
    return this.db.prepare("SELECT data_json,status FROM inventory ORDER BY rowid").all().map(r=>({...normalizeCar(JSON.parse(r.data_json)),status:r.status}));
  }
  get(id) {
    if (this.pool) return this.client.query("SELECT data_json,status FROM inventory WHERE id=$1",[id]).then(({rows})=>{const r=rows[0]; return r?{...normalizeCar(r.data_json),status:r.status}:null;});
    const r=this.db.prepare("SELECT data_json,status FROM inventory WHERE id=?").get(id); return r?{...normalizeCar(JSON.parse(r.data_json)),status:r.status}:null;
  }
  save(car) {
    car=normalizeCar(car); if (!INVENTORY_STATUSES.includes(car.status)) car.status="In Stock";
    if (this.pool) return this.client.query("INSERT INTO inventory(id,data_json,status) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET data_json=EXCLUDED.data_json,status=EXCLUDED.status",[car.id,car,car.status]).then(()=>this.get(car.id));
    else this.db.prepare("INSERT INTO inventory VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json,status=excluded.status").run(car.id,JSON.stringify(car),car.status);
    return this.get(car.id);
  }
  setStatus(id,status) { const car=this.get(id); if (car && typeof car.then === "function") return car.then((v)=>v?this.save({...v,status}):null); return car?this.save({...car,status}):null; }
  remove(id) { if (this.pool) return this.client.query("DELETE FROM inventory WHERE id=$1",[id]).then((r)=>r.rowCount>0); return this.db.prepare("DELETE FROM inventory WHERE id=?").run(id).changes>0; }
  reset() {
    if (this.pool) return (async () => { await this.client.query("BEGIN"); try { await this.client.query("DELETE FROM inventory"); for (const car of starterCars) { const c=normalizeCar(car); await this.client.query("INSERT INTO inventory(id,data_json,status) VALUES($1,$2,$3)",[c.id,c,c.status]); } await this.client.query("COMMIT"); } catch(e) { await this.client.query("ROLLBACK"); throw e; } })();
    else { this.db.exec("BEGIN"); try { this.db.exec("DELETE FROM inventory"); const insert=this.db.prepare("INSERT INTO inventory VALUES(?,?,?)"); for (const car of starterCars) { const c=normalizeCar(car); insert.run(c.id,JSON.stringify(c),c.status); } this.db.exec("COMMIT"); } catch(e) { this.db.exec("ROLLBACK"); throw e; } }
  }
  close() { if(this.pool) { this.client.release(); return this.pool.end(); } this.db.close(); }
}
