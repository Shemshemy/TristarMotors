// Paste this file's contents into DevTools Console while signed in to the live admin.
// It downloads the inventory and converts every referenced same-site car image to WebP.
void (async () => {
  const origin = location.origin;
  const response = await fetch("/api/cars", { credentials: "same-origin" });
  if (!response.ok) throw new Error(`Inventory export failed (${response.status}). Sign in to the old admin and retry.`);
  const cars = await response.json();
  if (!Array.isArray(cars)) throw new Error("The inventory endpoint did not return a car list.");

  const paths = new Set();
  const collect = (value) => {
    if (typeof value !== "string") return;
    let url;
    try { url = new URL(value, origin); } catch { return; }
    if (url.origin === origin && /^\/images\/cars\/.+\.(?:jpe?g|png|webp)$/i.test(url.pathname)) paths.add(url.pathname);
  };
  for (const car of cars) {
    collect(car.image);
    for (const url of car.gallery || []) collect(url);
    for (const url of car.frames || []) collect(url);
    for (const urls of Object.values(car.galleryByCategory || {})) for (const url of urls || []) collect(url);
  }

  const toBase64 = (buffer) => {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return btoa(binary);
  };
  const media = {};
  for (const path of paths) {
    const image = new Image();
    image.src = path;
    try { await image.decode(); }
    catch { throw new Error(`Could not load car photo for export: ${path}`); }
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error(`Could not process car photo: ${path}`);
    context.drawImage(image, 0, 0);
    const webp = await new Promise((resolve) => canvas.toBlob(resolve, "image/webp", 0.88));
    if (!webp || webp.type !== "image/webp") throw new Error(`This browser could not convert ${path} to WebP.`);
    if (webp.size > 8 * 1024 * 1024) throw new Error(`Converted car photo exceeds 8 MB: ${path}`);
    media[path] = toBase64(await webp.arrayBuffer());
  }

  const exportData = { exportedAt: new Date().toISOString(), sourceOrigin: origin, cars, media };
  const blob = new Blob([JSON.stringify(exportData)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "inventory.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
  console.info(`Downloaded inventory.json with ${cars.length} cars and ${paths.size} WebP photos. Keep it private.`);
})();
