import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { starterCars } from "../src/data.js";

export const INVENTORY_STATUSES = ["In Stock", "Pending", "Sold"];

function transaction(database, operation) {
  database.exec("BEGIN IMMEDIATE");
  try {
    operation();
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function normalizeFuel(fuel) {
  return String(fuel).toLowerCase() === "gasoline" ? "Petrol" : fuel;
}

function normalizeDrivetrain(drivetrain) {
  const value = String(drivetrain || "").trim();
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (!normalized) return value;
  if (/4matic/.test(normalized)) return "4MATIC";
  if (/front wheel drive|\bfwd\b/.test(normalized)) return "FWD";
  if (/rear wheel drive|\brwd\b/.test(normalized)) return "RWD";
  if (/all wheel drive|\bawd\b/.test(normalized)) return "AWD";
  return value;
}

function normalizeCar(car) {
  return {
    ...car,
    body: car.body || car.type,
    type: car.type || car.body,
    fuel: normalizeFuel(car.fuel),
    drivetrain: normalizeDrivetrain(car.drivetrain),
  };
}

const obsoleteDemoIds = [
  "bmw-520i", "mercedes-glc", "porsche-macan", "audi-a5", "ford-f150",
  "porsche-911", "toyota-camry", "tesla-model-3", "volvo-xc60",
];


export class InventoryDatabase {
  constructor(filename) {
    mkdirSync(dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS inventory (
        id TEXT PRIMARY KEY,
        data_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('In Stock', 'Pending', 'Sold'))
      );
      CREATE TABLE IF NOT EXISTS app_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    const migrated = this.db.prepare("SELECT value FROM app_meta WHERE key = 'website_inventory_v1'").get();
    if (!migrated) {
      const insert = this.db.prepare("INSERT OR IGNORE INTO inventory (id, data_json, status) VALUES (?, ?, ?)");
      const remove = this.db.prepare("DELETE FROM inventory WHERE id = ?");
      transaction(this.db, () => {
        for (const id of obsoleteDemoIds) remove.run(id);
        for (const car of starterCars) {
          const normalizedCar = normalizeCar(car);
          insert.run(normalizedCar.id, JSON.stringify(normalizedCar), normalizedCar.status);
        }
        this.db.prepare("INSERT INTO app_meta (key, value) VALUES ('website_inventory_v1', 'true')").run();
      });
    }

    const rows = this.db.prepare("SELECT id, data_json, status FROM inventory").all();
    const update = this.db.prepare("UPDATE inventory SET data_json = ?, status = ? WHERE id = ?");
    transaction(this.db, () => {
      for (const row of rows) {
        const previous = JSON.parse(row.data_json);
        const car = { ...normalizeCar(previous), status: row.status };
        if (JSON.stringify(car) !== JSON.stringify(previous)) {
          update.run(JSON.stringify(car), car.status, row.id);
        }
      }
    });
  }

  list() {
    return this.db.prepare("SELECT data_json, status FROM inventory ORDER BY rowid").all()
      .map(({ data_json, status }) => ({ ...normalizeCar(JSON.parse(data_json)), status }));
  }

  get(id) {
    const row = this.db.prepare("SELECT data_json, status FROM inventory WHERE id = ?").get(id);
    return row ? { ...normalizeCar(JSON.parse(row.data_json)), status: row.status } : null;
  }

  save(car) {
    car = normalizeCar(car);
    this.db.prepare(`
      INSERT INTO inventory (id, data_json, status) VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET data_json = excluded.data_json, status = excluded.status
    `).run(car.id, JSON.stringify(car), car.status);
    return this.get(car.id);
  }

  setStatus(id, status) {
    const car = this.get(id);
    if (!car) return null;
    car.status = status;
    return this.save(car);
  }

  remove(id) {
    return this.db.prepare("DELETE FROM inventory WHERE id = ?").run(id).changes > 0;
  }

  reset() {
    const clear = this.db.prepare("DELETE FROM inventory");
    const insert = this.db.prepare(
      "INSERT INTO inventory (id, data_json, status) VALUES (?, ?, ?)",
    );
    transaction(this.db, () => {
      clear.run();
      for (const car of starterCars) {
        const normalizedCar = normalizeCar(car);
        insert.run(normalizedCar.id, JSON.stringify(normalizedCar), normalizedCar.status);
      }
    });
  }

  close() {
    this.db.close();
  }
}
