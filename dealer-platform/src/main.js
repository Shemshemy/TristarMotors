import { dealer, money, number } from "./data.js";
import { readStore, writeStore, resetDemoStore } from "./store.js";
import { mount360Viewer } from "./viewer.js";
import encodeWebP, { init as initWebP } from "@jsquash/webp/encode";
import webpEncoderWasmUrl from "@jsquash/webp/codec/enc/webp_enc.wasm?url";
import webpEncoderSimdWasmUrl from "@jsquash/webp/codec/enc/webp_enc_simd.wasm?url";
import "./styles.css";

const app = document.querySelector("#app");
let store = readStore();
let currentFilters = { make:"all", model:"all", year:"all", body:"all", maxPrice:"all", maxMileage:"all", availability:"all", fuel:"all", transmission:"all", search:"", saved:false };
let adminTab = "inventory";
let editId = null;
let toastTimer;
let disposeViewer = null;
let searchExpanded = false;
let mobileCategory = "All";
let inventoryLoaded = false;
let adminSession = null;
const photoCategories = [
  ["front", "Front"],
  ["side", "Side"],
  ["rear", "Rear"],
  ["interior", "Interior"],
  ["other", "Other pictures"],
];
let draftGallery = Object.fromEntries(photoCategories.map(([key]) => [key, []]));
let pendingPhotoFiles = Object.fromEntries(photoCategories.map(([key]) => [key, []]));
let uploadInProgress = false;
let photoUploadMessage = "Review previews before uploading. New photos are added without removing existing gallery images.";
let webpEncoderPromise;

const escapeHTML = (value="") => String(value).replace(/[&<>"']/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));
const route = () => location.hash || "#/";
const carById = (id) => store.cars.find((car) => car.id === id);
const listedCars = () => store.cars.filter((car) => Number.isFinite(Number(car.price)) && Number(car.price) > 0);
const priceLabel = (price) => price == null ? "Price on request" : money(price);
const statusLabel = (status) => status === "In Stock" ? "Available" : status;
const statusClass = (status) => status === "In Stock" ? "available" : status.toLowerCase();
async function apiRequest(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: options.body ? { "Content-Type": "application/json", ...options.headers } : options.headers,
  });
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error(`Inventory service returned an invalid response (${response.status})`);
  }
  if (!response.ok) throw new Error(result.error || `Inventory service request failed (${response.status})`);
  return result;
}
async function refreshInventory() {
  store.cars = await apiRequest("/api/cars");
  inventoryLoaded = true;
}
const distinctTrim = (car) => {
  const modelWords = new Set(String(car.model || "").toLowerCase().match(/[a-z0-9]+/g) || []);
  return String(car.trim || "").match(/[a-z0-9]+/gi)?.filter((word) => !modelWords.has(word.toLowerCase())).join(" ") || "";
};
const visibleCars = () => listedCars().filter((car) => {
  const f = currentFilters;
  const inMobileCategory = mobileCategory === "All" ||
    (mobileCategory === "SUV" && car.body === "SUV") ||
    (mobileCategory === "Sports" && (car.body === "Coupe" || ["Porsche","Audi","Tesla"].includes(car.make))) ||
    (mobileCategory === "Luxury" && ["Mercedes-Benz","BMW","Porsche","Audi","Tesla","Volvo"].includes(car.make));
  const availabilityMatches = f.availability === "all" ||
    (f.availability === "Available" && car.status === "In Stock") ||
    (f.availability === "Not available" && car.status !== "In Stock") ||
    car.status === f.availability;
  return inMobileCategory &&
    (f.make === "all" || car.make === f.make) && (f.model === "all" || car.model === f.model) &&
    (f.year === "all" || String(car.year) === f.year) && (f.body === "all" || car.body === f.body) &&
    availabilityMatches && (f.fuel === "all" || car.fuel === f.fuel) &&
    (f.transmission === "all" || car.transmission === f.transmission) &&
    (f.maxPrice === "all" || Number(car.price) <= Number(f.maxPrice)) &&
    (f.maxMileage === "all" || Number(car.mileage) <= Number(f.maxMileage)) &&
    (!f.search || `${car.year} ${car.make} ${car.model} ${car.trim} ${car.body}`.toLowerCase().includes(f.search.toLowerCase())) &&
    (!f.saved || store.favorites.includes(car.id));
});

