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

function normalizeCar(car) {
  return { ...car, fuel: normalizeFuel(car.fuel) };
}

const legacyDemoPrices = new Map([
  ["bmw-520i", [45990, 5_400_000]],
  ["mercedes-glc", [38950, 6_500_000]],
  ["porsche-macan", [62500, 12_500_000]],
  ["audi-a5", [31900, 5_000_000]],
  ["ford-f150", [54800, null]],
  ["porsche-911", [89900, 21_300_000]],
  ["toyota-camry", [28900, 4_600_000]],
  ["tesla-model-3", [37400, 10_000_000]],
  ["volvo-xc60", [41900, 7_000_000]],
]);

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

    const seeded = this.db.prepare("SELECT value FROM app_meta WHERE key = 'seeded'").get();
    if (!seeded) {
      const { count } = this.db.prepare("SELECT COUNT(*) AS count FROM inventory").get();
      const insert = this.db.prepare(
        "INSERT INTO inventory (id, data_json, status) VALUES (?, ?, ?)",
      );
      transaction(this.db, () => {
        if (count === 0) {
          for (const car of starterCars) {
            const normalizedCar = normalizeCar(car);
            insert.run(normalizedCar.id, JSON.stringify(normalizedCar), normalizedCar.status);
          }
        }
        this.db.prepare("INSERT INTO app_meta (key, value) VALUES ('seeded', 'true')").run();
      });
    }

    const rows = this.db.prepare("SELECT id, data_json, status FROM inventory").all();
    const update = this.db.prepare("UPDATE inventory SET data_json = ?, status = ? WHERE id = ?");
    transaction(this.db, () => {
      for (const row of rows) {
        const previous = JSON.parse(row.data_json);
        const car = { ...normalizeCar(previous), status: row.status };
        const priceUpdate = legacyDemoPrices.get(row.id);
        if (priceUpdate && car.price === priceUpdate[0]) {
          car.price = priceUpdate[1];
          if (row.id === "ford-f150" && car.status === "In Stock") car.status = "Pending";
        }
        if (JSON.stringify(car) !== JSON.stringify(previous) || car.status !== row.status) {
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
