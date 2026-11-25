import { readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

const exportDirectory = resolve(process.argv[2] || "/tmp/tristar-live-export");
const targetUrl = new URL(process.env.TRISTAR_TARGET_URL || process.env.TRISTAR_SITE_URL || "https://tristarmotors.co.ke");
const password = process.env.TRISTAR_TARGET_ADMIN_PASSWORD || process.env.TRISTAR_ADMIN_PASSWORD;
if (!password) throw new Error("Set TRISTAR_TARGET_ADMIN_PASSWORD in dealer-platform/.env.local to the password configured for the new Render app.");

const exportPath = join(exportDirectory, "inventory.json");
const exportData = JSON.parse(await readFile(exportPath, "utf8"));
if (!Array.isArray(exportData.cars)) throw new Error("The migration export does not contain an inventory list.");
const legacyUploads = new Set();
const collect = (value) => {
  if (typeof value !== "string") return;
  let parsed;
  try { parsed = new URL(value, exportData.sourceOrigin); } catch { return; }
  if (parsed.origin === exportData.sourceOrigin && parsed.pathname.startsWith("/images/cars/uploads/")) legacyUploads.add(parsed.pathname);
};
for (const car of exportData.cars) {
  collect(car.image);
  for (const url of car.gallery || []) collect(url);
  for (const url of car.frames || []) collect(url);
  for (const urls of Object.values(car.galleryByCategory || {})) for (const url of urls || []) collect(url);
}
for (const path of legacyUploads) {
  const name = basename(decodeURIComponent(path));
  try {
    if (typeof exportData.media?.[path] !== "string") await readFile(join(exportDirectory, "media", name));
  }
  catch { throw new Error(`The export is missing uploaded photo ${name}. Re-export before deploying if possible.`); }
}

const login = await fetch(new URL("/api/auth/login", targetUrl), {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username: "Allan", password }),
});
if (!login.ok) throw new Error(`New-site sign-in failed (${login.status}). Set TRISTAR_TARGET_ADMIN_PASSWORD to Render's TRISTAR_ADMIN_PASSWORD.`);
const cookieHeader = login.headers.getSetCookie?.()[0] || login.headers.get("set-cookie") || "";
const sessionCookie = cookieHeader.split(";", 1)[0];
if (!sessionCookie) throw new Error("The new site did not return an admin session cookie.");

const statePath = join(exportDirectory, "import-state.json");
let uploadedUrls = {};
try { uploadedUrls = JSON.parse(await readFile(statePath, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
const request = async (path, options) => {
  const response = await fetch(new URL(path, targetUrl), {
    ...options,
    headers: { ...(options.headers || {}), Cookie: sessionCookie },
  });
  if (response.status === 429) {
    const retrySeconds = Math.max(1, Number(response.headers.get("retry-after") || 2));
    await delay(retrySeconds * 1000);
    return request(path, options);
  }
  if (!response.ok) {
    const details = await response.text();
    throw new Error(`${options.method || "GET"} ${path} failed (${response.status}): ${details.slice(0, 300)}`);
  }
  return response;
};
const categoryFor = (name) => {
  const category = name.toLowerCase().match(/^(front|side|rear|interior|other)(?:-|\.)/i)?.[1]?.toLowerCase();
  return category || "other";
};
let requestCount = 0;
const uploadUrl = async (value) => {
  if (typeof value !== "string") return value;
  let parsed;
  try { parsed = new URL(value, exportData.sourceOrigin); } catch { return value; }
  if (parsed.origin !== exportData.sourceOrigin || !parsed.pathname.startsWith("/images/cars/uploads/")) return value;
  const path = parsed.pathname;
  if (uploadedUrls[path]) return uploadedUrls[path];
  const name = basename(decodeURIComponent(path));
  const embedded = exportData.media?.[path];
  const bytes = typeof embedded === "string"
    ? Buffer.from(embedded, "base64")
    : await readFile(join(exportDirectory, "media", name));
  const response = await request("/api/uploads", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ category: categoryFor(name), contentType: "image/webp", data: bytes.toString("base64") }),
  });
  const result = await response.json();
  uploadedUrls[path] = result.url;
  await writeFile(statePath, `${JSON.stringify(uploadedUrls, null, 2)}\n`, { mode: 0o600 });
  requestCount += 1;
  await delay(1050);
  return result.url;
};

const fields = new Set([
  "id", "year", "make", "model", "trim", "body", "price", "mileage", "transmission", "engine", "fuel", "vin", "status",
  "badges", "image", "gallery", "galleryByCategory", "frames", "frameBase", "class", "type", "chassis", "drivetrain",
  "power", "acceleration", "color", "interior", "condition", "description", "features", "badge", "inspectionPoints",
]);
let imported = 0;
for (const original of exportData.cars) {
  const car = Object.fromEntries(Object.entries(original).filter(([key]) => fields.has(key)));
  car.image = await uploadUrl(car.image);
  car.gallery = await Promise.all((car.gallery || []).map(uploadUrl));
  car.frames = await Promise.all((car.frames || []).map(uploadUrl));
  if (car.galleryByCategory) {
    for (const [category, urls] of Object.entries(car.galleryByCategory)) {
      car.galleryByCategory[category] = await Promise.all((urls || []).map(uploadUrl));
    }
  }
  await request(`/api/cars/${encodeURIComponent(car.id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(car),
  });
  imported += 1;
  requestCount += 1;
  await delay(1050);
}
console.log(`Imported ${imported} inventory records. Reuploaded ${Object.keys(uploadedUrls).length} photos to R2.`);
console.log(`Sent ${requestCount} authenticated changes to ${targetUrl.origin}.`);
