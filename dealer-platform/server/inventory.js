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
  const normalized = { ...car, make: car.make || "Mercedes-Benz", price, body: car.body || car.type || "Sedan", type: car.type || car.body || "Sedan", fuel: normalizeFuel(car.fuel), drivetrain: normalizeDrivetrain(car.drivetrain) };
  const className = String(normalized.class || "");
  const model = String(normalized.model || "").trim();
  if (/^(?:GLA|GLB|GLC|GLE|GLS|GL)(?:\b|[0-9])/i.test(model) || /^ML\b/i.test(model) || /^(?:(?:GLA|GLB|GLC|GLE|GLS|ML)-Class|GLC & ML)$/i.test(className)) {
    normalized.class = "GL & ML";
  }
  return normalized;
}

export class InventoryDatabase {
  constructor(filename) {
    if (filename) this.initializeSqlite(filename);
  }

  static async open({ databaseUrl, filename }) {
    const store = new InventoryDatabase();
    if (databaseUrl) {
      store.pool = new Pool({
        connectionString: databaseUrl,
        ssl: process.env.NODE_ENV !== "production" && process.env.PGSSL === "disable"
          ? false
          : { rejectUnauthorized: true },
      });
      let client;
      try {
        client = await store.pool.connect();
        await client.query(`CREATE TABLE IF NOT EXISTS inventory (id TEXT PRIMARY KEY, data_json JSONB NOT NULL, status TEXT NOT NULL CHECK (status IN ('In Stock','Pending','Sold')), created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
        await client.query(`CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
        await client.query(`CREATE TABLE IF NOT EXISTS instagram_drafts (media_id TEXT PRIMARY KEY, data_json JSONB NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','rejected','published')), created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
        const { rows } = await client.query("SELECT value FROM app_meta WHERE key = 'website_inventory_v1'");
        if (!rows.length) {
          await client.query("BEGIN");
          try {
            if (process.env.NODE_ENV !== "production") {
              for (const car of starterCars) {
                const normalized = normalizeCar(car);
                await client.query("INSERT INTO inventory(id,data_json,status) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING", [normalized.id, normalized, normalized.status]);
              }
            }
            await client.query("INSERT INTO app_meta(key,value) VALUES('website_inventory_v1','true') ON CONFLICT(key) DO NOTHING");
            await client.query("COMMIT");
          } catch (error) {
            await client.query("ROLLBACK");
            throw error;
          }
        }
        if (process.env.NODE_ENV === "production") {
          await client.query(
            "UPDATE inventory SET data_json=jsonb_set(data_json, '{class}', to_jsonb($1::text)) WHERE data_json->>'class'=$2",
            ["GL & ML", "GLC & ML"],
          );
        }
      } catch (error) {
        if (client) client.release();
        await store.pool.end();
        throw error;
      }
      client.release();
      return store;
    }
    if (!filename) throw new Error("Provide DATABASE_URL or a local SQLite filename");
    store.initializeSqlite(filename);
    return store;
  }

  initializeSqlite(filename) {
    mkdirSync(dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS inventory (id TEXT PRIMARY KEY,data_json TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('In Stock','Pending','Sold'))); CREATE TABLE IF NOT EXISTS app_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS instagram_drafts(media_id TEXT PRIMARY KEY,data_json TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','rejected','published')),created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);`);
    const migrated = this.db.prepare("SELECT value FROM app_meta WHERE key='website_inventory_v1'").get();
    if (!migrated) {
      const insert = this.db.prepare("INSERT OR IGNORE INTO inventory VALUES(?,?,?)");
      this.db.exec("BEGIN");
      try {
        for (const car of starterCars) {
          const normalized = normalizeCar(car);
          insert.run(normalized.id, JSON.stringify(normalized), normalized.status);
        }
        this.db.prepare("INSERT INTO app_meta VALUES('website_inventory_v1','true')").run();
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
  }

  list() {
    if (this.pool) return this.pool.query("SELECT data_json,status FROM inventory ORDER BY CASE status WHEN 'In Stock' THEN 0 WHEN 'Pending' THEN 1 ELSE 2 END, created_at DESC, id DESC").then(({ rows }) => rows.map((row) => ({ ...normalizeCar(row.data_json), status: row.status })));
    return this.db.prepare("SELECT data_json,status FROM inventory ORDER BY CASE status WHEN 'In Stock' THEN 0 WHEN 'Pending' THEN 1 ELSE 2 END, rowid DESC").all().map((row) => ({ ...normalizeCar(JSON.parse(row.data_json)), status: row.status }));
  }

  async listInstagramDrafts() {
    if (this.pool) {
      const { rows } = await this.pool.query("SELECT media_id,data_json,status,created_at FROM instagram_drafts WHERE status='pending' ORDER BY created_at DESC");
      return rows.map((row) => ({ ...row.data_json, mediaId: row.media_id, reviewStatus: row.status, importedAt: row.created_at }));
    }
    return this.db.prepare("SELECT media_id,data_json,status,created_at FROM instagram_drafts WHERE status='pending' ORDER BY created_at DESC").all()
      .map((row) => ({ ...JSON.parse(row.data_json), mediaId: row.media_id, reviewStatus: row.status, importedAt: row.created_at }));
  }

  async importInstagramDrafts(drafts) {
    let imported = 0;
    for (const draft of drafts) {
      const id = String(draft.mediaId);
      if (this.pool) {
        const result = await this.pool.query(`INSERT INTO instagram_drafts(media_id,data_json) VALUES($1,$2)
          ON CONFLICT(media_id) DO UPDATE SET data_json=instagram_drafts.data_json || jsonb_build_object('imageUrls', EXCLUDED.data_json->'imageUrls'),updated_at=now()
          WHERE instagram_drafts.status='pending' AND jsonb_array_length(COALESCE(instagram_drafts.data_json->'imageUrls','[]'::jsonb)) < jsonb_array_length(COALESCE(EXCLUDED.data_json->'imageUrls','[]'::jsonb))`, [id, draft]);
        if (result.rowCount) imported += 1;
      } else {
        const result = this.db.prepare("INSERT INTO instagram_drafts(media_id,data_json) VALUES(?,?) ON CONFLICT(media_id) DO NOTHING").run(id, JSON.stringify(draft));
        if (result.changes) imported += 1;
        else {
          const current = this.db.prepare("SELECT data_json,status FROM instagram_drafts WHERE media_id=?").get(id);
          const existing = current && JSON.parse(current.data_json);
          if (current?.status === "pending" && (draft.imageUrls?.length || 0) > (existing?.imageUrls?.length || 0)) {
            existing.imageUrls = draft.imageUrls;
            this.db.prepare("UPDATE instagram_drafts SET data_json=?,updated_at=CURRENT_TIMESTAMP WHERE media_id=? AND status='pending'").run(JSON.stringify(existing), id);
          }
        }
      }
    }
    return imported;
  }

  async getInstagramDraft(mediaId) {
    if (this.pool) {
      const { rows } = await this.pool.query("SELECT media_id,data_json,status FROM instagram_drafts WHERE media_id=$1", [mediaId]);
      const row = rows[0];
      return row ? { ...row.data_json, mediaId: row.media_id, reviewStatus: row.status } : null;
    }
    const row = this.db.prepare("SELECT media_id,data_json,status FROM instagram_drafts WHERE media_id=?").get(mediaId);
    return row ? { ...JSON.parse(row.data_json), mediaId: row.media_id, reviewStatus: row.status } : null;
  }

  async updateInstagramDraft(mediaId, draft) {
    if (this.pool) {
      const { rows } = await this.pool.query("UPDATE instagram_drafts SET data_json=$2,updated_at=now() WHERE media_id=$1 AND status='pending' RETURNING media_id,data_json,status", [mediaId, draft]);
      const row = rows[0];
      return row ? { ...row.data_json, mediaId: row.media_id, reviewStatus: row.status } : null;
    }
    const result = this.db.prepare("UPDATE instagram_drafts SET data_json=?,updated_at=CURRENT_TIMESTAMP WHERE media_id=? AND status='pending'").run(JSON.stringify(draft), mediaId);
    return result.changes ? this.getInstagramDraft(mediaId) : null;
  }

  async deleteInstagramDraft(mediaId) {
    if (this.pool) {
      const { rowCount } = await this.pool.query("DELETE FROM instagram_drafts WHERE media_id=$1 AND status='pending'", [mediaId]);
      return rowCount > 0;
    }
    return this.db.prepare("DELETE FROM instagram_drafts WHERE media_id=? AND status='pending'").run(mediaId).changes > 0;
  }

  async setInstagramDraftStatus(mediaId, status, carId = null) {
    const draft = await this.getInstagramDraft(mediaId);
    if (!draft || draft.reviewStatus !== "pending") return false;
    if (carId) draft.publishedCarId = carId;
    if (this.pool) {
      const { rowCount } = await this.pool.query("UPDATE instagram_drafts SET status=$2,data_json=$3,updated_at=now() WHERE media_id=$1 AND status='pending'", [mediaId, status, draft]);
      return rowCount > 0;
    }
    return this.db.prepare("UPDATE instagram_drafts SET status=?,data_json=?,updated_at=CURRENT_TIMESTAMP WHERE media_id=? AND status='pending'").run(status, JSON.stringify(draft), mediaId).changes > 0;
  }

  get(id) {
    if (this.pool) return this.pool.query("SELECT data_json,status FROM inventory WHERE id=$1", [id]).then(({ rows }) => {
      const row = rows[0];
      return row ? { ...normalizeCar(row.data_json), status: row.status } : null;
    });
    const row = this.db.prepare("SELECT data_json,status FROM inventory WHERE id=?").get(id);
    return row ? { ...normalizeCar(JSON.parse(row.data_json)), status: row.status } : null;
  }

  save(car) {
    car = normalizeCar(car);
    if (!INVENTORY_STATUSES.includes(car.status)) car.status = "In Stock";
    if (this.pool) return this.pool.query(
      "INSERT INTO inventory(id,data_json,status) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET data_json=EXCLUDED.data_json,status=EXCLUDED.status",
      [car.id, car, car.status],
    ).then(() => this.get(car.id));
    this.db.prepare("INSERT INTO inventory VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json,status=excluded.status").run(car.id, JSON.stringify(car), car.status);
    return this.get(car.id);
  }

  setStatus(id, status) {
    const car = this.get(id);
    if (car && typeof car.then === "function") return car.then((value) => value ? this.save({ ...value, status }) : null);
    return car ? this.save({ ...car, status }) : null;
  }

  remove(id) {
    if (this.pool) return this.pool.query("DELETE FROM inventory WHERE id=$1", [id]).then((result) => result.rowCount > 0);
    return this.db.prepare("DELETE FROM inventory WHERE id=?").run(id).changes > 0;
  }

  reset() {
    if (this.pool) return (async () => {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        try {
          await client.query("DELETE FROM inventory");
          for (const car of starterCars) {
            const normalized = normalizeCar(car);
            await client.query("INSERT INTO inventory(id,data_json,status) VALUES($1,$2,$3)", [normalized.id, normalized, normalized.status]);
          }
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        }
      } finally {
        client.release();
      }
    })();
    this.db.exec("BEGIN");
    try {
      this.db.exec("DELETE FROM inventory");
      const insert = this.db.prepare("INSERT INTO inventory VALUES(?,?,?)");
      for (const car of starterCars) {
        const normalized = normalizeCar(car);
        insert.run(normalized.id, JSON.stringify(normalized), normalized.status);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close() {
    if (this.pool) return this.pool.end();
    this.db.close();
  }
}
