import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createInventoryApi } from "./api.js";
import { InventoryDatabase } from "./inventory.js";

let directory;
let database;
let server;
let baseUrl;
let adminCookie;

async function login(username = "Allan", password = "local-test-password-strong-enough") {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (response.ok) adminCookie = response.headers.get("set-cookie").split(";")[0];
  return response;
}

async function adminFetch(path, options = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { ...(options.headers || {}), Cookie: adminCookie },
  });
}

before(async () => {
  directory = mkdtempSync(join(tmpdir(), "tristar-inventory-"));
  database = new InventoryDatabase(join(directory, "inventory.sqlite"));
  server = createInventoryApi(database, {
    adminPassword: "local-test-password-strong-enough",
    uploadDirectory: join(directory, "uploads"),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const response = await login();
  assert.equal(response.status, 200);
});

after(async () => {
  if (server?.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  database?.close();
  rmSync(directory, { recursive: true, force: true });
});

test("serves seeded vehicles and persists a sold status across database reopen", async () => {
  const response = await fetch(`${baseUrl}/api/cars`);
  assert.equal(response.status, 200);
  const cars = await response.json();
  assert.ok(cars.some((car) => car.id === "c180-avantgarde-2014" && car.status === "In Stock"));
  assert.ok(cars.every((car) => car.fuel !== "Gasoline"));
  assert.equal(cars.find((car) => car.id === "c180-avantgarde-2014").fuel, "Petrol");
  assert.equal(cars.find((car) => car.id === "c180-avantgarde-2014").price, 2_380_000);
  assert.ok(cars.every((car) => ["FWD", "RWD", "AWD", "4MATIC"].includes(car.drivetrain)));

  const statusResponse = await adminFetch("/api/cars/c180-avantgarde-2014/status", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "Sold" }),
  });
  assert.equal(statusResponse.status, 200);
  assert.equal((await statusResponse.json()).status, "Sold");

  const reopened = new InventoryDatabase(join(directory, "inventory.sqlite"));
  assert.equal(reopened.get("c180-avantgarde-2014").status, "Sold");
  reopened.close();
});

test("rejects invalid status and malformed vehicle input", async () => {
  const invalidStatus = await adminFetch("/api/cars/bmw-520i/status", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "Available" }),
  });
  assert.equal(invalidStatus.status, 400);

  const invalidCar = await adminFetch("/api/cars/new-vehicle", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "new-vehicle", make: "Test", model: "Car", price: -1, year: 2020, mileage: 10, status: "In Stock" }),
  });
  assert.equal(invalidCar.status, 400);
});

test("creates, updates, and deletes inventory records", async () => {
  const vehicle = {
    id: "test-roadster", year: 2024, make: "Test", model: "Roadster",
    price: 25000, mileage: 20, fuel: "Gasoline", status: "In Stock", badges: [], gallery: [], frames: [],
  };
  const created = await adminFetch("/api/cars", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(vehicle),
  });
  assert.equal(created.status, 201);
  assert.equal((await created.json()).fuel, "Petrol");

  const updated = await adminFetch("/api/cars/test-roadster", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...vehicle, status: "Pending" }),
  });

  assert.equal((await updated.json()).status, "Pending");

  const deleted = await adminFetch("/api/cars/test-roadster", { method: "DELETE" });
  assert.equal(deleted.status, 200);
  assert.equal((await adminFetch("/api/cars/test-roadster/status", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "Sold" }),
  })).status, 404);
});

test("persists an unpriced vehicle until a cash price is confirmed", async () => {
  const vehicle = {
    id: "price-pending", year: 2024, make: "Test", model: "Pending price",
    price: null, mileage: 10, status: "Pending",
  };
  const created = await adminFetch("/api/cars", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(vehicle),
  });
  assert.equal(created.status, 201);
  assert.equal((await created.json()).price, null);

  const updated = await adminFetch("/api/cars/price-pending", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...vehicle, price: 6_000_000 }),
  });
  assert.equal((await updated.json()).price, 6_000_000);
});

test("restores demonstration inventory on an explicit reset", async () => {
  const reset = await adminFetch("/api/reset", { method: "POST" });
  assert.equal(reset.status, 200);
  const cars = await reset.json();
  assert.equal(cars.length, 8);
  assert.equal(cars.find((car) => car.id === "c180-avantgarde-2014").status, "In Stock");
});

