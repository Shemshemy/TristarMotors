import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { AdminAuth } from "./auth.js";
import { INVENTORY_STATUSES } from "./inventory.js";
import { RateLimiter, getClientIp } from "./limiter.js";

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
  "condition", "description", "features", "badge", "inspectionPoints", "mainImageManual",
]);

const PUBLIC_CAR_FIELDS = new Set([
  "id", "year", "make", "model", "trim", "body", "price", "mileage", "transmission",
  "engine", "fuel", "status", "badges", "image", "gallery", "galleryByCategory", "frames", "frameBase",
  "class", "type", "chassis", "drivetrain", "power", "acceleration", "color", "interior",
  "condition", "description", "features", "badge", "inspectionPoints",
]);

function publicCar(car) {
  return Object.fromEntries(Object.entries(car).filter(([field]) => PUBLIC_CAR_FIELDS.has(field)));
}

function mainCarImage(car) {
  return car.image || car.galleryByCategory?.front?.[0] || car.gallery?.[0] || "";
}

function hasDisplayablePrice(car) {
  return car.price == null || (Number.isFinite(Number(car.price)) && Number(car.price) >= 0);
}

const DRAFT_FIELDS = new Set(["mediaId", "shortcode", "caption", "date", "permalink", "imageUrls", "parsed", "year", "make", "model", "price", "mileage", "body", "trim"]);
const INSTAGRAM_IMAGE_HOSTS = ["cdninstagram.com", "fbcdn.net", "instagram.com"];

function validInstagramImageUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && INSTAGRAM_IMAGE_HOSTS.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
  } catch { return false; }
}

function validStoredImageUrl(value, objectStorage) {
  if (!objectStorage?.publicBaseUrl || typeof value !== "string") return false;
  try {
    const url = new URL(value);
    const base = new URL(objectStorage.publicBaseUrl);
    const basePath = base.pathname.replace(/\/+$/, "");
    return url.protocol === "https:" && url.origin === base.origin && !url.username && !url.password &&
      url.pathname.startsWith(`${basePath}/cars/`);
  } catch { return false; }
}

async function importInstagramImage(url, objectStorage) {
  if (!validInstagramImageUrl(url)) throw Object.assign(new Error("Instagram image URL is not allowed"), { status: 400 });
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw Object.assign(new Error("Could not download an Instagram image; re-import the post and try again"), { status: 502 });
  const contentType = (response.headers.get("content-type") || "").split(";")[0].toLowerCase();
  const extensions = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp" };
  if (!extensions[contentType]) throw Object.assign(new Error("Instagram image has an unsupported format"), { status: 400 });
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_UPLOAD_BYTES) throw Object.assign(new Error("Instagram image exceeds the 8 MB upload limit"), { status: 413 });
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  if (!bytes.length) throw Object.assign(new Error("Instagram returned an empty image"), { status: 400 });
  const key = `cars/instagram-${randomUUID()}${extensions[contentType]}`;
  return objectStorage.upload(key, bytes, contentType);
}

function send(response, status, value) {
  response.writeHead(status, JSON_HEADERS);
  response.end(JSON.stringify(value));
}

