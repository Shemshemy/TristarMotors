import { mkdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

const sourceUrl = new URL(process.env.TRISTAR_SOURCE_URL || "https://tristarmotors.co.ke");
const exportDirectory = resolve(process.argv[2] || "/tmp/tristar-live-export");
const password = process.env.TRISTAR_SOURCE_ADMIN_PASSWORD || process.env.TRISTAR_ADMIN_PASSWORD;
if (!password) throw new Error("Set TRISTAR_SOURCE_ADMIN_PASSWORD in dealer-platform/.env.local to the password accepted by the current live admin.");
await mkdir(join(exportDirectory, "media"), { recursive: true, mode: 0o700 });

const login = await fetch(new URL("/api/auth/login", sourceUrl), {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username: "Allan", password }),
});
if (!login.ok) throw new Error(`Live-site sign-in failed (${login.status}). Set TRISTAR_SOURCE_ADMIN_PASSWORD to the password accepted by the current live admin.`);
const cookieHeader = login.headers.getSetCookie?.()[0] || login.headers.get("set-cookie") || "";
const sessionCookie = cookieHeader.split(";", 1)[0];
if (!sessionCookie) throw new Error("The live site did not return an admin session cookie.");

const inventoryResponse = await fetch(new URL("/api/cars", sourceUrl), { headers: { Cookie: sessionCookie } });
if (!inventoryResponse.ok) throw new Error(`Could not read live inventory (${inventoryResponse.status}).`);
const cars = await inventoryResponse.json();
if (!Array.isArray(cars)) throw new Error("The live inventory response was not a car list.");

const legacyUploadUrls = new Set();
const addLegacyUrl = (value) => {
  if (typeof value !== "string") return;
  let parsed;
  try { parsed = new URL(value, sourceUrl); } catch { return; }
  if (parsed.origin === sourceUrl.origin && parsed.pathname.startsWith("/images/cars/uploads/")) {
    legacyUploadUrls.add(parsed.pathname);
  }
};
for (const car of cars) {
  addLegacyUrl(car.image);
  for (const url of car.gallery || []) addLegacyUrl(url);
  for (const url of car.frames || []) addLegacyUrl(url);
  for (const urls of Object.values(car.galleryByCategory || {})) for (const url of urls || []) addLegacyUrl(url);
}

for (const path of legacyUploadUrls) {
  const name = basename(decodeURIComponent(path));
  if (!name || name === "." || name === "..") throw new Error("An uploaded photo has an invalid filename.");
  const response = await fetch(new URL(path, sourceUrl), {
    headers: { Cookie: sessionCookie, Referer: sourceUrl.href },
  });
  if (!response.ok) throw new Error(`Could not export an uploaded photo (${response.status}): ${name}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 8 * 1024 * 1024) throw new Error(`Uploaded photo exceeds the 8 MB transfer limit: ${name}`);
  await writeFile(join(exportDirectory, "media", name), bytes, { mode: 0o600 });
}

const exportData = {
  exportedAt: new Date().toISOString(),
  sourceOrigin: sourceUrl.origin,
  cars,
};
await writeFile(join(exportDirectory, "inventory.json"), `${JSON.stringify(exportData, null, 2)}\n`, { mode: 0o600 });
console.log(`Exported ${cars.length} inventory records and ${legacyUploadUrls.size} uploaded photos to ${exportDirectory}.`);
console.log("Keep this export private; it can contain VINs and other dealer-only information.");
