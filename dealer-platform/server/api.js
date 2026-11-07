import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { AdminAuth } from "./auth.js";
import { INVENTORY_STATUSES } from "./inventory.js";

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const UPLOAD_CATEGORIES = new Set(["front", "side", "rear", "interior", "other"]);
const STATIC_CONTENT_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".pdf", "application/pdf"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".ttf", "font/ttf"],
  [".wasm", "application/wasm"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);
const allowedFields = new Set([
  "id", "year", "make", "model", "trim", "body", "price", "mileage", "transmission",
  "engine", "fuel", "vin", "status", "badges", "image", "gallery", "galleryByCategory", "frames", "frameBase",
  "class", "type", "chassis", "drivetrain", "power", "acceleration", "color", "interior",
  "condition", "description", "features", "badge",
]);

function send(response, status, value) {
  response.writeHead(status, JSON_HEADERS);
  response.end(JSON.stringify(value));
}

async function readJson(request, maxBodyBytes = MAX_BODY_BYTES) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodyBytes) throw Object.assign(new Error("Request body is too large"), { status: 413 });
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("Expected a JSON object");
    return value;
  } catch {
    throw Object.assign(new Error("Request body must be a JSON object"), { status: 400 });
  }
}

function validateCar(value, id) {
  if (Object.keys(value).some((field) => !allowedFields.has(field))) {
    return "Vehicle contains an unsupported field";
  }
  const car = { ...value, id, status: value.status || "In Stock" };
  if (!INVENTORY_STATUSES.includes(car.status)) return "Status must be In Stock, Pending, or Sold";
  if (!Number.isInteger(Number(car.year)) || Number(car.year) < 1980 || Number(car.year) > 2035) return "Year must be between 1980 and 2035";
  if (!String(car.make || "").trim() || !String(car.model || "").trim()) return "Make and model are required";
  if (car.price !== null && (!Number.isFinite(Number(car.price)) || Number(car.price) <= 0)) {
    return "Price must be a positive number or null";
  }
  if (!Number.isFinite(Number(car.mileage)) || Number(car.mileage) < 0) return "Mileage must be zero or greater";
  for (const field of ["badges", "gallery", "frames", "features"]) {
    if (car[field] !== undefined && !Array.isArray(car[field])) return `${field} must be an array`;
  }
  if (car.galleryByCategory !== undefined) {
    if (!car.galleryByCategory || typeof car.galleryByCategory !== "object" || Array.isArray(car.galleryByCategory)) {
      return "galleryByCategory must be an object";
    }
    for (const [category, photos] of Object.entries(car.galleryByCategory)) {
      if (!UPLOAD_CATEGORIES.has(category) || !Array.isArray(photos) ||
          photos.some((photo) => typeof photo !== "string" || photo.length > 2048)) {
        return "galleryByCategory must contain valid categorized image URLs";
      }
    }
  }
  return null;
}

function isLoopback(address = "") {
  return address === "127.0.0.1" || address === "::1" || address.startsWith("::ffff:127.");
}

async function serveStaticFile(request, response, filePath, pathname) {
  let fileInfo;
  try {
    fileInfo = await stat(filePath);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return false;
    throw error;
  }
  if (!fileInfo.isFile()) return false;

  const immutable = pathname.startsWith("/assets/");
  response.writeHead(200, {
    "Content-Type": STATIC_CONTENT_TYPES.get(extname(filePath).toLowerCase()) || "application/octet-stream",
    "Content-Length": fileInfo.size,
    "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    "X-Content-Type-Options": "nosniff",
  });
  if (request.method === "HEAD") {
    response.end();
    return true;
  }
  createReadStream(filePath).pipe(response);
  return true;
}

function staticFilePath(root, pathname) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decodedPath.includes("\0")) return null;
  const rootPath = resolve(root);
  const filePath = resolve(rootPath, `.${decodedPath.startsWith("/") ? decodedPath : `/${decodedPath}`}`);
  return filePath.startsWith(`${rootPath}${sep}`) ? filePath : null;
}