function setSecurityHeaders(response, nonce) {
  response.setHeader("Content-Security-Policy", [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    `script-src 'self' 'wasm-unsafe-eval' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: blob: https:",
    "connect-src 'self'",
  ].join("; "));
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (process.env.NODE_ENV === "production") {
    response.setHeader("Strict-Transport-Security", "max-age=31536000");
  }
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
  if (car.mainImageManual !== undefined && typeof car.mainImageManual !== "boolean") return "mainImageManual must be a boolean";
  const year = Number(car.year);
  if (!String(id).startsWith("instagram-") && (!Number.isInteger(year) || year < 1886 || year > 2035)) return "Year must be between 1886 and 2035";
  if (!String(car.make || "").trim() || !String(car.model || "").trim()) return "Make and model are required";
  if (car.price !== null && (!Number.isFinite(Number(car.price)) || Number(car.price) < 0)) {
    return "Price must be zero or greater, or null";
  }
  if (!Number.isFinite(Number(car.mileage)) || Number(car.mileage) < 0) return "Mileage must be zero or greater";
  for (const field of ["badges", "gallery", "frames", "features", "inspectionPoints"]) {
    if (car[field] !== undefined && !Array.isArray(car[field])) return `${field} must be an array`;
  }
  if (car.inspectionPoints !== undefined && car.inspectionPoints.some((p) => typeof p !== "string" || p.length > 500)) {
    return "inspectionPoints must contain valid strings";
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
  if (process.env.NODE_ENV === "production") {
    const publicBase = process.env.S3_PUBLIC_BASE_URL;
    let allowedPrefix = "";
    try {
      const base = new URL(publicBase);
      allowedPrefix = `${base.origin}${base.pathname.replace(/\/+$/, "")}/`;
    } catch {}
    const imageUrls = [
      car.image,
      ...(car.gallery || []),
      ...(car.frames || []),
      car.frameBase,
      ...Object.values(car.galleryByCategory || {}).flat(),
    ].filter((url) => url !== undefined && url !== null && url !== "");
    if (!allowedPrefix || typeof car.image !== "string" || !car.image || imageUrls.some((value) => {
      if (typeof value !== "string" || value.length > 2048) return true;
      try {
        const url = new URL(value);
        return url.protocol !== "https:" || !url.href.startsWith(allowedPrefix);
      } catch { return true; }
    })) {
      return "Vehicle photos must use public HTTPS URLs from the Cloudflare image domain";
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

  const ext = extname(filePath).toLowerCase();
  if ([".jpg", ".jpeg", ".png", ".webp"].includes(ext)) {
    const referer = request.headers.referer;
    if (referer) {
      try {
        const refererHost = new URL(referer).host;
        const requestHost = request.headers.host;
        const isAllowedOrigin = !requestHost || refererHost === requestHost ||
          refererHost.includes("localhost") || refererHost.includes("127.0.0.1") ||
          refererHost.endsWith("tristarmotors.co.ke") || refererHost.endsWith("onrender.com");
        if (!isAllowedOrigin) {
          response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
          response.end("Hotlinking forbidden");
          return true;
        }
      } catch {}
    }
  }

  const immutable = pathname.startsWith("/assets/");
  response.writeHead(200, {
    "Content-Type": STATIC_CONTENT_TYPES.get(ext) || "application/octet-stream",
    "Content-Length": fileInfo.size,
    "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    "Content-Disposition": "inline",
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
  objectStorage,
  staticDirectory,
  allowRemote = false,
  rateLimiter = new RateLimiter(),
} = {}) {
  const auth = new AdminAuth(adminPassword, { passwordFilePath });
  const approvalProgress = new Map();
  const configuredSiteUrl = process.env.TRISTAR_SITE_URL || process.env.RENDER_EXTERNAL_URL ||
    (process.env.NODE_ENV === "production" ? "https://tristarmotors.co.ke" : "");
  const siteOrigin = (request) => {
    if (configuredSiteUrl) {
      try { return new URL(configuredSiteUrl).origin; } catch { return "https://tristarmotors.co.ke"; }
    }
    const host = request.headers.host;
    if (!host || !/^[a-z0-9.-]+(?::\d{1,5})?$/i.test(host)) return "https://tristarmotors.co.ke";
    return `${request.headers["x-forwarded-proto"] === "https" ? "https" : "http"}://${host}`;
  };
  const esc = (value = "") => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  const jsonForHtml = (value) => JSON.stringify(value).replace(/</g, "\\u003c");
  const vehiclePage = async (request, response, car, origin, nonce) => {
    const title = `${car.year} ${car.make} ${car.model}${car.trim ? ` ${car.trim}` : ""} for Sale in Nairobi | Tristar Motors`;
    const description = `${car.year} ${car.make} ${car.model} for sale in Nairobi. ${car.price == null || Number(car.price) === 0 ? "Ask for price." : `KSh ${Number(car.price).toLocaleString("en-KE")}.`} ${Number(car.mileage) === 0 ? "Inquire about mileage." : `${Number(car.mileage).toLocaleString("en-KE")} km.`} ${car.status === "In Stock" ? "Available" : String(car.status)}. Contact Tristar Motors to arrange a viewing.`;
    const canonical = `${origin}/cars/${encodeURIComponent(car.id)}`;
    const item = {
      "@context": "https://schema.org", "@type": "Vehicle", name: `${car.year} ${car.make} ${car.model}${car.trim ? ` ${car.trim}` : ""}`,
      brand: { "@type": "Brand", name: car.make }, model: car.model, vehicleModelDate: String(car.year), bodyType: car.body || car.type,
      ...(Number(car.mileage) > 0 ? { mileageFromOdometer: { "@type": "QuantitativeValue", value: Number(car.mileage), unitCode: "KMT" } } : {}), image: [mainCarImage(car), ...(car.gallery || [])].filter(Boolean).map((image) => new URL(image, origin).href),
      description: car.description || description, offers: { "@type": "Offer", url: canonical, ...(Number(car.price) > 0 ? { price: Number(car.price), priceCurrency: "KES" } : {}), availability: car.status === "In Stock" ? "https://schema.org/InStock" : car.status === "Sold" ? "https://schema.org/SoldOut" : "https://schema.org/LimitedAvailability", itemCondition: "https://schema.org/UsedCondition", seller: { "@type": "AutoDealer", name: "Tristar Motors", address: { "@type": "PostalAddress", addressLocality: "Nairobi", addressCountry: "KE" }, hasMap: "https://maps.app.goo.gl/BL8tkatuVavFeiKg6" } },
    };
    const htmlPath = staticFilePath(staticDirectory, "/vehicle.html");
    const template = await readFile(htmlPath, "utf8");
    const seo = `<link rel="canonical" href="${esc(canonical)}"><meta name="description" content="${esc(description)}"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(description)}"><meta property="og:url" content="${esc(canonical)}"><meta property="og:image" content="${esc(new URL(mainCarImage(car), origin).href)}"><meta property="og:type" content="product"><script nonce="${nonce}" type="application/ld+json">${jsonForHtml(item)}</script>`;
    let html = template.replace(/<title>.*?<\/title>/i, `<title>${esc(title)}</title>`)
      .replace(/<meta name="description"[^>]*>/i, "")
      .replace("</head>", `${seo}</head>`);
    const setText = (id, value) => {
      const pattern = new RegExp(`(<([a-z][a-z0-9:-]*)\\b[^>]*\\bid="${id}"[^>]*>)[\\s\\S]*?(<\\/\\2>)`, "i");
      html = html.replace(pattern, (_match, opening, _tag, closing) => `${opening}${esc(value)}${closing}`);
    };
    setText("detail-title", `${car.year} ${car.make} ${car.model}${car.trim ? ` ${car.trim}` : ""}`);
    setText("detail-badge", car.badge || "Pre-owned Mercedes-Benz");
    setText("detail-status", car.status === "In Stock" ? "Available for viewing" : car.status);
    setText("detail-price", car.price == null || Number(car.price) === 0 ? "Ask for price" : `KSh ${Number(car.price).toLocaleString("en-KE")}`);
    setText("detail-description", car.description || description);
    setText("detail-mileage", Number(car.mileage) === 0 ? "Inquire about mileage" : `${Number(car.mileage).toLocaleString("en-KE")} km`);
    setText("detail-type", car.body || car.type || "Not listed");
    setText("detail-transmission", car.transmission || "Not listed");
    setText("detail-fuel", car.fuel || "Not listed");
    setText("detail-engine", car.engine || "Not listed");
    setText("detail-drivetrain", car.drivetrain || "Not listed");
    setText("detail-power", car.power || "Not listed");
    setText("detail-acceleration", car.acceleration || "Not listed");
    setText("detail-color", car.color || "Not listed");
    setText("detail-chassis", car.chassis || "Not listed");
    setText("detail-interior", car.interior || "Not listed");
    setText("detail-condition", car.condition || "Pre-owned");
    html = html.replace(/<img id="detail-image"[^>]*>/i,
      `<img id="detail-image" src="${esc(new URL(mainCarImage(car), origin).href)}" alt="${esc(`${car.year} ${car.make} ${car.model} exterior`)}" fetchpriority="high">`);
    const featureList = Array.isArray(car.features) && car.features.length
      ? car.features.map((feature) => `<li>${esc(feature)}</li>`).join("")
      : `<li>Contact us for available vehicle details.</li>`;
    html = html.replace(/(<ul\b[^>]*\bid="detail-features"[^>]*>)[\s\S]*?(<\/ul>)/i, `$1${featureList}$2`);
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" });
    response.end(request.method === "HEAD" ? undefined : html);
  };
  const homePage = async (request, response, nonce) => {
    const filePath = staticFilePath(staticDirectory, "/index.html");
    let html = await readFile(filePath, "utf8");
    const origin = siteOrigin(request);
    const canonical = `${origin}/`;
    const description = "Explore pre-owned Mercedes-Benz cars at Tristar Motors in Nairobi. View available cars, prices and mileage, then contact us to arrange a visit.";
    const dealership = {
      "@context": "https://schema.org",
      "@type": "AutoDealer",
      name: "Tristar Motors",
      url: canonical,
      logo: `${origin}/Logos/tristar-black.png`,
      image: `${origin}/images/cars/g350d_front.jpg`,
      telephone: "+254734490475",
      address: {
        "@type": "PostalAddress",
        addressLocality: "Nairobi",
        addressCountry: "KE",
      },
      hasMap: "https://maps.app.goo.gl/BL8tkatuVavFeiKg6",
      areaServed: { "@type": "City", name: "Nairobi" },
    };
    const homepageSeo = `<meta property="og:url" content="${esc(canonical)}"><script nonce="${nonce}" type="application/ld+json">${jsonForHtml(dealership)}</script>`;
    html = html.replace(/<link rel="canonical" href="[^"]*">/i, `<link rel="canonical" href="${esc(canonical)}">`)
      .replace(/<meta name="description" content="[^"]*">/i, `<meta name="description" content="${esc(description)}">`)
      .replace("</head>", `${homepageSeo}</head>`);
    const cars = (await inventory.list()).filter((car) => car.make === "Mercedes-Benz" && hasDisplayablePrice(car));
    const content = cars.map((car) => {
      const title = `${car.year} ${car.make} ${car.model}${car.trim ? ` ${car.trim}` : ""}`;
      const href = `/cars/${encodeURIComponent(car.id)}`;
      return `<article><a href="${esc(href)}"><img src="${esc(mainCarImage(car))}" alt="${esc(`${title} exterior`)}" width="480" loading="lazy"><h3>${esc(title)}</h3></a><p>${car.price == null || Number(car.price) === 0 ? "Ask for price" : `KSh ${Number(car.price).toLocaleString("en-KE")}`} · ${Number(car.mileage) === 0 ? "Inquire about mileage" : `${Number(car.mileage).toLocaleString("en-KE")} km`} · ${esc(car.status === "In Stock" ? "Available" : car.status)}</p><p>${esc(car.description || "Contact Tristar Motors in Nairobi to arrange a viewing.")}</p></article>`;
    }).join("");
    html = html.replace(/(<div class="car-grid" id="car-grid"[^>]*>)[\s\S]*?(<\/div>)/, `$1${content}$2`);
    html = html.replace("</body>", `<noscript><section><h2>Cars for sale in Nairobi</h2>${content}</section></noscript></body>`);
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" });
    response.end(request.method === "HEAD" ? undefined : html);
  };
  const server = createServer(async (request, response) => {
    const nonce = randomBytes(18).toString("base64");
    setSecurityHeaders(response, nonce);
    if (!allowRemote && !isLoopback(request.socket.remoteAddress)) {
      send(response, 403, { error: "This local prototype is only available from this computer" });
      return;
    }

    const url = new URL(request.url, "http://127.0.0.1");
    const startTime = Date.now();
    if (process.env.NODE_ENV === "production" || process.env.VERBOSE_LOGGING) {
      response.on("finish", () => {
        if (url.pathname !== "/api/health") {
          console.log(`[${new Date().toISOString()}] ${request.method} ${url.pathname} ${response.statusCode} (${Date.now() - startTime}ms)`);
        }
      });
    }

    const clientIp = getClientIp(request);
    const isHealthCheck = url.pathname === "/api/health";
    if (!isHealthCheck && rateLimiter) {
      const isMutation = ["POST", "PUT", "PATCH", "DELETE"].includes(request.method) && url.pathname.startsWith("/api/");
      const limit = isMutation ? rateLimiter.mutationMax : rateLimiter.max;
      const rateStatus = rateLimiter.isAllowed(clientIp, limit);

      response.setHeader("X-RateLimit-Limit", String(limit));
      response.setHeader("X-RateLimit-Remaining", String(rateStatus.remaining));
      response.setHeader("X-RateLimit-Reset", String(Math.ceil(rateStatus.resetTime / 1000)));

      if (!rateStatus.allowed) {
        const retryAfter = Math.max(1, Math.ceil((rateStatus.resetTime - Date.now()) / 1000));
        response.writeHead(429, {
          "Content-Type": "application/json; charset=utf-8",
          "Retry-After": String(retryAfter),
          "X-RateLimit-Limit": String(limit),
          "X-RateLimit-Remaining": "0",
          "X-RateLimit-Reset": String(Math.ceil(rateStatus.resetTime / 1000)),
          "Cache-Control": "no-store",
        });
        response.end(JSON.stringify({ error: "Too many requests. Please slow down and try again shortly." }));
        return;
      }
    }
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
        const address = getClientIp(request);
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
        const cars = await inventory.list();
        send(response, 200, auth.isAuthenticated(request)
          ? cars
          : cars.map(publicCar));
        return;
      }
      if (staticDirectory && (request.method === "GET" || request.method === "HEAD") && url.pathname === "/robots.txt") {
        response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" });
        response.end(`User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /#\/admin\nSitemap: ${siteOrigin(request)}/sitemap.xml\n`);
        return;
      }
      if (staticDirectory && (request.method === "GET" || request.method === "HEAD") && url.pathname === "/sitemap.xml") {
        const origin = siteOrigin(request);
        const urls = (await inventory.list()).filter((car) => car.make === "Mercedes-Benz" && hasDisplayablePrice(car)).map((car) => `<url><loc>${esc(origin)}/cars/${encodeURIComponent(car.id)}</loc></url>`).join("");
        const xml = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${esc(origin)}/</loc></url>${urls}</urlset>`;
        response.writeHead(200, { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=300" });
        response.end(request.method === "HEAD" ? undefined : xml);
        return;
      }
      if (staticDirectory && (request.method === "GET" || request.method === "HEAD") && ["/", "/index.html"].includes(url.pathname)) {
        if (url.pathname === "/index.html") {
          response.writeHead(308, { Location: `/${url.search}`, "Cache-Control": "public, max-age=86400" });
          response.end();
          return;
        }
        await homePage(request, response, nonce);
        return;
      }
      const vehicleRoute = url.pathname.match(/^\/cars\/([^/]+)$/);
      if (staticDirectory && vehicleRoute && (request.method === "GET" || request.method === "HEAD")) {
        let id = "";
        try { id = decodeURIComponent(vehicleRoute[1]); } catch {}
        const car = await inventory.get(id);
        if (!car || car.make !== "Mercedes-Benz" || !hasDisplayablePrice(car)) {
          response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff" });
          response.end("Vehicle not found");
          return;
        }
        await vehiclePage(request, response, car, siteOrigin(request), nonce);
        return;
      }
      if (staticDirectory && !url.pathname.startsWith("/api") &&
          (request.method === "GET" || request.method === "HEAD")) {
        {
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
      if (url.pathname === "/api/instagram/drafts" && request.method === "GET") {
        send(response, 200, await inventory.listInstagramDrafts());
        return;
      }
      if (url.pathname === "/api/instagram/drafts/import" && request.method === "POST") {
        const body = await readJson(request);
        if (!Array.isArray(body.drafts) || body.drafts.length > 100) {
          send(response, 400, { error: "Provide up to 100 Instagram drafts per import" });
          return;
        }
        const drafts = [];
        for (const value of body.drafts) {
          if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((field) => !DRAFT_FIELDS.has(field))) {
            send(response, 400, { error: "Instagram draft contains unsupported fields" });
            return;
          }
          const mediaId = String(value.mediaId || "").trim();
          if (!/^[A-Za-z0-9_-]{1,100}$/.test(mediaId) || !Array.isArray(value.imageUrls) || value.imageUrls.length > 20 ||
              value.imageUrls.some((image) => !validInstagramImageUrl(image)) || typeof value.caption !== "string" || value.caption.length > 20_000) {
            send(response, 400, { error: "Instagram draft has invalid media, caption, or image data" });
            return;
          }
          drafts.push({ ...value, mediaId, imageUrls: value.imageUrls.slice(0, 20) });
        }
        const imported = await inventory.importInstagramDrafts(drafts);
        send(response, 200, { imported, received: drafts.length });
        return;
      }
      const instagramDraftDeleteMatch = url.pathname.match(/^\/api\/instagram\/drafts\/([A-Za-z0-9_-]+)$/);
      if (instagramDraftDeleteMatch && request.method === "DELETE") {
        const deleted = await inventory.deleteInstagramDraft(instagramDraftDeleteMatch[1]);
        send(response, deleted ? 200 : 404, deleted ? { deleted: true } : { error: "Pending Instagram draft not found" });
        return;
      }
      const instagramDraftMatch = url.pathname.match(/^\/api\/instagram\/drafts\/([A-Za-z0-9_-]+)$/);
      if (instagramDraftMatch && request.method === "PATCH") {
        const mediaId = instagramDraftMatch[1];
        const current = await inventory.getInstagramDraft(mediaId);
        if (!current || current.reviewStatus !== "pending") { send(response, 404, { error: "Pending Instagram draft not found" }); return; }
        const body = await readJson(request);
        const values = body.fields;
        const allowed = new Set(["year", "make", "model", "trim", "price", "mileage", "body", "imageUrls", "transmission", "engine", "class", "chassis", "drivetrain", "power", "acceleration", "color", "interior", "condition", "description", "features", "fuel", "vin", "status", "badges"]);
        if (!values || typeof values !== "object" || Array.isArray(values) || Object.keys(values).some((field) => !allowed.has(field))) {
          send(response, 400, { error: "Draft edits contain unsupported fields" });
          return;
        }
        if (values.imageUrls !== undefined && (!Array.isArray(values.imageUrls) || values.imageUrls.length > 20 || values.imageUrls.some((image) => !validInstagramImageUrl(image) && !validStoredImageUrl(image, objectStorage)))) {
          send(response, 400, { error: "Draft images must contain up to 20 Instagram or uploaded vehicle photos" }); return;
        }
        for (const key of ["year", "price", "mileage"]) {
          if (values[key] === "" || values[key] === null) values[key] = null;
          else if (values[key] !== undefined && !Number.isFinite(Number(values[key]))) { send(response, 400, { error: `${key} must be a number` }); return; }
        }
        const updated = await inventory.updateInstagramDraft(mediaId, { ...current, ...values });
        send(response, updated ? 200 : 404, updated || { error: "Pending Instagram draft not found" });
        return;
      }
      const instagramReviewMatch = url.pathname.match(/^\/api\/instagram\/drafts\/([A-Za-z0-9_-]+)\/(approve|reject)$/);
      const instagramApprovalProgressMatch = url.pathname.match(/^\/api\/instagram\/drafts\/([A-Za-z0-9_-]+)\/approval-progress$/);
      if (instagramApprovalProgressMatch && request.method === "GET") {
        const progress = approvalProgress.get(instagramApprovalProgressMatch[1]);
        response.setHeader("Cache-Control", "no-store");
        send(response, 200, progress || { phase: "Preparing approval", percent: 2, complete: 0, total: 0 });
        return;
      }
      if (instagramReviewMatch && request.method === "POST") {
        const [, mediaId, action] = instagramReviewMatch;
        const draft = await inventory.getInstagramDraft(mediaId);
        if (!draft || draft.reviewStatus !== "pending") { send(response, 404, { error: "Pending Instagram draft not found" }); return; }
        if (action === "reject") {
          const rejected = await inventory.setInstagramDraftStatus(mediaId, "rejected");
          send(response, rejected ? 200 : 404, rejected ? { rejected: true } : { error: "Pending Instagram draft not found" });
          return;
        }
        const value = await readJson(request);
        const rawYear = value.car?.year;
        const numericYear = rawYear == null || String(rawYear).trim() === "" ? null : Number(rawYear);
        const car = { ...value.car, id: `instagram-${mediaId.toLowerCase()}`, status: "In Stock", make: String(value.car?.make || "").trim(), model: String(value.car?.model || "").trim(), year: Number.isInteger(numericYear) && numericYear > 0 ? numericYear : null, price: value.car?.price == null ? 0 : Number(value.car.price), mileage: value.car?.mileage == null ? 0 : Number(value.car.mileage), description: String(value.car?.description || draft.caption || "").trim() };
        if (!Number.isFinite(Number(car.price)) || Number(car.price) < 0) { send(response, 400, { error: "Set a valid asking price before publishing this listing" }); return; }
        if (!Array.isArray(draft.imageUrls) || !draft.imageUrls.length) { send(response, 400, { error: "This post has no usable image; edit the listing manually before publishing" }); return; }
        if (await inventory.get(car.id)) { send(response, 409, { error: "This Instagram post already has a vehicle listing" }); return; }
        const total = draft.imageUrls.length;
        let completed = 0;
        approvalProgress.set(mediaId, { phase: "Preparing photos", percent: 5, complete: 0, total });
        const imageUrls = objectStorage?.configured
          ? await Promise.all(draft.imageUrls.map(async (image) => {
            const uploaded = validInstagramImageUrl(image) ? await importInstagramImage(image, objectStorage) : image;
            completed += 1;
            approvalProgress.set(mediaId, { phase: "Copying photos to vehicle storage", percent: 10 + Math.floor(completed / total * 75), complete: completed, total });
            return uploaded;
          }))
          : draft.imageUrls;
        if (!objectStorage?.configured) approvalProgress.set(mediaId, { phase: "Preparing listing", percent: 80, complete: total, total });
        car.image = imageUrls[0];
        car.galleryByCategory = { front: [imageUrls[0]], other: imageUrls.slice(1) };
        car.gallery = imageUrls;
        const error = validateCar(car, car.id);
        if (error) { send(response, 400, { error }); return; }
        const saved = await inventory.save(car);
        approvalProgress.set(mediaId, { phase: "Saving listing", percent: 92, complete: total, total });
        const published = await inventory.setInstagramDraftStatus(mediaId, "published", car.id);
        if (!published) { send(response, 409, { error: "The draft was already reviewed; reload the page to see its current status" }); return; }
        approvalProgress.set(mediaId, { phase: "Approval complete", percent: 100, complete: total, total, done: true });
        const cleanup = setTimeout(() => approvalProgress.delete(mediaId), 60_000);
        cleanup.unref?.();
        send(response, 201, { car: saved, published: true });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/auth/change-password") {
        if (process.env.NODE_ENV === "production") {
          send(response, 409, { error: "The production password is managed by the TRISTAR_ADMIN_PASSWORD environment variable." });
          return;
        }
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
        if (process.env.NODE_ENV === "production") {
          send(response, 404, { error: "Endpoint not found" });
          return;
        }
        await inventory.reset();
        send(response, 200, await inventory.list());
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/uploads") {
        if (!objectStorage?.configured) {
          send(response, 503, { error: "S3-compatible image storage is not configured" });
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
        const imageUrl = await objectStorage.upload(`cars/${filename}`, image);
        send(response, 201, { url: imageUrl, category: body.category });
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
        const car = await inventory.setStatus(id, body.status);
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
        const car = await inventory.save(body.id === id ? body : { ...body, id });
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
        if (await inventory.get(id)) {
          send(response, 409, { error: "A vehicle with that id already exists" });
          return;
        }
        const error = validateCar(body, id);
        if (error) {
          send(response, 400, { error });
          return;
        }
        send(response, 201, await inventory.save({ ...body, id }));
        return;
      }
      if (itemMatch && request.method === "DELETE") {
        const id = decodeURIComponent(itemMatch[1]);
        const car = await inventory.get(id);
        if (!car) { send(response, 404, { error: "Vehicle not found" }); return; }
        await Promise.all([...new Set([car.image, ...(car.gallery || []), ...(car.frames || []), ...Object.values(car.galleryByCategory || {}).flat()])].map((url) => objectStorage?.deleteUrl(url)));
        const removed = await inventory.remove(id);
        send(response, removed ? 200 : 404, removed ? { ok: true } : { error: "Vehicle not found" });
        return;
      }
      if (url.pathname.startsWith("/api/")) {
        send(response, 404, { error: "Endpoint not found" });
        return;
      }
      send(response, 404, { error: "Endpoint not found" });
    } catch (error) {
      const failedApproval = url.pathname.match(/^\/api\/instagram\/drafts\/([A-Za-z0-9_-]+)\/approve$/);
      if (failedApproval) {
        const previous = approvalProgress.get(failedApproval[1]) || {};
        approvalProgress.set(failedApproval[1], { ...previous, phase: "Approval stopped", error: error.status ? error.message : "The inventory service failed", done: true });
        const cleanup = setTimeout(() => approvalProgress.delete(failedApproval[1]), 60_000);
        cleanup.unref?.();
      }
      send(response, error.status || 500, { error: error.status ? error.message : "The local inventory service failed" });
      if (!error.status) console.error("Inventory API error:", error);
    }
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  return server;
}