test("does not reseed inventory after the dealer deletes every vehicle", async () => {
  const cars = await (await fetch(`${baseUrl}/api/cars`)).json();
  for (const car of cars) {
    const response = await adminFetch(`/api/cars/${encodeURIComponent(car.id)}`, { method: "DELETE" });
    assert.equal(response.status, 200);
  }
  const reopened = new InventoryDatabase(join(directory, "inventory.sqlite"));
  assert.deepEqual(reopened.list(), []);
  reopened.close();
  await adminFetch("/api/reset", { method: "POST" });
});

test("requires Allan's login before changing inventory and returns a strict HttpOnly session cookie", async () => {
  const session = await fetch(`${baseUrl}/api/auth/session`);
  assert.deepEqual(await session.json(), { configured: true, authenticated: false });

  const denied = await fetch(`${baseUrl}/api/cars/bmw-520i/status`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "Sold" }),
  });
  assert.equal(denied.status, 401);

  assert.equal((await login("Someone else")).status, 401);
  const response = await login();
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie");
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Path=\//);
  assert.equal((await (await fetch(`${baseUrl}/api/auth/session`, { headers: { Cookie: adminCookie } })).json()).authenticated, true);

  const logout = await fetch(`${baseUrl}/api/auth/logout`, { method: "POST", headers: { Cookie: adminCookie } });
  assert.equal(logout.status, 200);
  const oldCookie = adminCookie;
  assert.equal((await (await fetch(`${baseUrl}/api/auth/session`, { headers: { Cookie: oldCookie } })).json()).authenticated, false);
  await login();
});

test("converts uploads to safe categorized WebP paths and rejects untrusted input", async () => {
  const candidatePaths = [
    new URL("../public/images/brand/avatar.webp", import.meta.url),
    new URL("../public/images/body-types/sedan.webp", import.meta.url),
  ];
  const fixture = candidatePaths.map((path) => {
    try { return readFileSync(path); } catch { return null; }
  }).find(Boolean);
  assert.ok(fixture, "expected a local WebP fixture");

  const upload = await adminFetch("/api/uploads", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ category: "front", contentType: "image/webp", data: fixture.toString("base64") }),
  });
  assert.equal(upload.status, 201);
  const result = await upload.json();
  assert.match(result.url, /^\/images\/cars\/uploads\/front-[a-f0-9-]+\.webp$/);
  const uploadedFile = join(directory, "uploads", result.url.split("/").at(-1));
  assert.deepEqual(readFileSync(uploadedFile), fixture);
  assert.equal(readdirSync(join(directory, "uploads")).length, 1);
  const savedCar = await adminFetch("/api/cars", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: "categorized-gallery", year: 2024, make: "Test", model: "Gallery",
      price: 4_000_000, mileage: 1, fuel: "Petrol", status: "In Stock",
      gallery: [result.url], galleryByCategory: { front: [result.url] },
    }),
  });
  assert.equal(savedCar.status, 201);
  assert.deepEqual((await savedCar.json()).galleryByCategory.front, [result.url]);

  const unauthorizedUpload = await fetch(`${baseUrl}/api/uploads`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ category: "front", contentType: "image/webp", data: fixture.toString("base64") }),
  });
  assert.equal(unauthorizedUpload.status, 401);

  const invalid = await adminFetch("/api/uploads", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ category: "front", contentType: "image/webp", data: Buffer.from("not webp").toString("base64") }),
  });
  assert.equal(invalid.status, 400);
});

test("keeps administrator writes disabled until an environment password is configured", async () => {
  const unconfigured = createInventoryApi(database);
  await new Promise((resolve) => unconfigured.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${unconfigured.address().port}`;
  try {
    assert.deepEqual(await (await fetch(`${url}/api/auth/session`)).json(), {
      configured: false,
      authenticated: false,
    });
    const loginResponse = await fetch(`${url}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "Allan", password: "too-short" }),
    });
    assert.equal(loginResponse.status, 503);
    const writeResponse = await fetch(`${url}/api/reset`, { method: "POST" });
    assert.equal(writeResponse.status, 503);
  } finally {
    await new Promise((resolve, reject) => unconfigured.close((error) => error ? reject(error) : resolve()));
  }
});