export function createInventoryApi(inventory, {
  adminPassword = process.env.TRISTAR_ADMIN_PASSWORD,
  passwordFilePath,
  uploadDirectory,
  staticDirectory,
  allowRemote = false,
} = {}) {
  const auth = new AdminAuth(adminPassword, { passwordFilePath });
  const configuredSiteUrl = process.env.TRISTAR_SITE_URL?.replace(/\/$/, "");
  const siteOrigin = (request) => {
    if (configuredSiteUrl) return configuredSiteUrl;
    const host = request.headers.host;
    if (!host || !/^[a-z0-9.-]+(?::\d{1,5})?$/i.test(host)) return "https://tristarmotors.co.ke";
    return `${request.headers["x-forwarded-proto"] === "https" ? "https" : "http"}://${host}`;
  };
  const esc = (value = "") => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  const jsonForHtml = (value) => JSON.stringify(value).replace(/</g, "\\u003c");
  const vehiclePage = async (request, response, car, origin) => {
    const title = `${car.year} ${car.make} ${car.model}${car.trim ? ` ${car.trim}` : ""} for Sale in Nairobi | Tristar Motors`;
    const description = `${car.year} ${car.make} ${car.model} for sale in Nairobi for KSh ${Number(car.price).toLocaleString("en-KE")}. ${Number(car.mileage).toLocaleString("en-KE")} km, ${car.status === "In Stock" ? "available" : String(car.status).toLowerCase()}. Contact Tristar Motors to arrange a viewing.`;
    const canonical = `${origin}/cars/${encodeURIComponent(car.id)}`;
    const item = {
      "@context": "https://schema.org", "@type": "Vehicle", name: `${car.year} ${car.make} ${car.model}${car.trim ? ` ${car.trim}` : ""}`,
      brand: { "@type": "Brand", name: car.make }, model: car.model, vehicleModelDate: String(car.year), bodyType: car.body || car.type,
      mileageFromOdometer: { "@type": "QuantitativeValue", value: Number(car.mileage), unitCode: "KMT" }, image: [car.image, ...(car.gallery || [])].filter(Boolean).map((image) => new URL(image, origin).href),
      description: car.description || description, offers: { "@type": "Offer", url: canonical, price: Number(car.price), priceCurrency: "KES", availability: car.status === "In Stock" ? "https://schema.org/InStock" : car.status === "Sold" ? "https://schema.org/SoldOut" : "https://schema.org/LimitedAvailability", itemCondition: "https://schema.org/UsedCondition", seller: { "@type": "AutoDealer", name: "Tristar Motors", address: "La Colline Garden, Masaba Road, Upper Hill, Nairobi, Kenya" } },
    };
    const htmlPath = staticFilePath(staticDirectory, "/vehicle.html");
    const template = await readFile(htmlPath, "utf8");
    const seo = `<link rel="canonical" href="${esc(canonical)}"><meta name="description" content="${esc(description)}"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(description)}"><meta property="og:url" content="${esc(canonical)}"><meta property="og:image" content="${esc(new URL(car.image, origin).href)}"><meta property="og:type" content="product"><script type="application/ld+json">${jsonForHtml(item)}</script>`;
    const summary = `<section class="seo-vehicle-summary"><h1>${esc(title)}</h1><p>${esc(description)}</p><p>Price: KSh ${Number(car.price).toLocaleString("en-KE")} · Mileage: ${Number(car.mileage).toLocaleString("en-KE")} km · ${esc(car.transmission || "")}</p><img src="${esc(new URL(car.image, origin).href)}" alt="${esc(`${car.year} ${car.make} ${car.model} exterior`)}" width="800"><a href="https://wa.me/254734490475">Ask Tristar Motors about this vehicle</a></section>`;
    const html = template.replace(/<title>.*?<\/title>/i, `<title>${esc(title)}</title>`)
      .replace(/<meta name="description"[^>]*>/i, "")
      .replace("</head>", `${seo}</head>`)
      .replace("</main>", `<noscript>${summary}</noscript></main>`);
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" });
    response.end(request.method === "HEAD" ? undefined : html);
  };
  const homePage = async (request, response) => {
    const filePath = staticFilePath(staticDirectory, "/index.html");
    let html = await readFile(filePath, "utf8");
    const cars = inventory.list().filter((car) => car.make === "Mercedes-Benz" && Number(car.price) > 0);
    const content = cars.map((car) => {
      const title = `${car.year} ${car.make} ${car.model}${car.trim ? ` ${car.trim}` : ""}`;
      const href = `/cars/${encodeURIComponent(car.id)}`;
      return `<article><a href="${esc(href)}"><img src="${esc(car.image || "")}" alt="${esc(`${title} exterior`)}" width="480" loading="lazy"><h3>${esc(title)}</h3></a><p>KSh ${Number(car.price).toLocaleString("en-KE")} · ${Number(car.mileage).toLocaleString("en-KE")} km · ${esc(car.status === "In Stock" ? "Available" : car.status)}</p><p>${esc(car.description || "Contact Tristar Motors in Nairobi to arrange a viewing.")}</p></article>`;
    }).join("");
    html = html.replace(/(<div class="car-grid" id="car-grid"[^>]*>)[\s\S]*?(<\/div>)/, `$1${content}$2`);
    html = html.replace("</body>", `<noscript><section><h2>Cars for sale in Nairobi</h2>${content}</section></noscript></body>`);
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" });
    response.end(request.method === "HEAD" ? undefined : html);
  };
  return createServer(async (request, response) => {
    if (!allowRemote && !isLoopback(request.socket.remoteAddress)) {
      send(response, 403, { error: "This local prototype is only available from this computer" });
      return;
    }

    const url = new URL(request.url, "http://127.0.0.1");
    try {
      auth.cleanup();
      if (request.method === "GET" && url.pathname === "/api/auth/session") {
        send(response, 200, { configured: auth.configured, authenticated: auth.isAuthenticated(request) });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/auth/login") {
        if (!auth.configured) {
          send(response, 503, { error: "Set TRISTAR_ADMIN_PASSWORD to a password of at least 12 characters, then restart the app" });
          return;
        }
        const address = request.socket.remoteAddress || "unknown";
        if (!auth.loginAllowed(address)) {
          send(response, 429, { error: "Too many sign-in attempts. Try again in five minutes." });
          return;
        }
        const body = await readJson(request);
        const userMatches = String(body.username || "").toLowerCase() === "allan";
        if (!userMatches || !auth.checkPassword(body.password)) {
          auth.recordFailedLogin(address);
          send(response, 401, { error: "Incorrect administrator name or password" });
          return;
        }
        auth.loginAttempts.delete(address);
        auth.createSession(response);
        send(response, 200, { authenticated: true, username: "Allan" });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/auth/logout") {
        auth.destroySession(request, response);
        send(response, 200, { authenticated: false });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/health") {
        send(response, 200, { ok: true });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/cars") {
        send(response, 200, inventory.list());
        return;
      }
      if (staticDirectory && (request.method === "GET" || request.method === "HEAD") && url.pathname === "/robots.txt") {
        response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" });
        response.end(`User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /#\/admin\nSitemap: ${siteOrigin(request)}/sitemap.xml\n`);
        return;
      }
      if (staticDirectory && (request.method === "GET" || request.method === "HEAD") && url.pathname === "/sitemap.xml") {
        const origin = siteOrigin(request);
        const urls = inventory.list().filter((car) => car.make === "Mercedes-Benz" && Number(car.price) > 0).map((car) => `<url><loc>${esc(origin)}/cars/${encodeURIComponent(car.id)}</loc></url>`).join("");
        const xml = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${esc(origin)}/</loc></url>${urls}</urlset>`;
        response.writeHead(200, { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=300" });
        response.end(request.method === "HEAD" ? undefined : xml);
        return;
      }
      if (staticDirectory && (request.method === "GET" || request.method === "HEAD") && ["/", "/index.html"].includes(url.pathname)) {
        await homePage(request, response);
        return;
      }
      const vehicleRoute = url.pathname.match(/^\/cars\/([^/]+)$/);
      if (staticDirectory && vehicleRoute && (request.method === "GET" || request.method === "HEAD")) {
        let id = "";
        try { id = decodeURIComponent(vehicleRoute[1]); } catch {}
        const car = inventory.get(id);
        if (!car || car.make !== "Mercedes-Benz" || !(Number(car.price) > 0)) {
          response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff" });
          response.end("Vehicle not found");
          return;
        }
        await vehiclePage(request, response, car, siteOrigin(request));
        return;
      }
      if (staticDirectory && !url.pathname.startsWith("/api") &&
          (request.method === "GET" || request.method === "HEAD")) {
        if (url.pathname.startsWith("/images/cars/uploads/") && uploadDirectory) {
          let filename;
          try {
            filename = decodeURIComponent(url.pathname.slice("/images/cars/uploads/".length));
          } catch {
            filename = "";
          }
          if (filename && filename === filename.split(/[\\/]/).at(-1)) {
            const uploadPath = resolve(uploadDirectory, filename);
            if (uploadPath.startsWith(`${resolve(uploadDirectory)}${sep}`) &&
                await serveStaticFile(request, response, uploadPath, url.pathname)) return;
          }
        } else {
          const filePath = staticFilePath(staticDirectory, url.pathname);
          if (filePath && await serveStaticFile(request, response, filePath, url.pathname)) return;
          if (!extname(url.pathname)) {
            const indexPath = join(staticDirectory, "index.html");
            if (await serveStaticFile(request, response, indexPath, "/index.html")) return;
          }
        }
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff" });
        response.end("Not found");
        return;
      }
      if (!auth.configured) {
        send(response, 503, { error: "Administrator access is not configured. Set TRISTAR_ADMIN_PASSWORD and restart the app." });
        return;
      }
      if (!auth.isAuthenticated(request)) {
        send(response, 401, { error: "Administrator sign-in is required" });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/auth/change-password") {
        const body = await readJson(request);
        if (!auth.checkPassword(body.currentPassword)) {
          send(response, 401, { error: "Current password is incorrect" });
          return;
        }
        if (typeof body.newPassword !== "string" || body.newPassword.length < 12 || body.newPassword.length > 1024) {
          send(response, 400, { error: "New password must be between 12 and 1024 characters" });
          return;
        }
        if (auth.checkPassword(body.newPassword)) {
          send(response, 400, { error: "Choose a new password that is different from the current one" });
          return;
        }
        auth.updatePassword(body.newPassword);
        auth.destroySession(request, response);
        send(response, 200, { changed: true });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/reset") {
        inventory.reset();
        send(response, 200, inventory.list());
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/uploads") {
        if (!uploadDirectory) {
          send(response, 503, { error: "The image upload directory is not configured" });
          return;
        }
        const body = await readJson(request, Math.ceil(MAX_UPLOAD_BYTES * 4 / 3) + 32 * 1024);
        if (!UPLOAD_CATEGORIES.has(body.category)) {
          send(response, 400, { error: "Photo category must be Front, Side, Rear, Interior, or Other pictures" });
          return;
        }
        if (body.contentType !== "image/webp" || typeof body.data !== "string" ||
            !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.data)) {
          send(response, 400, { error: "Upload must be a valid WebP image" });
          return;
        }
        const image = Buffer.from(body.data, "base64");
        if (!image.length || image.length > MAX_UPLOAD_BYTES ||
            image.toString("base64") !== body.data ||
            image.toString("ascii", 0, 4) !== "RIFF" ||
            image.toString("ascii", 8, 12) !== "WEBP") {
          send(response, 400, { error: "Upload must be a valid WebP image under 8 MB" });
          return;
        }
        const filename = `${body.category}-${randomUUID()}.webp`;
        await mkdir(uploadDirectory, { recursive: true });
        await writeFile(join(uploadDirectory, filename), image, { flag: "wx" });
        send(response, 201, { url: `/images/cars/uploads/${filename}`, category: body.category });
        return;
      }

      const statusMatch = url.pathname.match(/^\/api\/cars\/([^/]+)\/status$/);
      if (statusMatch && request.method === "PATCH") {
        const id = decodeURIComponent(statusMatch[1]);
        const body = await readJson(request);
        if (!INVENTORY_STATUSES.includes(body.status)) {
          send(response, 400, { error: "Status must be In Stock, Pending, or Sold" });
          return;
        }
        const car = inventory.setStatus(id, body.status);
        send(response, car ? 200 : 404, car || { error: "Vehicle not found" });
        return;
      }

      const itemMatch = url.pathname.match(/^\/api\/cars\/([^/]+)$/);
      if (itemMatch && request.method === "PUT") {
        const id = decodeURIComponent(itemMatch[1]);
        const body = await readJson(request);
        const error = validateCar(body, id);
        if (error) {
          send(response, 400, { error });
          return;
        }
        const car = inventory.save(body.id === id ? body : { ...body, id });
        send(response, 200, car);
        return;
      }
      if (url.pathname === "/api/cars" && request.method === "POST") {
        const body = await readJson(request);
        const id = String(body.id || "").trim();
        if (!id || !/^[a-z0-9][a-z0-9-]*$/.test(id)) {
          send(response, 400, { error: "Vehicle id must use lowercase letters, numbers, and hyphens" });
          return;
        }
        if (inventory.get(id)) {
          send(response, 409, { error: "A vehicle with that id already exists" });
          return;
        }
        const error = validateCar(body, id);
        if (error) {
          send(response, 400, { error });
          return;
        }
        send(response, 201, inventory.save({ ...body, id }));
        return;
      }
      if (itemMatch && request.method === "DELETE") {
        const removed = inventory.remove(decodeURIComponent(itemMatch[1]));
        send(response, removed ? 200 : 404, removed ? { ok: true } : { error: "Vehicle not found" });
        return;
      }
      if (url.pathname.startsWith("/api/")) {
        send(response, 404, { error: "Endpoint not found" });
        return;
      }
      send(response, 404, { error: "Endpoint not found" });
    } catch (error) {
      send(response, error.status || 500, { error: error.status ? error.message : "The local inventory service failed" });
      if (!error.status) console.error("Inventory API error:", error);
    }
  });
}