function toast(message) {
  document.querySelector(".toast")?.remove();
  const node = document.createElement("div");
  node.className = "toast"; node.setAttribute("role","status"); node.textContent = message;
  document.body.append(node); clearTimeout(toastTimer); toastTimer = setTimeout(() => node.remove(), 2800);
}
function save() { if (!writeStore(store)) toast("Could not save in this browser. Check storage settings."); }
function waLink(car, message) {
  const text = message || (car ? `Hi ${dealer.name}, I'm interested in the ${car.year} ${car.make} ${car.model} (VIN ${car.vin}).` : `Hi ${dealer.name}, I'm interested in your inventory.`);
  return `https://wa.me/${dealer.whatsapp}?text=${encodeURIComponent(text)}`;
}
function vehicleDescription(car) {
  const trim = distinctTrim(car);
  const name = `${car.year} ${car.make} ${car.model}${trim ? ` ${trim}` : ""}`;
  return `This ${name} has ${number(car.mileage)} miles, a ${car.engine} ${car.fuel.toLowerCase()} engine, and a ${car.transmission.toLowerCase()} transmission.`;
}
function header() {
  const currentRoute = route();
  const isVehiclePage = currentRoute.startsWith("#/cars/");
  const isAdminPage = currentRoute.startsWith("#/admin");
  return `<header class="site-header"><div class="shell header-main"><a class="logo" href="#/" aria-label="Tristar Motors home"><img src="/images/brand/tristarmotors.png" alt="Tristar Motors"></a>
    <nav class="nav-links" id="main-nav" aria-label="Main navigation"><a href="#/" data-scroll="inventory" class="${isAdminPage?"":"active"}" ${isAdminPage?"":"aria-current=\"page\""}>Inventory</a><a href="#/" data-scroll="location">Visit us</a></nav>
    <div class="header-contact"><a class="phone-link" href="tel:+${dealer.whatsapp}">${dealer.phone}<small>Call our sales team</small></a><a class="map-shortcut" href="https://maps.google.com/?q=${encodeURIComponent(dealer.address)}" target="_blank" rel="noopener">⌖ <span>Directions<small>Upper Hill</small></span></a>${isVehiclePage?"":`<button class="app-icon desktop-favorite" data-saved-view="true" aria-label="Show saved cars">♡<span>${store.favorites.length}</span></button>`}<a class="whatsapp" href="${waLink()}" target="_blank" rel="noopener"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.2 11.7a8.2 8.2 0 0 1-12.1 7.2L3 20l1.2-4.9a8.2 8.2 0 1 1 16-3.4Z"/><path d="M8.2 8.1c.3-.6.7-.6 1-.6h.5c.2 0 .4.1.5.4l.7 1.7c.1.2.1.4-.1.6l-.5.6c-.2.2-.2.4 0 .6.4.7 1.1 1.4 1.8 1.8.2.1.4.1.6-.1l.7-.8c.2-.2.4-.2.6-.1l1.6.8c.3.1.4.3.4.5 0 .3-.2 1.2-.8 1.6-.6.5-1.3.7-2.1.5-1-.2-2.3-.8-3.6-2-1.1-1-1.9-2.3-2.1-3.2-.3-.9 0-1.8.8-2.3Z"/></svg><span>WhatsApp us</span></a></div></div>
    <div class="mobile-welcome"><a class="mobile-brand" href="#/" aria-label="Tristar Motors home"><img src="/images/brand/tristarmotors.png" alt="Tristar Motors"></a><a class="mobile-header-browse" href="#/" data-scroll="inventory">Browse cars <span aria-hidden="true">→</span></a><a class="mobile-header-contact" href="${waLink()}" target="_blank" rel="noopener" aria-label="Message Tristar Motors on WhatsApp"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.2 11.7a8.2 8.2 0 0 1-12.1 7.2L3 20l1.2-4.9a8.2 8.2 0 1 1 16-3.4Z"/><path d="M8.2 8.1c.3-.6.7-.6 1-.6h.5c.2 0 .4.1.5.4l.7 1.7c.1.2.1.4-.1.6l-.5.6c-.2.2-.2.4 0 .6.4.7 1.1 1.4 1.8 1.8.2.1.4.1.6-.1l.7-.8c.2-.2.4-.2.6-.1l1.6.8c.3.1.4.3.4.5 0 .3-.2 1.2-.8 1.6-.6.5-1.3.7-2.1.5-1-.2-2.3-.8-3.6-2-1.1-1-1.9-2.3-2.1-3.2-.3-.9 0-1.8.8-2.3Z"/></svg><span>WhatsApp</span></a></div></header>`;
}
function footer() {
  return `<footer class="site-footer"><div class="shell"><div class="footer-top"><div class="footer-brand"><img src="/images/brand/tristarmotors.png" alt="Tristar Motors"><p>${escapeHTML(dealer.tagline)}</p></div><div class="footer-col"><strong>Explore</strong><a href="#/">Shop inventory</a></div><div class="footer-col"><strong>Contact</strong><a href="tel:+${dealer.whatsapp}">${dealer.phone}</a><a target="_blank" rel="noopener" href="https://maps.google.com/?q=${encodeURIComponent(dealer.address)}">${dealer.address}</a></div><div class="footer-col"><strong>Visit Tristar</strong><span>${dealer.hours}</span><a target="_blank" rel="noopener" href="https://maps.google.com/?q=${encodeURIComponent(dealer.address)}">Directions ↗</a><a href="${waLink()}" target="_blank" rel="noopener">WhatsApp us</a></div></div><div class="footer-bottom"><span>© ${new Date().getFullYear()} Tristar Motors</span><span>${escapeHTML(dealer.priceTagline)}</span></div></div></footer>`;
}
function selectOptions(values, selected, label) {
  return `<option value="all">${label}</option>` + values.map(v => `<option value="${escapeHTML(v)}" ${String(v)===String(selected)?"selected":""}>${escapeHTML(v)}</option>`).join("");
}
function priceFilterOptions() {
  const values = [5_000_000, 8_000_000, 12_000_000, 18_000_000, 25_000_000];
  return `<option value="all">No max</option>${values.map(value => `<option value="${value}" ${String(value)===String(currentFilters.maxPrice)?"selected":""}>${money(value)}</option>`).join("")}`;
}
function emptyDraftGallery() {
  return Object.fromEntries(photoCategories.map(([key]) => [key, []]));
}
function readDraftGallery(car) {
  const grouped = car?.galleryByCategory;
  if (grouped && typeof grouped === "object") {
    return Object.fromEntries(photoCategories.map(([key]) => [key, Array.isArray(grouped[key]) ? [...grouped[key]] : []]));
  }
  return { ...emptyDraftGallery(), other: [...(car?.gallery || [])] };
}
function renderGalleryUploadWorkspace() {
  const root = document.querySelector("#gallery-upload-workspace");
  if (!root) return;
  root.innerHTML = `${photoCategories.map(([key, label]) => {
    const saved = draftGallery[key] || [];
    const pending = pendingPhotoFiles[key] || [];
    return `<section class="photo-category"><div class="photo-category-heading"><h3>${label}</h3><span>${saved.length} uploaded · ${pending.length} selected</span></div><label class="photo-file-picker"><span>Select ${label.toLowerCase()}</span><input type="file" accept="image/*" multiple data-photo-category="${key}" aria-label="Select ${label} vehicle pictures" ${uploadInProgress ? "disabled" : ""}></label><div class="photo-preview-grid">${saved.map((url, index) => `<figure class="photo-preview saved"><img src="${escapeHTML(url)}" alt="${label} vehicle view ${index + 1}" loading="lazy"><figcaption>Uploaded</figcaption>${key === "front" ? `<button type="button" class="photo-use-main" data-use-main="${escapeHTML(url)}">Use as main picture</button>` : ""}</figure>`).join("")}${pending.map((photo, index) => `<figure class="photo-preview"><img src="${photo.preview}" alt="Preview of ${escapeHTML(photo.file.name)}"><figcaption>${escapeHTML(photo.file.name)} · preview</figcaption><button type="button" class="photo-remove-pending" data-remove-photo="${key}" data-photo-index="${index}" aria-label="Remove ${escapeHTML(photo.file.name)} from selection">Remove</button></figure>`).join("")}</div></section>`;
  }).join("")}<div class="photo-upload-actions"><button class="btn btn-light" type="button" data-action="upload-photos" ${uploadInProgress || !photoCategories.some(([key]) => pendingPhotoFiles[key].length) ? "disabled" : ""}>${uploadInProgress ? "Converting and uploading…" : "Convert previews to WebP & upload"}</button><p class="photo-upload-status" id="photo-upload-status" role="status">Review previews before uploading. New photos are added without removing existing gallery images.</p></div>`;
  const statusNode = root.querySelector("#photo-upload-status");
  if (statusNode) statusNode.textContent = photoUploadMessage;
  root.querySelectorAll("[data-photo-category]").forEach((input) => input.addEventListener("change", () => {
    const category = input.dataset.photoCategory;
    for (const photo of pendingPhotoFiles[category]) URL.revokeObjectURL(photo.preview);
    pendingPhotoFiles[category].push(...[...input.files].map((file) => ({ file, preview: URL.createObjectURL(file) })));
    renderGalleryUploadWorkspace();
  }));
  root.querySelectorAll("[data-remove-photo]").forEach((button) => button.addEventListener("click", () => {
    const category = button.dataset.removePhoto;
    const [photo] = pendingPhotoFiles[category].splice(Number(button.dataset.photoIndex), 1);
    if (photo) URL.revokeObjectURL(photo.preview);
    renderGalleryUploadWorkspace();
  }));
}
async function convertToWebP(file) {
  if (!file.type.startsWith("image/")) throw new Error(`${file.name}: select an image file`);
  if (file.size > 20 * 1024 * 1024) throw new Error(`${file.name}: file must be 20 MB or smaller`);
  const bitmap = await createImageBitmap(file);
  try {
    if (bitmap.width > 8000 || bitmap.height > 8000) throw new Error(`${file.name}: image dimensions must be 8000 × 8000 pixels or smaller`);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error(`${file.name}: this browser could not prepare the image`);
    context.drawImage(bitmap, 0, 0);
    if (!webpEncoderPromise) {
      webpEncoderPromise = initWebP({
        locateFile: (path) => path.includes("_simd") ? webpEncoderSimdWasmUrl : webpEncoderWasmUrl,
      }).catch((error) => {
        webpEncoderPromise = null;
        throw error;
      });
    }
    await webpEncoderPromise;
    const encoded = await encodeWebP(context.getImageData(0, 0, bitmap.width, bitmap.height), { quality: 88 });
    if (encoded.byteLength > 8 * 1024 * 1024) throw new Error(`${file.name}: converted image exceeds the 8 MB upload limit`);
    const bytes = new Uint8Array(encoded);
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
  } finally {
    bitmap.close();
  }
}
async function uploadSelectedPhotos() {
  if (uploadInProgress) return;
  uploadInProgress = true;
  photoUploadMessage = "Preparing selected images…";
  renderGalleryUploadWorkspace();
  const status = (message) => {
    photoUploadMessage = message;
    const node = document.querySelector("#photo-upload-status");
    if (node) node.textContent = photoUploadMessage;
  };
  let uploadedCount = 0;
  let frontAssigned = false;
  try {
    for (const [category] of photoCategories) {
      while (pendingPhotoFiles[category].length) {
        const [photo] = pendingPhotoFiles[category];
        status(`Converting and uploading ${photo.file.name}…`);
        const data = await convertToWebP(photo.file);
        const uploaded = await apiRequest("/api/uploads", {
          method: "POST",
          body: JSON.stringify({ category, contentType: "image/webp", data }),
        });
        draftGallery[category].push(uploaded.url);
        pendingPhotoFiles[category].shift();
        URL.revokeObjectURL(photo.preview);
        if (category === "front" && !frontAssigned) {
          const mainImage = document.querySelector('#car-form [name="image"]');
          if (mainImage) mainImage.value = uploaded.url;
          frontAssigned = true;
        }
        uploadedCount += 1;
        renderGalleryUploadWorkspace();
      }
    }
    status(`${uploadedCount} ${uploadedCount === 1 ? "photo" : "photos"} converted to WebP and uploaded.`);
  } catch (error) {
    status(`Upload stopped: ${error.message}. Unfinished selections remain available to retry.`);
  } finally {
    uploadInProgress = false;
    renderGalleryUploadWorkspace();
    if (uploadedCount > 0 && !photoUploadMessage.startsWith("Upload stopped:")) {
      status(`${uploadedCount} ${uploadedCount === 1 ? "photo" : "photos"} converted to WebP and uploaded. Existing photos were kept.`);
    }
  }
}
function card(car) {
  const saved = store.favorites.includes(car.id);
  const trim = distinctTrim(car);
  return `<article class="car-card"><div class="car-photo"><a href="#/cars/${encodeURIComponent(car.id)}" aria-label="View ${car.year} ${escapeHTML(car.make)} ${escapeHTML(car.model)}"><img src="${escapeHTML(car.image)}" alt="${car.year} ${escapeHTML(car.make)} ${escapeHTML(car.model)}" loading="lazy" onerror="this.onerror=null;this.src='https://images.unsplash.com/photo-1492144534655-ae79c964c9d7?auto=format&fit=crop&w=1000&q=80'"></a><div class="badge-row"><span class="availability-badge ${statusClass(car.status)}">${escapeHTML(statusLabel(car.status))}</span>${(car.badges||[]).map(b=>`<span class="badge ${b==="Great Deal"?"good":""}">${escapeHTML(b)}</span>`).join("")}</div><button type="button" class="favorite ${saved?"active":""}" data-favorite="${escapeHTML(car.id)}" aria-label="${saved?"Remove saved vehicle":"Save vehicle"}" aria-pressed="${saved}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.8 8.8c0 5.1-8.8 10-8.8 10s-8.8-4.9-8.8-10A4.7 4.7 0 0 1 12 6.4a4.7 4.7 0 0 1 8.8 2.4Z"/></svg></button></div><div class="car-body"><div class="car-heading"><p class="car-eyebrow">${escapeHTML(car.year)} <span aria-hidden="true">·</span> ${escapeHTML(car.body)}</p><h3 class="car-title">${escapeHTML(car.make)} ${escapeHTML(car.model)}</h3><p class="car-subtitle">${trim?`${escapeHTML(trim)} · `:""}${escapeHTML(car.transmission)}</p></div><div class="car-price-location"><strong class="car-price">${priceLabel(car.price)}</strong><span class="car-location" title="${escapeHTML(dealer.address)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/></svg><span>${escapeHTML(dealer.address)}</span></span></div><div class="car-spec-row"><span><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="13" r="8"/><path d="M12 13 16 9M8 3h8"/></svg>${number(car.mileage)} mi</span><span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v15M3 20h16M8 7h6v5H8zM18 9h2l2 3v5h-4"/></svg>${escapeHTML(car.engine)}</span><span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h8v18H5V5a2 2 0 0 1 2-2ZM7 7h6v5H7zM15 8h3l2 2v6a2 2 0 0 0 4 0v-4"/></svg>${escapeHTML(car.fuel)}</span></div><div class="card-actions"><a class="btn btn-dark" href="#/cars/${encodeURIComponent(car.id)}">View details <span aria-hidden="true">→</span></a><a class="btn btn-light" href="${waLink(car)}" target="_blank" rel="noopener" aria-label="Ask about this vehicle on WhatsApp">WhatsApp</a></div></div></article>`;
}
function renderHome() {
  disposeViewer?.(); disposeViewer=null;
  const makes=[...new Set(listedCars().map(c=>c.make))].sort();
  const fuels=[...new Set([...store.cars.map(c=>c.fuel).filter(Boolean),"Diesel"])].sort();
  const transmissions=[...new Set(store.cars.map(c=>c.transmission).filter(Boolean))].sort();
  const models=[...new Set(listedCars().filter(c=>currentFilters.make==="all"||c.make===currentFilters.make).map(c=>c.model))].sort();
  const years=[...new Set(listedCars().map(c=>c.year))].sort((a,b)=>b-a);
  const filtered=visibleCars();
  const bodyTypes=[
    {label:"All",value:"all",icon:"<path d='M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z'/>"},
    {label:"Sedans",value:"Sedan",image:"/images/body-types/sedan.webp"},
    {label:"Coupes",value:"Coupe",image:"/images/body-types/coupe.webp"},
    {label:"SUVs",value:"SUV",image:"/images/body-types/suv.webp"},
    {label:"Roadsters",value:"Roadster",image:"/images/body-types/roadster.webp"},
    {label:"Wagons",value:"Wagon",image:"/images/body-types/wagon.webp"},
    {label:"Trucks",value:"Truck",icon:"<path d='M3 7h11v10H3zM14 10h4l3 3v4h-7z'/><circle cx='7' cy='18' r='1.5'/><circle cx='18' cy='18' r='1.5'/>"},
  ];
  const bodyTypePill=({label,value,image,icon})=>{
    const count=value==="all"?listedCars().length:listedCars().filter(car=>car.body===value).length;
    return `<button type="button" class="body-type-pill ${currentFilters.body===value?"selected":""}" data-body-type="${escapeHTML(value)}" aria-pressed="${currentFilters.body===value}"><span class="body-type-pill-icon">${image?`<img src="${image}" alt="" loading="eager" decoding="async">`:`<svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg>`}</span><span class="body-type-pill-copy"><strong>${escapeHTML(label)}</strong><small>${count} ${count===1?"car":"cars"}</small></span></button>`;
  };
  const categoryIcon=(category)=>({
    All:"<path d='M3 13 5 7h14l2 6v6h-3v-2H6v2H3z'/><path d='M5 13h14M7 16h.01M17 16h.01'/>",
    Sports:"<path d='m3 15 2-5h4l3-4h5l4 5 1 4v3h-3v-2H7v2H4z'/><path d='M9 10h8M7 15h.01m10 0h.01'/>",
    SUV:"<path d='M3 14 5 8h14l2 6v5h-3v-2H6v2H3z'/><path d='M7 8v6m10-6v6M5 14h14'/>",
    Luxury:"<path d='m12 3 2.4 5 5.6.8-4 3.9.9 5.5-4.9-2.6-4.9 2.6.9-5.5-4-3.9 5.6-.8z'/>",
  }[category]||"");
  app.innerHTML=`${header()}<main class="app-home">
    <section class="shell app-search-section"><form id="home-search" class="app-search-form"><div class="app-search"><span class="search-symbol" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="10.8" cy="10.8" r="6.8"></circle><path d="m16 16 4.2 4.2"></path></svg></span><input name="search" type="search" value="${escapeHTML(currentFilters.search)}" placeholder="Search cars, makes, models…" aria-label="Search cars"><button class="search-filter-button" type="button" data-action="toggle-search-filters" aria-label="Show search filters"><svg viewBox="0 0 24 24"><path d="M4 7h7m4 0h5M4 17h3m4 0h9"></path><circle cx="13" cy="7" r="2"></circle><circle cx="9" cy="17" r="2"></circle></svg></button></div>
      <div class="advanced-search ${searchExpanded?"expanded":""}" id="advanced-search"><div class="field"><label for="hero-make">Make</label><select id="hero-make" name="make">${selectOptions(makes,currentFilters.make,"Any make")}</select></div><div class="field"><label for="hero-model">Model</label><select id="hero-model" name="model">${selectOptions(models,currentFilters.model,"Any model")}</select></div><div class="field"><label for="hero-year">Year</label><select id="hero-year" name="year">${selectOptions(years,currentFilters.year,"Any year")}</select></div><div class="field"><label for="hero-body">Body style</label><select id="hero-body" name="body">${selectOptions(["SUV","Sedan","Truck","Coupe","Roadster","Wagon"],currentFilters.body,"Any style")}</select></div><div class="field"><label for="hero-price">Max price</label><select id="hero-price" name="maxPrice">${priceFilterOptions()}</select></div><div class="field"><label for="hero-mileage">Max mileage</label><select id="hero-mileage" name="maxMileage">${selectOptions([25000,50000,75000,100000].map(String),currentFilters.maxMileage,"Any mileage")}</select></div><button class="btn btn-dark" type="submit">Apply filters <span>→</span></button></div></form>
      <nav class="mobile-category-rail" aria-label="Browse vehicle categories">${["All","Sports","SUV","Luxury"].map(category=>`<button type="button" class="mobile-category ${mobileCategory===category?"active":""}" data-mobile-category="${category}" aria-pressed="${mobileCategory===category}"><svg viewBox="0 0 24 24" aria-hidden="true">${categoryIcon(category)}</svg>${category}</button>`).join("")}</nav>
      <div class="app-offer-heading"><h2>Discover Tristar Motors</h2><a href="#/" data-scroll="inventory">Browse cars</a></div><div class="offer-rail"><a href="#/" data-scroll="inventory" class="offer-card offer-card-link" aria-label="Browse Tristar Motors vehicles"><div class="offer-copy offer-copy-promo"><span>TRISTAR MOTORS</span><strong>${escapeHTML(dealer.tagline)}</strong><p>${escapeHTML(dealer.priceTagline)}</p><small class="offer-shop">Explore vehicles <b>→</b></small></div><img src="/images/brand/mercedes-26140.webp" alt="Mercedes-Benz at Tristar Motors" loading="eager"></a><article class="offer-card offer-card-secondary"><div class="offer-copy"><span>UPPER HILL · NAIROBI</span><strong>Viewing by appointment.</strong><p>${escapeHTML(dealer.address)}</p><a href="${waLink(undefined, `Hi ${dealer.name}, I'd like to arrange an appointment to view your vehicles.`)}" target="_blank" rel="noopener">Arrange a viewing <b>→</b></a></div><div class="offer-art" aria-hidden="true">↗</div></article></div><div class="offer-dots" aria-hidden="true"><i class="active"></i><i></i></div>
    </section>
    <section class="shell brand-section body-type-section"><div class="app-section-heading"><h2>Browse by vehicle type</h2><button class="plain-link" type="button" data-body-type="all">See all vehicles</button></div><div class="body-type-options" aria-label="Filter inventory by vehicle type">${bodyTypes.map(bodyTypePill).join("")}</div></section>
    <section class="shell section app-inventory" id="inventory"><div class="app-section-heading deals-heading"><h2><span class="desktop-section-title">Top Deals</span><span class="mobile-section-title">Popular Cars</span></h2><span class="results-meta"><strong>${filtered.length}</strong> cars</span><a class="inventory-seeall" href="#/" data-scroll="inventory">See all <b>→</b></a></div><div class="inventory-filter-grid" aria-label="Filter inventory"><label class="inventory-filter"><span>Availability</span><select data-filter="availability" aria-label="Filter by availability"><option value="all" ${currentFilters.availability==="all"?"selected":""}>Any availability</option><option value="Available" ${currentFilters.availability==="Available"?"selected":""}>Available</option><option value="Not available" ${currentFilters.availability==="Not available"?"selected":""}>Not available</option><option value="Pending" ${currentFilters.availability==="Pending"?"selected":""}>Pending</option><option value="Sold" ${currentFilters.availability==="Sold"?"selected":""}>Sold</option></select></label><label class="inventory-filter"><span>Fuel</span><select data-filter="fuel" aria-label="Filter by fuel">${selectOptions(fuels,currentFilters.fuel,"Any fuel")}</select></label><label class="inventory-filter"><span>Vehicle type</span><select data-filter="body" aria-label="Filter by vehicle type">${selectOptions(["SUV","Sedan","Truck","Coupe","Roadster","Wagon"],currentFilters.body,"Any type")}</select></label><label class="inventory-filter"><span>Transmission</span><select data-filter="transmission" aria-label="Filter by transmission">${selectOptions(transmissions,currentFilters.transmission,"Any transmission")}</select></label><label class="inventory-filter"><span>Make</span><select data-filter="make" aria-label="Filter by make">${selectOptions(makes,currentFilters.make,"Any make")}</select></label></div><div class="car-grid" id="car-grid">${filtered.length?filtered.map(card).join(""):`<div class="empty-state"><h3>No cars match those filters</h3><p>Try another availability, fuel type, vehicle type, transmission, or make.</p><button class="btn btn-dark" data-action="clear-filters">Clear filters</button></div>`}</div></section>
    <section class="shell section"><div class="app-section-heading"><h2>Shop with confidence</h2></div><div class="trust-section"><article class="trust-card"><div class="trust-icon">KSh</div><h3>Clear cash prices</h3><p>Published vehicles show their cash price in KSh.</p></article><article class="trust-card"><div class="trust-icon">⌖</div><h3>View by appointment</h3><p>Arrange a visit to Tristar Motors on Masaba Road, Upper Hill.</p></article><article class="trust-card"><div class="trust-icon">✓</div><h3>Confirm availability</h3><p>Contact the team before visiting to confirm a vehicle is still available.</p></article></div></section>
    <section class="shell section" id="location"><div class="location-card"><div class="location-copy"><p class="eyebrow">COME SAY HELLO</p><h3>Visit Tristar Motors</h3><p>${escapeHTML(dealer.address)}<br>${escapeHTML(dealer.hours)}</p><a class="btn btn-dark btn-small" target="_blank" rel="noopener" href="https://maps.google.com/?q=${encodeURIComponent(dealer.address)}">Get directions ↗</a></div><div class="map-panel"><img src="/images/brand/map.png" alt="Map location marker"></div></div></section></main>${footer()}${mobileTabbar("home")}<div class="toast hidden"></div>`;
  wireCommon();
  document.querySelector("#home-search")?.addEventListener("submit",event=>{event.preventDefault();const form=new FormData(event.currentTarget);currentFilters.search=String(form.get("search")||"").trim();for(const key of ["make","model","year","body","maxPrice","maxMileage"])currentFilters[key]=form.get(key)||"all";currentFilters.saved=false;mobileCategory="All";searchExpanded=false;renderHome();document.querySelector("#inventory")?.scrollIntoView({behavior:"smooth"});});
  document.querySelector("#hero-make")?.addEventListener("change",event=>{const choices=[...new Set(store.cars.filter(c=>event.target.value==="all"||c.make===event.target.value).map(c=>c.model))].sort();document.querySelector("#hero-model").innerHTML=selectOptions(choices,"all","Any model");});
  document.querySelectorAll("[data-body-type]").forEach(button=>button.addEventListener("click",()=>{currentFilters.body=button.dataset.bodyType||"all";currentFilters.make="all";currentFilters.model="all";currentFilters.saved=false;mobileCategory="All";renderHome();document.querySelector("#inventory")?.scrollIntoView({behavior:"smooth"});}));
  document.querySelectorAll("[data-mobile-category]").forEach(button=>button.addEventListener("click",()=>{mobileCategory=button.dataset.mobileCategory;renderHome();}));
  document.querySelectorAll("[data-filter]").forEach(control=>control.addEventListener("change",()=>{currentFilters[control.dataset.filter]=control.type==="checkbox"?control.checked:(control.value||"all");renderHome();}));
}

function mobileTabbar(active){return `<nav class="mobile-tabbar" aria-label="App navigation"><a class="${active==="home"?"active":""}" href="#/" aria-label="Home"><span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 10 9-7 9 7v10h-6v-6H9v6H3z"></path></svg></span><small>Home</small></a><button type="button" class="${currentFilters.saved?"active":""}" data-saved-view="true" aria-label="Saved cars"><span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.8 8.8c0 5.1-8.8 10-8.8 10s-8.8-4.9-8.8-10A4.7 4.7 0 0 1 12 6.4a4.7 4.7 0 0 1 8.8 2.4Z"></path></svg></span><small>Saved</small></button><a class="center-tab" href="#/" data-scroll="inventory" aria-label="Browse inventory"><span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 14 2-5h14l2 5v5h-3v-2H6v2H3zM7 9l2-3h6l2 3M6 14h.01M18 14h.01"></path></svg></span><small>Cars</small></a><a class="chat-tab" href="${waLink()}" target="_blank" rel="noopener" aria-label="Message Tristar on WhatsApp"><span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.2 11.7a8.2 8.2 0 0 1-12.1 7.2L4 20l1.1-3.8a8.2 8.2 0 1 1 15.1-4.5Z"></path><path d="M9 8.5c.5 2.8 2 4.4 4.9 5.5"></path></svg></span><small>Chat</small></a><a href="https://maps.google.com/?q=${encodeURIComponent(dealer.address)}" target="_blank" rel="noopener" aria-label="Visit Tristar"><span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z"></path><circle cx="12" cy="10" r="2.5"></circle></svg></span><small>Visit</small></a></nav>`;}
function renderVehicle(id) {
  disposeViewer?.(); disposeViewer = null;
  const car = carById(decodeURIComponent(id));
  if (!car || !(Number(car.price) > 0)) { renderNotFound(); return; }
  const trim = distinctTrim(car);
  const groupedGallery=car.galleryByCategory
    ? photoCategories.flatMap(([key])=>car.galleryByCategory[key]||[])
    : car.gallery||[];
  const gallerySources=[...new Set([car.image,...groupedGallery,...(car.gallery||[])].filter(Boolean))];
  const gallery=[...new Map(gallerySources.map(src=>[src.split(/[?#]/)[0],src])).values()].slice(0,4);
  const frameUrls = car.frames || [];
  app.innerHTML = `${header()}
    <main class="shell vehicle-page">
      <div class="page-top">
        <div class="breadcrumbs"><a href="#/">Inventory</a> / ${escapeHTML(car.year)} ${escapeHTML(car.make)} ${escapeHTML(car.model)}</div>
        <a class="link-button" href="#/">← Back to inventory</a>
      </div>
      <section class="detail-layout">
        <div class="detail-gallery">
          <div class="spin-stage ${frameUrls.length>=24?"has-360":""}" tabindex="0" role="region" aria-label="360 degree vehicle viewer. Drag or swipe, or use arrow keys to rotate." id="spin-viewer">
            <img data-spin-image alt="${escapeHTML(car.year)} ${escapeHTML(car.make)} ${escapeHTML(car.model)} exterior">
            <a class="detail-image-control detail-image-back" href="#/" aria-label="Back to inventory"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6M9 12h12"></path></svg></a>
            <span class="spin-badge">${frameUrls.length>=24?"360° EXTERIOR":"FEATURED EXTERIOR"}</span>
            <span class="spin-frame-count" data-spin-count>${frameUrls.length>=24?"01 / "+frameUrls.length:"PHOTO 1"}</span>
            <span class="spin-hint" data-spin-message>Drag to explore · Swipe on mobile</span>
            ${frameUrls.length>=24?`<button class="spin-arrow spin-left" type="button" data-spin-left aria-label="Rotate left">‹</button><button class="spin-arrow spin-right" type="button" data-spin-right aria-label="Rotate right">›</button>`:""}
          </div>
          <div class="photo-strip">${gallery.map((src,i)=>`<button class="photo-thumb ${i===0?"active":""}" type="button" data-gallery="${i}" aria-label="Show vehicle photo ${i+1}"><img src="${escapeHTML(src)}" alt="" loading="lazy"></button>`).join("")}</div>
          <p class="required-note">${frameUrls.length>=24?"Drag, swipe, or use arrow keys to rotate the exterior.":"360° rotation activates when 24–36 vehicle frame images are added to this listing."}</p>
        </div>
        <aside class="detail-side">
          <section class="detail-title-card">
            <p class="availability-badge detail-availability ${statusClass(car.status)}">${escapeHTML(statusLabel(car.status))} · ${escapeHTML(car.body)}</p>
            <h1>${escapeHTML(car.year)} ${escapeHTML(car.make)} ${escapeHTML(car.model)}${trim?` ${escapeHTML(trim)}`:""}</h1>
            <p class="vin-line">VIN ${escapeHTML(car.vin)} · ${number(car.mileage)} miles</p>
            <div class="vehicle-price">
              <strong>${priceLabel(car.price)}</strong>
            </div>
            <p class="vehicle-description">${escapeHTML(vehicleDescription(car))}</p>
            <a class="whatsapp vehicle-test-drive" href="${waLink(car, `Hi ${dealer.name}, I'd like to book a test drive for the ${car.year} ${car.make} ${car.model} (VIN ${car.vin}).`)}" target="_blank" rel="noopener">Book a test drive</a>
          </section>
        </aside>
      </section>
      <section class="vehicle-highlights section" aria-labelledby="vehicle-highlights-title">
        <div class="highlights-heading">
          <p class="eyebrow">The details</p>
          <h2 class="section-title" id="vehicle-highlights-title">Vehicle highlights</h2>
        </div>
        <div class="features-grid">
          <div class="feature-item"><span>Transmission</span><strong>${escapeHTML(car.transmission)}</strong></div>
          <div class="feature-item"><span>Engine</span><strong>${escapeHTML(car.engine)}</strong></div>
          <div class="feature-item"><span>Fuel</span><strong>${escapeHTML(car.fuel)}</strong></div>
          <div class="feature-item"><span>Mileage</span><strong>${number(car.mileage)} mi</strong></div>
          <div class="feature-item"><span>Body style</span><strong>${escapeHTML(car.body)}</strong></div>
          <div class="feature-item"><span>Availability</span><strong>${escapeHTML(statusLabel(car.status))}</strong></div>
        </div>
      </section>
    </main>
    ${footer()}<div class="toast hidden"></div>`;
  wireCommon();
  const viewer = document.querySelector("#spin-viewer");
  disposeViewer = mount360Viewer(viewer, frameUrls, car.image);
  document.querySelectorAll("[data-gallery]").forEach((button)=>button.addEventListener("click",()=>{
    document.querySelectorAll("[data-gallery]").forEach(b=>b.classList.toggle("active",b===button));
    const img=document.querySelector("[data-spin-image]");
    img.src=gallery[Number(button.dataset.gallery)];
    const count=document.querySelector("[data-spin-count]"); count.textContent=`PHOTO ${Number(button.dataset.gallery)+1}`;
  }));
}

function renderNotFound(){app.innerHTML=`${header()}<main class="shell section"><h1>Vehicle not found</h1><p class="text-muted">It may have been sold or removed.</p><a class="btn btn-dark" href="#/">Browse available cars</a></main>${footer()}`;wireCommon();}

function statusControl(car) {
  return `<div class="inventory-status-control"><span class="inventory-status ${statusClass(car.status)}">${escapeHTML(statusLabel(car.status))}</span><select class="status-select ${car.status === "In Stock" ? "in-stock" : car.status === "Pending" ? "pending" : "sold"}" data-status="${escapeHTML(car.id)}" aria-label="Availability for ${car.year} ${escapeHTML(car.make)} ${escapeHTML(car.model)}"><option value="In Stock" ${car.status === "In Stock" ? "selected" : ""}>Available</option><option value="Pending" ${car.status === "Pending" ? "selected" : ""}>Pending</option><option value="Sold" ${car.status === "Sold" ? "selected" : ""}>Sold</option></select></div>`;
}

function renderAdminLogin() {
  const configured = adminSession?.configured;
  app.innerHTML = `${header()}<main class="shell admin-shell"><section class="admin-login-card"><p class="eyebrow">TRISTAR MOTORS · LOCAL ADMIN</p><h1>Administrator sign in</h1>${configured ? `<p>Sign in as Allan to manage vehicle inventory.</p><form id="admin-login-form"><label class="field"><span class="field-label">Administrator</span><input name="username" value="Allan" readonly autocomplete="username"></label><label class="field"><span class="field-label">Password</span><input name="password" type="password" required autocomplete="current-password"></label><p class="login-error" id="login-error" role="alert"></p><button class="btn btn-primary" type="submit">Sign in</button></form>` : `<p>Administrator sign-in is not configured. Set <code>TRISTAR_ADMIN_PASSWORD</code> (at least 12 characters) in the shell before starting the local app, then reload this page.</p>`}<p class="admin-local-note">Local prototype only. The API accepts connections from this computer; this login is not production security.</p></section></main>${footer()}<div class="toast hidden"></div>`;
  document.querySelector("#admin-login-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const button = event.currentTarget.querySelector('button[type="submit"]');
    const errorNode = document.querySelector("#login-error");
    button.disabled = true;
    errorNode.textContent = "";
    try {
      adminSession = await apiRequest("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ username: String(form.get("username")), password: String(form.get("password")) }),
      });
      renderAdmin();
    } catch (error) {
      errorNode.textContent = error.message;
      button.disabled = false;
    }
  });
}

function renderAdmin(){
  disposeViewer?.();disposeViewer=null;
  if (adminSession === null) {
    app.innerHTML = `${header()}<main class="shell section"><p>Checking administrator session…</p></main>${footer()}`;
    apiRequest("/api/auth/session").then((session) => {
      adminSession = session;
      if (route().startsWith("#/admin")) renderAdmin();
    }).catch((error) => {
      adminSession = { configured: false, authenticated: false, error: error.message };
      if (route().startsWith("#/admin")) renderAdminLogin();
    });
    return;
  }
  if (!adminSession.authenticated) {
    renderAdminLogin();
    return;
  }
  const isLeads=adminTab==="leads";
  const edit=editId?carById(editId):null;
  const rows=isLeads
    ? store.leads.map((lead,index)=>`<tr><td>${new Date(lead.createdAt).toLocaleString()}</td><td>${escapeHTML(lead.type)}</td><td>${escapeHTML(lead.name||"—")}</td><td>${escapeHTML(lead.phone||lead.email||"—")}</td><td>${escapeHTML(lead.vehicle||"—")}</td><td>${escapeHTML(lead.notes||lead.date||"—")}</td><td><button class="table-action delete" data-action="delete-lead" data-id="${index}">Remove</button></td></tr>`).join("")
    : store.cars.map(car=>`<tr><td>${car.year} ${escapeHTML(car.make)} ${escapeHTML(car.model)}</td><td>${escapeHTML(car.vin)}</td><td>${priceLabel(car.price)}</td><td>${number(car.mileage)} mi</td><td>${statusControl(car)}</td><td><div class="table-actions"><button class="table-action" data-action="edit-car" data-id="${escapeHTML(car.id)}">Edit</button><button class="table-action delete" data-action="delete-car" data-id="${escapeHTML(car.id)}">Remove</button></div></td></tr>`).join("");
  app.innerHTML=`${header()}<main class="shell admin-shell"><div class="admin-top"><div><p class="eyebrow">LOCAL DEALER WORKSPACE</p><h1>Inventory &amp; leads</h1><p class="text-muted" style="font-size:11px">Manage vehicle listings and availability on this computer.</p></div><div class="admin-session-actions"><a class="btn btn-light" href="#/">← View storefront</a><button class="btn btn-light" type="button" data-action="admin-logout">Sign out Allan</button></div></div><div class="admin-notice"><strong>Local prototype:</strong> inventory is saved to SQLite on this computer. The API only accepts connections from this computer; keep it off networks and do not use it for production customer data.</div><div class="admin-metrics"><div class="admin-metric"><span>Available vehicles</span><strong>${store.cars.filter(c=>c.status==="In Stock").length}</strong></div><div class="admin-metric"><span>Sold vehicles</span><strong>${store.cars.filter(c=>c.status==="Sold").length}</strong></div><div class="admin-metric"><span>Open customer leads</span><strong>${store.leads.length}</strong></div></div><div class="admin-tabs"><button class="admin-tab ${!isLeads?"active":""}" data-admin-tab="inventory">Inventory (${store.cars.length})</button><button class="admin-tab ${isLeads?"active":""}" data-admin-tab="leads">Customer leads (${store.leads.length})</button></div><div class="admin-table-wrap"><table class="admin-table"><thead><tr>${isLeads?"<th>Received</th><th>Type</th><th>Name</th><th>Contact</th><th>Vehicle</th><th>Details</th><th></th>":"<th>Vehicle</th><th>VIN</th><th>Price</th><th>Mileage</th><th>Availability</th><th>Actions</th>"}</tr></thead><tbody>${rows||`<tr><td colspan="7">${isLeads?"No leads yet. Test-drive and trade-in requests will appear here.":"No vehicles in inventory."}</td></tr>`}</tbody></table></div>${!isLeads?`<section class="admin-form-card" id="vehicle-editor"><h2>${edit?"Edit vehicle":"Add a vehicle"}</h2><form id="car-form" data-id="${edit?escapeHTML(edit.id):""}"><div class="admin-form-grid">${inputField("year","Year",edit?.year||new Date().getFullYear(),"number","required min=1980 max=2035")}${inputField("make","Make",edit?.make||"","text","required")}${inputField("model","Model",edit?.model||"","text","required")}${inputField("trim","Trim",edit?.trim||"")}${selectField("body","Body style",["SUV","Sedan","Truck","Coupe","Roadster","Wagon"],edit?.body||"SUV")}${inputField("price","Cash price (KSh)",edit?.price??"","number","min=1")}${inputField("mileage","Mileage",edit?.mileage||"","number","required min=0")}${selectField("transmission","Transmission",inventoryFieldOptions("transmission",["Automatic","Manual","CVT","Single-speed"]),edit?.transmission||"Automatic")}${inputField("engine","Engine",edit?.engine||"")}${selectField("fuel","Fuel type",inventoryFieldOptions("fuel",["Petrol","Diesel","Electric","Hybrid","Plug-in Hybrid","Other"]),edit?.fuel||"Petrol")}${inputField("vin","VIN",edit?.vin||"","text","required minlength=11")}${selectField("status","Availability",["In Stock","Pending","Sold"],edit?.status||"In Stock")}${inputField("image","Primary image URL",edit?.image||"")}${inputField("frameBase","360 frame URL base",edit?.frameBase||"","text")}</div><p class="required-note">Only priced vehicles appear in the storefront. Leave this blank while confirming the cash price. Front uploads can become the main picture.</p><label class="field" style="margin-top:10px"><span class="field-label">Badge tags, comma separated</span><input name="badges" value="${escapeHTML((edit?.badges||[]).join(", "))}" placeholder="Clean Title, Single Owner"></label><section class="gallery-upload-editor"><h3>Vehicle pictures</h3><p>Select images from this device. Review each preview, then convert and upload to the local WebP gallery.</p><div id="gallery-upload-workspace"></div></section><p class="required-note">A 360 frame URL base should contain “{frame}”, e.g. /images/cars/stock-id/frame-{frame}.webp. Upload 24–36 numbered frames.</p><div class="modal-actions"><button class="btn btn-primary" type="submit">${edit?"Save changes":"Add vehicle"}</button>${edit?`<button class="btn btn-light" type="button" data-action="cancel-edit">Cancel edit</button>`:""}<button class="link-button" type="button" data-action="reset-demo">Restore sample inventory</button></div></form></section>`:""}</main>${footer()}<div class="toast hidden"></div>`;
  renderGalleryUploadWorkspace();
  wireCommon();
  document.querySelector("[data-action='admin-logout']")?.addEventListener("click", async () => {
    try {
      await apiRequest("/api/auth/logout", { method: "POST" });
      adminSession = { configured: true, authenticated: false };
      editId = null;
      renderAdmin();
    } catch (error) {
      toast(`Could not sign out: ${error.message}`);
    }
  });
  document.querySelectorAll("[data-admin-tab]").forEach(button=>button.addEventListener("click",()=>{adminTab=button.dataset.adminTab;editId=null;renderAdmin()}));
  document.querySelectorAll("[data-status]").forEach(control=>control.addEventListener("change",async()=>{
    const car=carById(control.dataset.status);
    if(!car)return;
    control.disabled=true;
    try {
      const updated=await apiRequest(`/api/cars/${encodeURIComponent(car.id)}/status`,{method:"PATCH",body:JSON.stringify({status:control.value})});
      store.cars=store.cars.map(item=>item.id===updated.id?updated:item);
      renderAdmin();
      toast(`Availability updated: ${statusLabel(updated.status)}`);
    } catch(error) {
      toast(`Could not update availability: ${error.message}`);
      renderAdmin();
    }
  }));
  document.querySelector("#car-form")?.addEventListener("submit",async(event)=>{
    event.preventDefault();const form=new FormData(event.currentTarget);const base=String(form.get("frameBase")||"").trim();
    if(uploadInProgress){toast("Wait for image uploads to finish before saving.");return;}
    if(photoCategories.some(([key])=>pendingPhotoFiles[key].length)){toast("Convert and upload the selected image previews before saving.");return;}
    const fields={year:Number(form.get("year")),make:String(form.get("make")).trim(),model:String(form.get("model")).trim(),trim:String(form.get("trim")).trim(),body:String(form.get("body")),price:form.get("price")===""?null:Number(form.get("price")),mileage:Number(form.get("mileage")),transmission:String(form.get("transmission")).trim(),engine:String(form.get("engine")).trim(),fuel:String(form.get("fuel")).trim(),vin:String(form.get("vin")).trim().toUpperCase(),status:String(form.get("status")),image:String(form.get("image")).trim()||"https://images.unsplash.com/photo-1492144534655-ae79c964c9d7?auto=format&fit=crop&w=1000&q=80",badges:String(form.get("badges")).split(",").map(s=>s.trim()).filter(Boolean)};
    fields.id=editId||`${fields.make}-${fields.model}`.toLowerCase().replace(/[^a-z0-9]+/g,"-");fields.galleryByCategory=structuredClone(draftGallery);fields.gallery=photoCategories.flatMap(([key])=>fields.galleryByCategory[key]);if(!fields.gallery.length)fields.gallery=[fields.image];fields.frameBase=base;fields.frames=base.includes("{frame}")?Array.from({length:24},(_,i)=>base.replace("{frame}",String(i+1).padStart(2,"0"))):[];
    try {
      const method=editId?"PUT":"POST";
      const savedCar=await apiRequest(editId?`/api/cars/${encodeURIComponent(fields.id)}`:"/api/cars",{method,body:JSON.stringify(fields)});
      if(editId)store.cars=store.cars.map(car=>car.id===savedCar.id?savedCar:car);
      else store.cars=[savedCar,...store.cars];
      editId=null;draftGallery=emptyDraftGallery();pendingPhotoFiles=emptyDraftGallery();adminTab="inventory";renderAdmin();toast("Vehicle listing saved");
    } catch(error) {
      toast(`Could not save vehicle: ${error.message}`);
    }
  });
}
function inputField(name,label,value="",type="text",extra="") { return `<label class="field"><span class="field-label">${label}</span><input name="${name}" type="${type}" value="${escapeHTML(value)}" ${extra}></label>`; }
function inventoryFieldOptions(field, additional=[]) {
  return [...new Set([...store.cars.map(car=>car[field]).filter(Boolean),...additional])].sort((a,b)=>a.localeCompare(b));
}
function selectField(name,label,values,selected) { const choices=[...new Set([...values,selected].filter(Boolean))]; return `<label class="field"><span class="field-label">${label}</span><select name="${name}">${choices.map(v=>`<option ${v===selected?"selected":""}>${escapeHTML(v)}</option>`).join("")}</select></label>`; }

function wireCommon(){
  document.querySelector("#mobile-menu")?.addEventListener("click",e=>{const nav=document.querySelector("#main-nav"),open=!nav.classList.contains("open");nav.classList.toggle("open",open);e.currentTarget.setAttribute("aria-expanded",String(open));e.currentTarget.setAttribute("aria-label",open?"Close navigation":"Open navigation");});
  document.querySelectorAll("[data-saved-view]").forEach(button=>button.addEventListener("click",()=>{currentFilters.saved=!currentFilters.saved;mobileCategory="All";location.hash="#/";renderHome();document.querySelector("#inventory")?.scrollIntoView({behavior:"smooth"});}));
  document.querySelectorAll("[data-scroll]").forEach(a=>a.addEventListener("click",event=>{event.preventDefault();const scrollToTarget=()=>document.getElementById(a.dataset.scroll)?.scrollIntoView({behavior:"smooth",block:"start"});if(route()!=="#/"){location.hash="#/";setTimeout(scrollToTarget,80);}else scrollToTarget();}));
}
function handleClick(event){
  const fav=event.target.closest("[data-favorite]");if(fav){const id=fav.dataset.favorite;store.favorites=store.favorites.includes(id)?store.favorites.filter(v=>v!==id):[...store.favorites,id];save();const detail=route().match(/^#\/cars\/([^/?]+)/);detail?renderVehicle(detail[1]):renderHome();return;}
  const tab=event.target.closest("[data-admin-tab]");if(tab)return;
  const button=event.target.closest("[data-action]");if(!button)return;
  const action=button.dataset.action,id=button.dataset.id||button.dataset.car;
  if(action==="upload-photos"){uploadSelectedPhotos();return;}
  if(action==="use-main"){const input=document.querySelector('#car-form [name="image"]');if(input)input.value=button.dataset.useMain;toast("Main vehicle picture updated");return;}
  if(action==="clear-filters"){currentFilters={make:"all",model:"all",year:"all",body:"all",maxPrice:"all",maxMileage:"all",availability:"all",fuel:"all",transmission:"all",search:"",saved:false};mobileCategory="All";renderHome();}
  if(action==="toggle-search-filters"){searchExpanded=!searchExpanded;document.querySelector("#advanced-search")?.classList.toggle("expanded",searchExpanded);}
  if(action==="toggle-filters")document.querySelector("#filter-panel")?.classList.toggle("expanded");
  if(action==="edit-car"){editId=id;draftGallery=readDraftGallery(carById(id));pendingPhotoFiles=emptyDraftGallery();renderAdmin();document.querySelector("#vehicle-editor")?.scrollIntoView({behavior:"smooth"});}
  if(action==="cancel-edit"){editId=null;draftGallery=emptyDraftGallery();pendingPhotoFiles=emptyDraftGallery();renderAdmin();}
  if(action==="delete-car"&&confirm("Remove this vehicle from inventory?")){apiRequest(`/api/cars/${encodeURIComponent(id)}`,{method:"DELETE"}).then(()=>{store.cars=store.cars.filter(car=>car.id!==id);renderAdmin();toast("Vehicle removed");}).catch(error=>toast(`Could not remove vehicle: ${error.message}`));}
  if(action==="delete-lead"&&confirm("Remove this customer lead?")){store.leads.splice(Number(id),1);save();renderAdmin();toast("Lead removed");}
  if(action==="reset-demo"&&confirm("Restore the original sample inventory and clear local leads and favorites?")){apiRequest("/api/reset",{method:"POST"}).then(cars=>{store=resetDemoStore();store.cars=cars;editId=null;renderAdmin();toast("Sample inventory restored");}).catch(error=>toast(`Could not restore inventory: ${error.message}`));}
}

function render(){
  if(!inventoryLoaded)return;
  document.title=route().startsWith("#/admin")?"Dealer Portal | Tristar Motors":"Tristar Motors — Find your next drive";
  const r=route();
  if(r.startsWith("#/admin")){renderAdmin();return;}
  const detail=r.match(/^#\/cars\/([^/?]+)/);
  if(detail){renderVehicle(detail[1]);return;}
  currentFilters.saved=new URLSearchParams(r.split("?")[1]||"").get("saved")==="1";
  renderHome();
}
if ("scrollRestoration" in history) history.scrollRestoration="manual";
window.addEventListener("hashchange",()=>{
  if ("scrollRestoration" in history) history.scrollRestoration="manual";
  window.scrollTo({top:0,left:0,behavior:"instant"});
  render();
  requestAnimationFrame(()=>window.scrollTo({top:0,left:0,behavior:"instant"}));
});
app.addEventListener("click", handleClick);
refreshInventory().then(render).catch((error)=>{
  console.error("Could not load vehicle inventory:",error);
  app.innerHTML=`${header()}<main class="shell section"><h1>Inventory service unavailable</h1><p>${escapeHTML(error.message)} Start the local app with <code>npm run dev</code>, then reload this page.</p></main>${footer()}`;
});

// Shared delegated UI listeners for changes/submit events that survive rerenders.
app.addEventListener("change",event=>{
  if(event.target.matches("[data-status]"))return;
  if(event.target.matches("[data-filter]"))return;
  if(event.target.matches("#hero-make")){currentFilters.make=event.target.value;currentFilters.model="all";}
});