test("normalizes legacy inventory fields without changing vehicle details", () => {
  const filename = join(directory, "legacy.sqlite");
  const legacyDb = new DatabaseSync(filename);
  legacyDb.exec(`
    CREATE TABLE inventory (
      id TEXT PRIMARY KEY,
      data_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('In Stock', 'Pending', 'Sold'))
    );
    CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  const insert = legacyDb.prepare("INSERT INTO inventory (id, data_json, status) VALUES (?, ?, ?)");
  const legacyCar = { id: "c180-avantgarde-2014", year: 2014, make: "Mercedes-Benz", model: "C180 BlueEFFICIENCY Avantgarde", price: 2_380_000, mileage: 32140, fuel: "Gasoline", type: "Sedan", drivetrain: "Rear-Wheel Drive", status: "In Stock" };
  const legacy4Matic = { ...legacyCar, id: "legacy-4matic", model: "Legacy 4MATIC", drivetrain: "Permanent 4MATIC (3 Diff Locks)" };
  insert.run(legacyCar.id, JSON.stringify(legacyCar), legacyCar.status);
  insert.run(legacy4Matic.id, JSON.stringify(legacy4Matic), legacy4Matic.status);
  legacyDb.prepare("INSERT INTO app_meta (key, value) VALUES ('seeded', 'true')").run();
  legacyDb.close();

  const migrated = new InventoryDatabase(filename);
  assert.equal(migrated.get("c180-avantgarde-2014").price, 2_380_000);
  assert.equal(migrated.get("c180-avantgarde-2014").mileage, 32140);
  assert.equal(migrated.get("c180-avantgarde-2014").fuel, "Petrol");
  assert.equal(migrated.get("c180-avantgarde-2014").body, "Sedan");
  assert.equal(migrated.get("c180-avantgarde-2014").drivetrain, "RWD");
  assert.equal(migrated.get("legacy-4matic").drivetrain, "4MATIC");
  assert.equal(migrated.get("c180-avantgarde-2014").status, "In Stock");
  migrated.close();
});

test("serves the production storefront and persistent uploads without swallowing API 404s", async () => {
  const staticDirectory = join(directory, "production-site");
  const uploadDirectory = join(directory, "production-uploads");
  mkdirSync(join(staticDirectory, "assets"), { recursive: true });
  mkdirSync(uploadDirectory, { recursive: true });
  writeFileSync(join(staticDirectory, "index.html"), "<main>Tristar storefront</main>");
  writeFileSync(join(staticDirectory, "vehicle.html"), "<!doctype html><html><head><title>Vehicle Details</title><meta name=\"description\" content=\"Vehicle details\"></head><body><main>Vehicle Details</main><footer class=\"footer-brand\">Tristar Motors</footer></body></html>");
  writeFileSync(join(staticDirectory, "assets", "app.js"), "console.log('storefront')");
  const uploadedImage = Buffer.from("RIFF-test-WEBP");
  writeFileSync(join(uploadDirectory, "front-example.webp"), uploadedImage);

  const productionServer = createInventoryApi(database, {
    adminPassword: "production-test-password-long-enough",
    uploadDirectory,
    staticDirectory,
    allowRemote: true,
  });
  await new Promise((resolve) => productionServer.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${productionServer.address().port}`;
  try {
    const home = await fetch(url);
    assert.equal(home.status, 200);
    assert.match(await home.text(), /Tristar storefront/);

    const route = await fetch(`${url}/cars/c180-avantgarde-2014`);
    assert.equal(route.status, 200);
    const routeHtml = await route.text();
    assert.match(routeHtml, /2014 Mercedes-Benz C180/);
    assert.match(routeHtml, /footer-brand/);

    const asset = await fetch(`${url}/assets/app.js`);
    assert.equal(asset.headers.get("content-type"), "text/javascript; charset=utf-8");
    assert.match(await asset.text(), /storefront/);

    const image = await fetch(`${url}/images/cars/uploads/front-example.webp`);
    assert.equal(image.headers.get("content-type"), "image/webp");
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), uploadedImage);

    const traversal = await fetch(`${url}/images/cars/uploads/%2e%2e%2finventory.sqlite`);
    assert.equal(traversal.status, 404);
    const loginResponse = await fetch(`${url}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "Allan", password: "production-test-password-long-enough" }),
    });
    assert.equal(loginResponse.status, 200);
    const cookie = loginResponse.headers.get("set-cookie").split(";")[0];
    const missingApi = await fetch(`${url}/api/not-found`, { headers: { Cookie: cookie } });
    assert.equal(missingApi.status, 404);
    assert.deepEqual(await missingApi.json(), { error: "Endpoint not found" });
    assert.equal((await fetch(`${url}/api/health`)).status, 200);
  } finally {
    await new Promise((resolve, reject) => productionServer.close((error) => error ? reject(error) : resolve()));
  }
});
