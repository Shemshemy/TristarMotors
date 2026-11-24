import { dealer, money, number } from "./data.js";
import { readStore, writeStore, resetDemoStore } from "./store.js";
import { mount360Viewer } from "./viewer.js";
import encodeWebP, { init as initWebP } from "@jsquash/webp/encode.js";
import webpEncoderWasmUrl from "@jsquash/webp/codec/enc/webp_enc.wasm?url";
import webpEncoderSimdWasmUrl from "@jsquash/webp/codec/enc/webp_enc_simd.wasm?url";
import "./styles.css";

const app = document.querySelector("#app");
let store = readStore();
let currentFilters = { make:"all", model:"all", year:"all", body:"all", maxPrice:"all", maxMileage:"all", availability:"all", fuel:"all", transmission:"all", search:"", saved:false };
let adminTab = "inventory";
let editId = null;
let vehicleModalOpen = false;
let vehicleStep = "details";
let restoredVehicleFormFields = null;
let vehicleDraftDbPromise = null;
let vehicleDraftSaveTimer;
let vehicleDraftWarningShown = false;
let pageScrollLock = null;
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
let uploadProgress = null;
let vehicleSaveInProgress = false;
let photoUploadMessage = "Upload photos, then choose Save vehicle to attach them to this listing. Add at least one front photo.";
let webpEncoderPromise;

function lockPageScroll() {
  if (pageScrollLock) return;
  const body = document.body;
  const scrollbarWidth = Math.max(0, window.innerWidth - document.documentElement.clientWidth);
  pageScrollLock = {
    top: window.scrollY,
    position: body.style.position,
    topStyle: body.style.top,
    left: body.style.left,
    right: body.style.right,
    width: body.style.width,
    overflow: body.style.overflow,
    paddingRight: body.style.paddingRight,
  };
  body.classList.add("dialog-page-locked");
  body.style.position = "fixed";
  body.style.top = `-${pageScrollLock.top}px`;
  body.style.left = "0";
  body.style.right = "0";
  body.style.width = "100%";
  body.style.overflow = "hidden";
  if (scrollbarWidth) body.style.paddingRight = `calc(${pageScrollLock.paddingRight || "0px"} + ${scrollbarWidth}px)`;
}

function unlockPageScroll() {
  if (!pageScrollLock || document.querySelector("dialog[open]")) return;
  const body = document.body;
  const { top, position, topStyle, left, right, width, overflow, paddingRight } = pageScrollLock;
  pageScrollLock = null;
  body.classList.remove("dialog-page-locked");
  body.style.position = position;
  body.style.top = topStyle;
  body.style.left = left;
  body.style.right = right;
  body.style.width = width;
  body.style.overflow = overflow;
  body.style.paddingRight = paddingRight;
  window.scrollTo({ top, behavior: "instant" });
}

function openVehicleDraftDb() {
  if (!vehicleDraftDbPromise) {
    vehicleDraftDbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open("tristar-admin-drafts", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("drafts");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Could not open local draft storage"));
    });
  }
  return vehicleDraftDbPromise;
}

async function saveVehicleDraft() {
  if (!vehicleModalOpen) return;
  const form = document.querySelector("#car-form");
  if (!form) return;
  const fields = [...form.querySelectorAll("input[name], select[name], textarea[name]")].map((control) => ({
    name: control.name,
    type: control.type,
    value: control.value,
    checked: control.type === "checkbox" ? control.checked : undefined,
  }));
  const pending = Object.fromEntries(photoCategories.map(([key]) => [key, (pendingPhotoFiles[key] || []).map(({ file }) => file)]));
  const draft = { vehicleModalOpen, editId, vehicleStep, fields, draftGallery, pending };
  try {
    const db = await openVehicleDraftDb();
    await new Promise((resolve, reject) => {
      const transaction = db.transaction("drafts", "readwrite");
      transaction.objectStore("drafts").put(draft, "active-vehicle");
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error("Could not save the local draft"));
      transaction.onabort = () => reject(transaction.error || new Error("Local draft save was interrupted"));
    });
    vehicleDraftWarningShown = false;
  } catch (error) {
    console.warn("Could not autosave vehicle form:", error);
    if (!vehicleDraftWarningShown) {
      vehicleDraftWarningShown = true;
      toast("This browser could not cache the vehicle draft. Keep this tab open until you save it.");
    }
  }
}

function scheduleVehicleDraftSave() {
  clearTimeout(vehicleDraftSaveTimer);
  vehicleDraftSaveTimer = setTimeout(() => saveVehicleDraft(), 250);
}

async function restoreVehicleDraft() {
  try {
    const db = await openVehicleDraftDb();
    const draft = await new Promise((resolve, reject) => {
      const transaction = db.transaction("drafts", "readonly");
      const request = transaction.objectStore("drafts").get("active-vehicle");
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error("Could not read the local draft"));
    });
    if (!draft?.vehicleModalOpen) return;
    vehicleModalOpen = true;
    editId = draft.editId || null;
    vehicleStep = draft.vehicleStep === "photos" ? "photos" : "details";
    restoredVehicleFormFields = Array.isArray(draft.fields) ? draft.fields : null;
    draftGallery = Object.fromEntries(photoCategories.map(([key]) => [key, Array.isArray(draft.draftGallery?.[key]) ? draft.draftGallery[key] : []]));
    pendingPhotoFiles = Object.fromEntries(photoCategories.map(([key]) => [key, (draft.pending?.[key] || []).filter((file) => file instanceof Blob).map((file) => ({ file, preview: URL.createObjectURL(file) }))]));
  } catch (error) {
    console.warn("Could not restore vehicle form draft:", error);
  }
}

function applyRestoredVehicleForm() {
  if (!restoredVehicleFormFields) return;
  const form = document.querySelector("#car-form");
  if (!form) return;
  const controls = [...form.querySelectorAll("input[name], select[name], textarea[name]")];
  restoredVehicleFormFields.forEach((saved, index) => {
    const control = controls[index];
    if (!control || control.name !== saved.name || control.type === "file") return;
    if (control.type === "checkbox") control.checked = Boolean(saved.checked);
    else control.value = saved.value ?? "";
  });
  const selectedFeatures = new Set((form.querySelector('[name="featuresText"]')?.value || "").split(/\r?\n/).map((feature) => feature.trim().toLowerCase()).filter(Boolean));
  form.querySelectorAll(".feature-pill-btn").forEach((button) => {
    const active = selectedFeatures.has(button.dataset.feature?.toLowerCase());
    button.classList.toggle("active", active);
    button.style.borderColor = active ? "#b4862b" : "#dce2e9";
    button.style.background = active ? "#b4862b1a" : "#fff";
    button.style.color = active ? "#8a661c" : "#374151";
    button.style.fontWeight = active ? "600" : "400";
    button.textContent = `${active ? "✓ " : "+ "}${button.dataset.feature}`;
  });
  restoredVehicleFormFields = null;
}

async function clearVehicleDraft() {
  clearTimeout(vehicleDraftSaveTimer);
  try {
    const db = await openVehicleDraftDb();
    await new Promise((resolve, reject) => {
      const transaction = db.transaction("drafts", "readwrite");
      transaction.objectStore("drafts").delete("active-vehicle");
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error("Could not clear the local draft"));
    });
  } catch (error) {
    console.warn("Could not clear saved vehicle draft:", error);
  }
}

const escapeHTML = (value="") => String(value).replace(/[&<>"']/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));
const route = () => location.hash || "#/";
const carById = (id) => store.cars.find((car) => car.id === id);
const listedCars = () => store.cars.filter((car) =>
  car.make === "Mercedes-Benz" && Number.isFinite(Number(car.price)) && Number(car.price) > 0
);
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
    (mobileCategory === "Sports" && ["Coupe", "Roadster"].includes(car.body)) ||
    (mobileCategory === "Luxury" && car.make === "Mercedes-Benz");
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
  return `This ${name} has ${number(car.mileage)} km, a ${car.engine} ${car.fuel.toLowerCase()} engine, and a ${car.transmission.toLowerCase()} transmission.`;
}
function header() {
  return `<header class="site-header admin-site-header"><div class="shell header-main">
    <a class="logo" href="/" aria-label="Tristar Motors home"><img src="/images/brand/tristarmotors.png" alt="Tristar Motors"></a>
    <a class="admin-back-site" href="/" aria-label="Back to the website"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 5 7 12l7 7M7 12h14"/></svg><span>Back to site</span></a>
    ${adminSession?.authenticated?`<div class="admin-user-tools"><div class="admin-user"><span class="admin-avatar" aria-hidden="true">A</span><span class="admin-user-copy"><strong>Allan</strong></span></div><button class="admin-logout-button" type="button" data-action="admin-logout" aria-label="Log out Allan"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 17l5-5-5-5M15 12H3M21 19V5a2 2 0 0 0-2-2h-6"/></svg><span>Log out</span></button></div>`:""}
  </div></header>`;
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
function setCarFormError(message = "") {
  const errorNode = document.querySelector("[data-car-form-error]");
  if (!errorNode) return;
  errorNode.textContent = message;
  errorNode.hidden = !message;
  if (message) errorNode.scrollIntoView({ block: "nearest", behavior: "smooth" });
}
function validateCarFormStep(form) {
  const invalidFields = [...form.querySelectorAll(":invalid")];
  if (!invalidFields.length) {
    setCarFormError();
    return true;
  }
  form.reportValidity();
  const names = invalidFields.map((field) => field.closest(".field")?.querySelector(".field-label")?.textContent || field.getAttribute("aria-label") || "required field");
  setCarFormError(`Complete the required car details before continuing: ${[...new Set(names)].join(", ")}.`);
  return false;
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
  }).join("")}<div class="photo-upload-actions"><button class="btn btn-light" type="button" data-action="upload-photos" ${uploadInProgress || !photoCategories.some(([key]) => pendingPhotoFiles[key].length) ? "disabled" : ""}>${uploadInProgress ? "Converting and uploading…" : "Upload selected photos"}</button>${uploadProgress ? `<div class="photo-upload-progress" aria-live="polite"><div class="photo-upload-progress-label"><span id="photo-upload-progress-label">${escapeHTML(uploadProgressLabel())}</span><strong id="photo-upload-progress-count">${uploadProgress.complete} / ${uploadProgress.total}</strong></div><progress id="photo-upload-progress-bar" value="${uploadProgress.complete}" max="${uploadProgress.total}" aria-label="Photo upload progress"></progress></div>` : ""}<p class="photo-upload-status" id="photo-upload-status" role="status">Upload photos, then choose Save vehicle to attach them to this listing. Add at least one front photo.</p></div>`;
  const statusNode = root.querySelector("#photo-upload-status");
  if (statusNode) {
    statusNode.textContent = photoUploadMessage;
    statusNode.setAttribute("role", photoUploadMessage.startsWith("Upload stopped:") ? "alert" : "status");
  }
  root.querySelectorAll("[data-photo-category]").forEach((input) => input.addEventListener("change", () => {
    const category = input.dataset.photoCategory;
    for (const photo of pendingPhotoFiles[category]) URL.revokeObjectURL(photo.preview);
    pendingPhotoFiles[category].push(...[...input.files].map((file) => ({ file, preview: URL.createObjectURL(file) })));
    uploadProgress = null;
    photoUploadMessage = "Photos selected. Upload them, then save the vehicle to attach them to this listing.";
    scheduleVehicleDraftSave();
    renderGalleryUploadWorkspace();
  }));
  root.querySelectorAll("[data-remove-photo]").forEach((button) => button.addEventListener("click", () => {
    const category = button.dataset.removePhoto;
    const [photo] = pendingPhotoFiles[category].splice(Number(button.dataset.photoIndex), 1);
    if (photo) URL.revokeObjectURL(photo.preview);
    scheduleVehicleDraftSave();
    renderGalleryUploadWorkspace();
  }));
}
function uploadProgressLabel() {
  if (!uploadProgress) return "";
  if (uploadProgress.phase === "Complete") return "All selected photos uploaded";
  const item = uploadProgress.current ? `Photo ${uploadProgress.current} of ${uploadProgress.total}` : "Preparing upload";
  return `${item}${uploadProgress.currentName ? ` · ${uploadProgress.currentName}` : ""}${uploadProgress.phase ? ` · ${uploadProgress.phase}` : ""}`;
}
function updateUploadProgressView() {
  if (!uploadProgress) return;
  const label = document.querySelector("#photo-upload-progress-label");
  const count = document.querySelector("#photo-upload-progress-count");
  const bar = document.querySelector("#photo-upload-progress-bar");
  if (label) label.textContent = uploadProgressLabel();
  if (count) count.textContent = `${uploadProgress.complete} / ${uploadProgress.total}`;
  if (bar) {
    bar.max = uploadProgress.total;
    bar.value = uploadProgress.complete;
    bar.setAttribute("aria-valuetext", `${uploadProgress.complete} of ${uploadProgress.total} photos uploaded`);
  }
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
  const total = photoCategories.reduce((sum, [key]) => sum + pendingPhotoFiles[key].length, 0);
  if (!total) return;
  uploadInProgress = true;
  uploadProgress = { total, complete: 0, current: 0, currentName: "", phase: "Starting" };
  photoUploadMessage = "Preparing selected images…";
  renderGalleryUploadWorkspace();
  await saveVehicleDraft();
  const status = (message) => {
    photoUploadMessage = message;
    const node = document.querySelector("#photo-upload-status");
    if (node) {
      node.textContent = photoUploadMessage;
      node.setAttribute("role", message.startsWith("Upload stopped:") ? "alert" : "status");
    }
    updateUploadProgressView();
  };
  let uploadedCount = 0;
  let frontAssigned = false;
  try {
    for (const [category] of photoCategories) {
      while (pendingPhotoFiles[category].length) {
        const [photo] = pendingPhotoFiles[category];
        uploadProgress.current = uploadedCount + 1;
        uploadProgress.currentName = photo.file.name;
        uploadProgress.phase = "Converting";
        status(`Photo ${uploadProgress.current} of ${total}: converting ${photo.file.name}…`);
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const data = await convertToWebP(photo.file);
        uploadProgress.phase = "Uploading";
        status(`Photo ${uploadProgress.current} of ${total}: uploading ${photo.file.name}…`);
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
        uploadProgress.complete = uploadedCount;
        uploadProgress.phase = uploadedCount === total ? "Complete" : "Uploaded";
        await saveVehicleDraft();
        renderGalleryUploadWorkspace();
      }
    }
    status(`${uploadedCount} ${uploadedCount === 1 ? "photo" : "photos"} uploaded. Choose Save vehicle to attach them to this listing.`);
  } catch (error) {
    if (uploadProgress) uploadProgress.phase = "Stopped";
    const message = error.message.includes("Administrator sign-in is required")
      ? "Your admin sign-in has expired. Sign in again, reopen this listing, and retry the upload."
      : error.message;
    status(`Upload stopped: ${message}. Unfinished selections remain available to retry.`);
  } finally {
    uploadInProgress = false;
    renderGalleryUploadWorkspace();
    updateUploadProgressView();
    if (uploadedCount > 0 && !photoUploadMessage.startsWith("Upload stopped:")) {
      status(`${uploadedCount} ${uploadedCount === 1 ? "photo" : "photos"} uploaded. Choose Save vehicle to attach them to this listing. Existing photos were kept.`);
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
  document.title = "Tristar Motors | Mercedes-Benz Vehicles in Nairobi";
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
    <section class="shell app-search-section"><div class="storefront-intro"><div><p class="eyebrow">TRISTAR MOTORS <span aria-hidden="true">·</span> UPPER HILL</p><h1>Find the car that feels like yours.</h1><p>Explore Mercedes-Benz vehicles, compare clear cash prices, and arrange a viewing with our Nairobi team.</p></div><a class="intro-browse" href="#/" data-scroll="inventory">Browse inventory <span aria-hidden="true">↘</span></a></div><form id="home-search" class="app-search-form"><div class="app-search"><span class="search-symbol" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="10.8" cy="10.8" r="6.8"></circle><path d="m16 16 4.2 4.2"></path></svg></span><input name="search" type="search" value="${escapeHTML(currentFilters.search)}" placeholder="Search cars, models…" aria-label="Search Mercedes-Benz cars"><button class="search-filter-button" type="button" data-action="toggle-search-filters" aria-label="${searchExpanded?"Hide":"Show"} search filters" aria-controls="advanced-search" aria-expanded="${searchExpanded}"><svg viewBox="0 0 24 24"><path d="M4 7h7m4 0h5M4 17h3m4 0h9"></path><circle cx="13" cy="7" r="2"></circle><circle cx="9" cy="17" r="2"></circle></svg></button></div>
      <div class="advanced-search ${searchExpanded?"expanded":""}" id="advanced-search"><div class="field"><label for="hero-make">Make</label><select id="hero-make" name="make">${selectOptions(makes,currentFilters.make,"Any make")}</select></div><div class="field"><label for="hero-model">Model</label><select id="hero-model" name="model">${selectOptions(models,currentFilters.model,"Any model")}</select></div><div class="field"><label for="hero-year">Year</label><select id="hero-year" name="year">${selectOptions(years,currentFilters.year,"Any year")}</select></div><div class="field"><label for="hero-body">Body style</label><select id="hero-body" name="body">${selectOptions(["SUV","Sedan","Truck","Coupe","Roadster","Wagon"],currentFilters.body,"Any style")}</select></div><div class="field"><label for="hero-price">Max price</label><select id="hero-price" name="maxPrice">${priceFilterOptions()}</select></div><div class="field"><label for="hero-mileage">Max mileage</label><select id="hero-mileage" name="maxMileage">${selectOptions([25000,50000,75000,100000].map(String),currentFilters.maxMileage,"Any mileage")}</select></div><button class="btn btn-dark" type="submit">Apply filters <span>→</span></button></div></form>
      <nav class="mobile-category-rail" aria-label="Browse vehicle categories">${["All","Sports","SUV","Luxury"].map(category=>`<button type="button" class="mobile-category ${mobileCategory===category?"active":""}" data-mobile-category="${category}" aria-pressed="${mobileCategory===category}"><svg viewBox="0 0 24 24" aria-hidden="true">${categoryIcon(category)}</svg>${category}</button>`).join("")}</nav>
      <div class="app-offer-heading"><h2>Discover Tristar Motors</h2></div><div class="offer-rail"><a href="#/" data-scroll="inventory" class="offer-card offer-card-link" aria-label="Browse Tristar Motors vehicles"><div class="offer-copy offer-copy-promo"><span>TRISTAR MOTORS</span><strong>${escapeHTML(dealer.tagline)}</strong><p>${escapeHTML(dealer.priceTagline)}</p><small class="offer-shop">Explore vehicles <b>→</b></small></div><img src="/images/brand/mercedes-26140.webp" alt="Mercedes-Benz at Tristar Motors" loading="eager"></a><article class="offer-card offer-card-secondary"><div class="offer-copy"><span>UPPER HILL · NAIROBI</span><strong>Viewing by appointment.</strong><p>${escapeHTML(dealer.address)}</p><a href="${waLink(undefined, `Hi ${dealer.name}, I'd like to arrange an appointment to view your vehicles.`)}" target="_blank" rel="noopener">Arrange a viewing <b>→</b></a></div><div class="offer-art" aria-hidden="true">↗</div></article></div><div class="offer-dots" aria-hidden="true"><i class="active"></i><i></i></div>
    </section>
    <section class="shell brand-section body-type-section"><div class="app-section-heading"><h2>Browse by vehicle type</h2><button class="plain-link" type="button" data-body-type="all">See all vehicles</button></div><div class="body-type-options" aria-label="Filter inventory by vehicle type">${bodyTypes.map(bodyTypePill).join("")}</div></section>
    <section class="shell section app-inventory" id="inventory"><div class="app-section-heading deals-heading"><h2><span class="desktop-section-title">Top Deals</span><span class="mobile-section-title">Popular Cars</span></h2><span class="results-meta" aria-live="polite" aria-atomic="true"><strong>${filtered.length}</strong> cars</span><a class="inventory-seeall" href="#/" data-scroll="inventory">See all <b>→</b></a></div><div class="inventory-filter-grid" aria-label="Filter inventory"><label class="inventory-filter"><span>Availability</span><select data-filter="availability" aria-label="Filter by availability"><option value="all" ${currentFilters.availability==="all"?"selected":""}>Any availability</option><option value="Available" ${currentFilters.availability==="Available"?"selected":""}>Available</option><option value="Sold" ${currentFilters.availability==="Sold"?"selected":""}>Sold</option><option value="Pending" ${currentFilters.availability==="Pending"?"selected":""}>Pending</option></select></label><label class="inventory-filter"><span>Fuel</span><select data-filter="fuel" aria-label="Filter by fuel">${selectOptions(fuels,currentFilters.fuel,"Any fuel")}</select></label><label class="inventory-filter"><span>Vehicle type</span><select data-filter="body" aria-label="Filter by vehicle type">${selectOptions(["SUV","Sedan","Truck","Coupe","Roadster","Wagon"],currentFilters.body,"Any type")}</select></label><label class="inventory-filter"><span>Transmission</span><select data-filter="transmission" aria-label="Filter by transmission">${selectOptions(transmissions,currentFilters.transmission,"Any transmission")}</select></label><label class="inventory-filter"><span>Make</span><select data-filter="make" aria-label="Filter by make">${selectOptions(makes,currentFilters.make,"Any make")}</select></label></div><div class="car-grid" id="car-grid">${filtered.length?filtered.map(card).join(""):`<div class="empty-state"><h3>No cars match those filters</h3><p>Try another availability, fuel type, vehicle type, transmission, or make.</p><button class="btn btn-dark" data-action="clear-filters">Clear filters</button></div>`}</div></section>
    <section class="shell section"><div class="app-section-heading"><h2>Shop with confidence</h2></div><div class="trust-section"><article class="trust-card"><div class="trust-icon">KSh</div><h3>Clear cash prices</h3><p>Published vehicles show their cash price in KSh.</p></article><article class="trust-card"><div class="trust-icon">⌖</div><h3>View by appointment</h3><p>Arrange a visit to ${escapeHTML(dealer.address)}.</p></article><article class="trust-card"><div class="trust-icon">✓</div><h3>Confirm availability</h3><p>Contact the team before visiting to confirm a vehicle is still available.</p></article></div></section>
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
  if (!car || car.make !== "Mercedes-Benz" || !(Number(car.price) > 0)) { renderNotFound(); return; }
  document.title = `${car.year} Mercedes-Benz ${car.model} | Tristar Motors`;
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
          <section class="vehicle-highlights section" aria-labelledby="vehicle-highlights-title">
            <div class="highlights-heading">
              <p class="eyebrow">The details</p>
              <h2 class="section-title" id="vehicle-highlights-title">Technical specifications</h2>
            </div>
            <div class="features-grid">
              <div class="feature-item"><span>Transmission</span><strong>${escapeHTML(car.transmission)}</strong></div>
              <div class="feature-item"><span>Engine</span><strong>${escapeHTML(car.engine)}</strong></div>
              <div class="feature-item"><span>Fuel</span><strong>${escapeHTML(car.fuel)}</strong></div>
              <div class="feature-item"><span>Mileage</span><strong>${number(car.mileage)} km</strong></div>
              <div class="feature-item"><span>Body style</span><strong>${escapeHTML(car.body)}</strong></div>
              <div class="feature-item"><span>Availability</span><strong>${escapeHTML(statusLabel(car.status))}</strong></div>
            </div>
          </section>
        </div>
        <aside class="detail-side">
          <section class="detail-title-card">
            <p class="availability-badge detail-availability ${statusClass(car.status)}">${escapeHTML(statusLabel(car.status))} · ${escapeHTML(car.body)}</p>
            <h1>${escapeHTML(car.year)} ${escapeHTML(car.make)} ${escapeHTML(car.model)}${trim?` ${escapeHTML(trim)}`:""}</h1>
            <p class="vin-line">VIN ${escapeHTML(car.vin)} · ${number(car.mileage)} km</p>
            <div class="vehicle-price">
              <span>Cash price</span>
              <strong>${priceLabel(car.price)}</strong>
            </div>
            <p class="vehicle-description">${escapeHTML(vehicleDescription(car))}</p>
            <a class="whatsapp vehicle-test-drive" href="${waLink(car, `Hi ${dealer.name}, I'd like to book a test drive for the ${car.year} ${car.make} ${car.model} (VIN ${car.vin}).`)}" target="_blank" rel="noopener">Book a test drive</a>
          </section>
        </aside>
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
  app.innerHTML = `${header()}<main class="shell admin-shell"><section class="admin-login-card"><p class="eyebrow">TRISTAR MOTORS · ADMIN</p><h1>Administrator sign in</h1>${configured ? `<p>Sign in to manage cars and customer messages.</p><form id="admin-login-form"><label class="field"><span class="field-label">Administrator</span><input name="username" value="Allan" readonly autocomplete="username"></label><label class="field"><span class="field-label">Password</span><input name="password" type="password" required autocomplete="current-password"></label><p class="login-error" id="login-error" role="alert"></p><button class="btn btn-primary" type="submit">Sign in</button></form>` : adminSession?.error ? `<p>Could not connect to the admin server. Start the site server, then reload this page.</p>` : `<p>Administrator sign-in is not set up. Add TRISTAR_ADMIN_PASSWORD in the server settings, then reload this page.</p>`}<p class="admin-local-note">If you’re locked out, change <code>TRISTAR_ADMIN_PASSWORD</code> in your Render service’s Environment settings, then redeploy.</p></section></main>${footer()}<div class="toast hidden"></div>`;
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
    : store.cars.map(car=>`<tr><td>${car.year} ${escapeHTML(car.make)} ${escapeHTML(car.model)}</td><td>${escapeHTML(car.vin||"—")}</td><td>${priceLabel(car.price)}</td><td>${number(car.mileage)} km</td><td>${statusControl(car)}</td><td><div class="table-actions"><button class="table-action" data-action="edit-car" data-id="${escapeHTML(car.id)}">Edit</button><button class="table-action delete" data-action="delete-car" data-id="${escapeHTML(car.id)}">Remove</button></div></td></tr>`).join("");
  app.innerHTML=`${header()}<main class="shell admin-shell"><div class="admin-top"><div><p class="eyebrow">DEALER ADMIN</p><h1>Car listings</h1><p class="text-muted" style="font-size:11px">Manage car listings and availability.</p></div><div class="admin-session-actions"><button class="btn btn-primary" type="button" data-action="open-vehicle-modal">Add a car <span aria-hidden="true">+</span></button><button class="btn btn-light" type="button" data-action="open-password-dialog">Change password</button></div></div><div class="admin-notice">Changes here update the cars shown on the website. Only share the admin password with people who should manage listings.</div><div class="admin-metrics"><div class="admin-metric"><span>Available vehicles</span><strong>${store.cars.filter(c=>c.status==="In Stock").length}</strong></div><div class="admin-metric"><span>Sold vehicles</span><strong>${store.cars.filter(c=>c.status==="Sold").length}</strong></div><div class="admin-metric"><span>Customer inquiries</span><strong>${store.leads.length}</strong></div></div><div class="admin-tabs"><button class="admin-tab ${!isLeads?"active":""}" data-admin-tab="inventory">Inventory (${store.cars.length})</button><button class="admin-tab ${isLeads?"active":""}" data-admin-tab="leads">Inquiries (${store.leads.length})</button></div><div class="admin-table-wrap"><table class="admin-table"><thead><tr>${isLeads?"<th>Received</th><th>Type</th><th>Name</th><th>Contact</th><th>Vehicle</th><th>Details</th><th></th>":"<th>Vehicle</th><th>VIN</th><th>Price</th><th>Mileage</th><th>Availability</th><th>Actions</th>"}</tr></thead><tbody>${rows||`<tr><td colspan="7">${isLeads?"No leads yet. Customer messages and requests will appear here.":"No vehicles in inventory."}</td></tr>`}</tbody></table></div>${!isLeads&&(edit||vehicleModalOpen)?`<dialog class="vehicle-modal" id="vehicle-editor" aria-labelledby="vehicle-modal-title"><section class="admin-form-card"><div class="vehicle-modal-heading"><div><p class="eyebrow">${edit?"UPDATE LISTING":"NEW LISTING"}</p><h2 id="vehicle-modal-title">${edit?"Edit Mercedes-Benz Listing":"Add a Mercedes-Benz"}</h2></div><button type="button" class="vehicle-modal-close" data-action="close-vehicle-modal" aria-label="Close">×</button></div><div class="vehicle-step-indicator"><span class="active" data-step-indicator="details">1. Vehicle details</span><span data-step-indicator="photos">2. Add pictures</span></div><p class="draft-autosave-note">Your progress is saved on this device and restored if you refresh.</p><form id="car-form" data-id="${edit?escapeHTML(edit.id):""}"><p class="car-form-error" data-car-form-error role="alert" hidden></p><section class="vehicle-form-step" data-vehicle-step="details"><div style="margin-bottom:14px;padding:14px;background:#fff;border-radius:8px;border:1px solid #e5e7eb"><div style="display:flex;align-items:center;gap:8px;margin-bottom:10px"><span style="display:inline-block;width:4px;height:14px;background:#b4862b;border-radius:2px"></span><strong style="font-size:12px;color:#111;text-transform:uppercase;letter-spacing:0.04em">Car basics</strong></div><div class="admin-form-grid"><label class="field"><span class="field-label">Model Year</span><input name="year" type="text" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" value="${escapeHTML(edit?.year??"")}" required placeholder="e.g. 2002" autocomplete="off"></label><label class="field"><span class="field-label">Class</span><input name="class" list="mercedes-class-suggestions" placeholder="Type or choose e.g. GLS-Class" value="${escapeHTML(edit?.class||"")}" required autocomplete="off"><datalist id="mercedes-class-suggestions">${MERCEDES_CLASSES.map(value=>`<option value="${escapeHTML(value)}"></option>`).join("")}</datalist></label><label class="field"><span class="field-label">Model</span><input name="model" list="mercedes-model-suggestions" placeholder="Pick or type e.g. C180 Avantgarde" value="${escapeHTML(edit?.model||"")}" required autocomplete="off"><datalist id="mercedes-model-suggestions">${MERCEDES_MODELS.map(m=>`<option value="${escapeHTML(m)}"></option>`).join("")}</datalist></label>${selectField("body","Body style",["Sedan","SUV","Coupe","Wagon","Roadster"],edit?.body||"",true)}${selectField("status","Availability",["In Stock","Pending","Sold"],edit?.status||"",true)}${priceInputField(edit?.price)}${inputField("mileage","Mileage (km)",edit?.mileage??"","number","required min=0 placeholder='e.g. 78200'")}</div></div><details class="admin-form-section"><summary>Vehicle specifications and condition (optional)</summary><div class="admin-form-section-body"><div style="display:flex;align-items:center;gap:8px;margin-bottom:10px"><span style="display:inline-block;width:4px;height:14px;background:#b4862b;border-radius:2px"></span><strong style="font-size:12px;color:#111;text-transform:uppercase;letter-spacing:0.04em">2. Powertrain &amp; Styling</strong></div><div class="admin-form-grid">${selectField("transmission","Transmission",["7G-TRONIC Plus Auto","9G-TRONIC Auto","8G-DCT Dual-Clutch","7G-DCT Dual-Clutch","Automatic","Manual"],edit?.transmission||"")}${selectField("drivetrain","Drivetrain",["RWD","4MATIC","AWD","FWD"],canonicalDrivetrain(edit?.drivetrain)||"")}${selectField("fuel","Fuel Type",["Petrol","Diesel","Hybrid","Plug-in Hybrid"],edit?.fuel||"")}<label class="field"><span class="field-label">Engine</span><input name="engine" list="mercedes-engine-suggestions" placeholder="Pick or type e.g. 2.0L Turbo M274 (184 hp)" value="${escapeHTML(edit?.engine||"")}"><datalist id="mercedes-engine-suggestions">${MERCEDES_ENGINES.map(e=>`<option value="${escapeHTML(e)}"></option>`).join("")}</datalist></label>${selectField("color","Exterior Colour",MERCEDES_COLORS,edit?.color||"")}${selectField("interior","Interior",MERCEDES_INTERIORS,edit?.interior||"")}${selectField("condition","Condition / Provenance",MERCEDES_CONDITIONS,edit?.condition||"")}</div></div></details><details class="admin-form-section"><summary>Features and description (optional)</summary><div class="admin-form-section-body"><div style="margin-bottom:14px;padding:14px;background:#fff;border-radius:8px;border:1px solid #e5e7eb"><div style="display:flex;align-items:center;gap:8px;margin-bottom:10px"><span style="display:inline-block;width:4px;height:14px;background:#b4862b;border-radius:2px"></span><strong style="font-size:12px;color:#111;text-transform:uppercase;letter-spacing:0.04em">3. Features &amp; Description</strong></div>${featuresField(edit?.features||[])}${descriptionField(edit?.description||"")}</div></details><details style="margin-top:10px;background:#f8f9fa;border:1px solid #e5e7eb;border-radius:6px;padding:10px 14px"><summary style="font-size:12px;font-weight:600;color:#4b5563;cursor:pointer">⚙ Optional Fields (VIN, Trim, Power, 0–100 km/h, Badge tags, 360)</summary><div class="admin-form-grid" style="margin-top:10px">${inputField("vin","VIN",edit?.vin||"","text","placeholder='Optional'")}${selectField("chassis","Chassis Code",MERCEDES_CHASSIS,edit?.chassis||"")}${inputField("trim","Trim Level",edit?.trim||"","text","placeholder='e.g. Avantgarde, AMG Line'")}${inputField("power","Engine Power",edit?.power||"","text","placeholder='e.g. 184 hp / 300 Nm'")}${inputField("acceleration","0–100 km/h",edit?.acceleration||"","text","placeholder='e.g. 7.9s'")}${selectField("badges","Badge Tag",["Available for viewing","New arrival","Low mileage"],(edit?.badges||[])[0]||"Available for viewing")}${inputField("image","Primary Image URL",edit?.image||"","text","placeholder='Auto-filled when uploading photos'")}${inputField("frameBase","360 Frame Base URL",edit?.frameBase||"","text","placeholder='Optional'")}</div></details><input type="hidden" name="make" value="Mercedes-Benz"></section><section class="vehicle-form-step" data-vehicle-step="photos"><section class="gallery-upload-editor"><h3>Vehicle pictures</h3><p>Choose photos, check the previews, then upload them.</p><div id="gallery-upload-workspace"></div></section><p class="required-note">Upload at least one Front photo (or set a primary image URL in Optional Fields) before saving. After uploading, choose Save vehicle to attach the photos to this listing.</p></section><div class="vehicle-step-actions" data-step-actions="details"><button class="btn btn-light" type="button" data-action="close-vehicle-modal">Cancel</button><button class="btn btn-primary" type="button" data-action="vehicle-step-next">Next: add pictures <span aria-hidden="true">→</span></button></div><div class="modal-actions vehicle-step-actions" data-step-actions="photos" hidden><button class="btn btn-light" type="button" data-action="vehicle-step-back">← Back to details</button><button class="btn btn-primary" id="save-vehicle-button" type="submit">${edit?"Save changes":"Save vehicle"}</button>${edit?`<button class="btn btn-light" type="button" data-action="close-vehicle-modal">Cancel</button>`:""}</div></form></section></dialog>`:""}${passwordChangeDialog()}</main>${footer()}<div class="toast hidden"></div>`;
  applyRestoredVehicleForm();
  renderGalleryUploadWorkspace();
  wireCommon();
  const carForm = document.querySelector("#car-form");
  carForm?.addEventListener("input", scheduleVehicleDraftSave);
  carForm?.addEventListener("change", scheduleVehicleDraftSave);
  const priceInput = document.querySelector("#admin-price-input");
  const priceUnit = document.querySelector("#admin-price-unit");
  if (priceInput) {
    updatePriceBadge(priceInput);
    priceInput.addEventListener("input", () => updatePriceBadge(priceInput));
    priceUnit?.addEventListener("change", () => updatePriceBadge(priceInput));
  }
  const vehicleDialog=document.querySelector("#vehicle-editor");
  if(vehicleDialog&&!vehicleDialog.open){vehicleDialog.showModal();lockPageScroll();}
  if(vehicleDialog)setVehicleStep(vehicleStep);
  vehicleDialog?.addEventListener("click",event=>{if(event.target===vehicleDialog)closeVehicleModal();});
  vehicleDialog?.addEventListener("cancel",event=>{event.preventDefault();closeVehicleModal();});
  vehicleDialog?.addEventListener("close",unlockPageScroll);
  document.querySelector("#password-change-dialog")?.addEventListener("close",unlockPageScroll);
  document.querySelector("#password-change-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form=event.currentTarget;
    const values=new FormData(form);
    const nextPassword=String(values.get("newPassword"));
    const confirmation=String(values.get("confirmPassword"));
    const errorNode=document.querySelector("#password-change-error");
    const submit=form.querySelector('button[type="submit"]');
    errorNode.textContent="";
    if(nextPassword!==confirmation){errorNode.textContent="The new passwords do not match.";return;}
    submit.disabled=true;
    try {
      await apiRequest("/api/auth/change-password",{method:"POST",body:JSON.stringify({currentPassword:String(values.get("currentPassword")),newPassword:nextPassword})});
      document.querySelector("#password-change-dialog")?.close();
      unlockPageScroll();
      adminSession={configured:true,authenticated:false};
      renderAdmin();
      toast("Password changed. Sign in with your new password.");
    } catch(error) {
      errorNode.textContent=error.message;
      submit.disabled=false;
    }
  });
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
    event.preventDefault();const formElement=event.currentTarget;if(!validateCarFormStep(formElement))return;const form=new FormData(formElement);const base=String(form.get("frameBase")||"").trim();
    if(uploadInProgress){setCarFormError("Wait for the photo upload to finish before saving this vehicle.");return;}
    if(photoCategories.some(([key])=>pendingPhotoFiles[key].length)){setCarFormError("Upload the selected photos before saving this vehicle.");return;}
    const hasMainImage=Boolean(String(form.get("image")||"").trim());
  if(!draftGallery.front.length&&!hasMainImage){setCarFormError("Add at least one Front photo, or enter a primary image URL under Optional Fields, before saving.");return;}
    setCarFormError();
    if(vehicleSaveInProgress)return;
    vehicleSaveInProgress=true;
    const saveButton=formElement.querySelector("#save-vehicle-button");
    if(saveButton){saveButton.disabled=true;saveButton.textContent="Saving vehicle…";}
    const rawPrice = form.get("price");
    let parsedPrice = null;
    if (rawPrice !== null && rawPrice !== "" && Number.isFinite(Number(rawPrice)) && Number(rawPrice) > 0) {
      const multiplier = form.get("priceUnit") === "millions" ? 1_000_000 : 1;
      parsedPrice = Math.round(Number(rawPrice) * multiplier);
    }
    const fields={year:Number(form.get("year")),make:String(form.get("make")||"Mercedes-Benz").trim(),model:String(form.get("model")).trim(),trim:String(form.get("trim")||"").trim(),body:String(form.get("body")||"Sedan"),price:parsedPrice,mileage:Number(form.get("mileage")||0),transmission:String(form.get("transmission")||"7G-TRONIC Plus Auto").trim(),engine:String(form.get("engine")||"").trim(),class:String(form.get("class")||"C-Class").trim(),chassis:String(form.get("chassis")||"").trim(),drivetrain:String(form.get("drivetrain")||"RWD").trim(),power:String(form.get("power")||"").trim(),acceleration:String(form.get("acceleration")||"").trim(),color:String(form.get("color")||"Polar White").trim(),interior:String(form.get("interior")||"Black Leather").trim(),condition:String(form.get("condition")||"Pre-owned").trim(),description:String(form.get("description")||"").trim(),features:String(form.get("featuresText")).split(/\r?\n/).map(value=>value.trim()).filter(Boolean),type:String(form.get("body")||"Sedan"),fuel:String(form.get("fuel")||"Petrol").trim(),vin:String(form.get("vin")||"").trim().toUpperCase(),status:String(form.get("status")||"In Stock"),image:String(form.get("image")).trim()||"/images/cars/g350d_front.jpg",badges:String(form.get("badges")||"").split(",").map(s=>s.trim()).filter(Boolean)};
    fields.id=editId||`${fields.make}-${fields.model}`.toLowerCase().replace(/[^a-z0-9]+/g,"-");fields.badge=String(form.get("badges")).split(",").map(value=>value.trim()).filter(Boolean)[0]||"Available";fields.galleryByCategory=structuredClone(draftGallery);fields.gallery=photoCategories.flatMap(([key])=>fields.galleryByCategory[key]);if(!fields.gallery.length)fields.gallery=[fields.image];fields.frameBase=base;fields.frames=base.includes("{frame}")?Array.from({length:24},(_,i)=>base.replace("{frame}",String(i+1).padStart(2,"0"))):[];
    try {
      const method=editId?"PUT":"POST";
      const savedCar=await apiRequest(editId?`/api/cars/${encodeURIComponent(fields.id)}`:"/api/cars",{method,body:JSON.stringify(fields)});
      if(editId)store.cars=store.cars.map(car=>car.id===savedCar.id?savedCar:car);
      else store.cars=[savedCar,...store.cars];
      await clearVehicleDraft();
      document.querySelector("#vehicle-editor")?.close();
      unlockPageScroll();
      vehicleSaveInProgress=false;editId=null;vehicleModalOpen=false;vehicleStep="details";uploadProgress=null;draftGallery=emptyDraftGallery();pendingPhotoFiles=emptyDraftGallery();adminTab="inventory";renderAdmin();toast("Vehicle listing saved");
    } catch(error) {
      vehicleSaveInProgress=false;
      const saveButton=formElement.querySelector("#save-vehicle-button");
      if(saveButton){saveButton.disabled=false;saveButton.textContent=editId?"Save changes":"Save vehicle";}
      setCarFormError(`Could not save vehicle: ${error.message}. Your uploaded photos are still available; correct the details and retry.`);
    }
  });
}
function passwordChangeDialog(){
  return `<dialog class="vehicle-modal password-modal" id="password-change-dialog" aria-labelledby="password-change-title"><section class="admin-form-card"><div class="vehicle-modal-heading"><div><p class="eyebrow">ACCOUNT SECURITY</p><h2 id="password-change-title">Change password</h2></div><button type="button" class="vehicle-modal-close" data-action="close-password-dialog" aria-label="Close">×</button></div><p class="password-dialog-copy">Choose a new password with at least 12 characters. You’ll need to sign in again after changing it.</p><form id="password-change-form"><label class="field"><span class="field-label">Current password</span><input name="currentPassword" type="password" autocomplete="current-password" required></label><label class="field"><span class="field-label">New password</span><input name="newPassword" type="password" autocomplete="new-password" minlength="12" maxlength="1024" required></label><label class="field"><span class="field-label">Confirm new password</span><input name="confirmPassword" type="password" autocomplete="new-password" minlength="12" maxlength="1024" required></label><p class="login-error" id="password-change-error" role="alert"></p><div class="vehicle-step-actions"><button class="btn btn-light" type="button" data-action="close-password-dialog">Cancel</button><button class="btn btn-primary" type="submit">Update password</button></div></form></section></dialog>`;
}

const MERCEDES_CLASSES = [
  "A-Class", "C-Class", "E-Class", "S-Class", "G-Class", "CLA-Class", "CLS-Class",
  "GLA-Class", "GLC-Class", "GLE-Class", "GLS-Class", "ML-Class", "Other"
];

const MERCEDES_CHASSIS = [
  "W204 Facelift", "W205", "W206",
  "W212 Facelift", "W213", "W214",
  "W221", "W222", "W223",
  "W463", "W166", "V167", "X253",
  "C218", "C257", "W176", "W177", "Other"
];

const MERCEDES_MODELS = [
  "C180 Avantgarde", "C200 AMG Line", "C250 AMG Line", "C300", "C43 AMG", "C63 AMG",
  "E200 Avantgarde", "E220d All-Terrain", "E250 Avantgarde", "E300 AMG Line", "E350", "E400",
  "S320L CDI", "S350d", "S400L Hybrid", "S450 4MATIC", "S500L", "S580",
  "G350d AMG Line", "G400d", "G500", "G63 AMG",
  "GLE250d", "GLE350d 4MATIC", "GLE400d", "GLE450 4MATIC", "GLE43 AMG", "GLE53 AMG",
  "GLC220d 4MATIC", "GLC250", "GLC300 AMG Line", "GLC43 AMG",
  "CLS350 AMG Sport", "CLS400", "CLS450 4MATIC", "CLS53 AMG",
  "A180 AMG Line", "A200", "A250", "A35 AMG", "A45 AMG",
  "ML350 AMG Line", "ML250 BlueTEC", "ML400", "GLA200", "GLA250 4MATIC"
];

const MERCEDES_ENGINES = [
  "1.6L Turbo M274 (156 hp)", "2.0L Turbo M274 (184 hp)", "2.0L Turbo M264 (255 hp)",
  "2.0L Turbo Diesel OM654 (194 hp)", "2.1L Twin-Turbo Diesel OM651 (170 hp)",
  "3.0L V6 Turbo Diesel OM642 (258 hp)", "3.0L Turbo Diesel OM656 (330 hp)",
  "3.5L V6 M276 (306 hp)", "3.0L V6 Bi-Turbo M276 (362 hp)", "4.0L V8 Bi-Turbo M177 (577 hp)"
];

const MERCEDES_COLORS = [
  "Polar White", "Obsidian Black", "Iridium Silver", "Selenite Grey",
  "Cavansite Blue", "Designo Diamond White", "Emerald Green", "Graphite Grey", "Mojave Silver", "Other"
];

const MERCEDES_INTERIORS = [
  "Black Leather / Brushed Aluminium", "Black Leather", "Beige / Espresso Leather",
  "Saddle Brown Leather", "Cranberry Red Leather", "Black Nappa Leather / Alcantara",
  "Macchiato Beige", "Other"
];

const MERCEDES_CONDITIONS = [
  "Pre-owned", "Well maintained", "Service history available", "Foreign used", "Locally used"
];

const POPULAR_FEATURES = [
  "AMG Line Styling", "Sunroof / Panoramic Roof", "Leather Ergonomic Seats",
  "360° Surround Camera", "Burmester Surround Sound", "Ambient Lighting (64-Colour)",
  "Multibeam LED Headlights", "Parktronic Parking Sensors", "Heated Seats",
  "Apple CarPlay / Android Auto", "Blind Spot Assist", "Active Brake Assist",
  "Keyless-GO & Push Start", "Power Tailgate / Easy-Pack", "Multifunction Steering with Paddles",
  "Dual-Zone Automatic Climate Control", "ECO Start/Stop System", "Original Audio / COMAND System"
];

function priceInputField(value) {
  const numVal = value ? Number(value) : "";
  const displayVal = numVal ? (numVal / 1_000_000) : "";
  const actual = numVal ? Math.round(numVal) : null;
  const initialBadge = actual ? `✓ KSh ${actual.toLocaleString("en-KE")} (${(actual / 1_000_000).toFixed(2).replace(/\.00$/, "").replace(/(\.[1-9])0$/, "$1")}M)` : "";
  return `
    <div class="field price-entry-field">
      <span class="field-label">Cash price</span>
      <div class="price-entry-controls">
        <input name="price" id="admin-price-input" type="number" step="0.01" min="0" value="${displayVal}" placeholder="e.g. 2.1" inputmode="decimal" aria-label="Cash price amount" required>
        <select name="priceUnit" id="admin-price-unit" aria-label="Cash price unit">
          <option value="millions" selected>Million KSh</option>
          <option value="ksh">KSh total</option>
        </select>
      </div>
      <span id="price-badge-preview" class="price-entry-preview">${initialBadge || "Enter a price, for example 2.1 million"}</span>
    </div>
  `;
}

function updatePriceBadge(input) {
  const badge = document.querySelector("#price-badge-preview");
  if (!badge) return;
  const unit = document.querySelector("#admin-price-unit")?.value;
  input.placeholder = unit === "millions" ? "e.g. 2.1" : "e.g. 2100000";
  input.step = unit === "millions" ? "0.01" : "1000";
  const val = input.value.trim();
  input.setCustomValidity("");
  if (!val || isNaN(val) || Number(val) <= 0) {
    badge.textContent = unit === "millions" ? "Enter a price in millions, for example 2.1" : "Enter the full KSh amount, for example 2100000";
    return;
  }
  const num = Number(val);
  if (unit === "millions" && num >= 1000) {
    input.setCustomValidity("This looks like a full KSh amount. Choose KSh total above.");
    badge.textContent = "This looks like a full KSh amount. Choose ‘KSh total’ above.";
    return;
  }
  const actual = Math.round(unit === "millions" ? num * 1_000_000 : num);
  const m = (actual / 1_000_000).toFixed(2).replace(/\.00$/, "").replace(/(\.[1-9])0$/, "$1");
  badge.textContent = `✓ KSh ${actual.toLocaleString("en-KE")} (${m}M)`;
}

function featuresField(featuresList = []) {
  const currentSet = new Set(featuresList.map(f => f.trim().toLowerCase()));
  return `
    <div class="field" style="grid-column:1/-1;margin-bottom:10px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <span class="field-label" style="font-weight:700;color:#1f2937">Vehicle Features</span>
        <span style="font-size:11px;color:#6b7280">Click pills to add/remove quickly, or edit text directly</span>
      </div>
      <div class="quick-feature-pills" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px">
        ${POPULAR_FEATURES.map(feat => {
          const active = currentSet.has(feat.toLowerCase());
          return `
            <button type="button" class="btn btn-light feature-pill-btn ${active ? "active" : ""}" data-action="toggle-feature-pill" data-feature="${escapeHTML(feat)}" style="padding:4px 9px;font-size:11px;border-radius:99px;border:1px solid ${active ? "#b4862b" : "#dce2e9"};background:${active ? "#b4862b1a" : "#fff"};color:${active ? "#8a661c" : "#374151"};font-weight:${active ? "600" : "400"}">
              ${active ? "✓ " : "+ "}${escapeHTML(feat)}
            </button>
          `;
        }).join("")}
      </div>
      <textarea name="featuresText" id="admin-features-textarea" rows="4" placeholder="One feature per line..." style="font-size:12px;line-height:1.5">${escapeHTML(featuresList.join("\n"))}</textarea>
    </div>
  `;
}

function toggleFeaturePill(featureName) {
  const textarea = document.querySelector("#admin-features-textarea");
  if (!textarea) return;
  const lines = textarea.value.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const index = lines.findIndex(l => l.toLowerCase() === featureName.toLowerCase());
  let isNowActive = false;
  if (index > -1) {
    lines.splice(index, 1);
    isNowActive = false;
  } else {
    lines.push(featureName);
    isNowActive = true;
  }
  textarea.value = lines.join("\n");
  document.querySelectorAll(`.feature-pill-btn`).forEach(btn => {
    if (btn.dataset.feature?.toLowerCase() === featureName.toLowerCase()) {
      btn.classList.toggle("active", isNowActive);
      btn.style.borderColor = isNowActive ? "#b4862b" : "#dce2e9";
      btn.style.background = isNowActive ? "#b4862b1a" : "#fff";
      btn.style.color = isNowActive ? "#8a661c" : "#374151";
      btn.style.fontWeight = isNowActive ? "600" : "400";
      btn.textContent = (isNowActive ? "✓ " : "+ ") + featureName;
    }
  });
}

function descriptionField(value = "") {
  return `
    <div class="field" style="grid-column:1/-1">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <span class="field-label" style="font-weight:700;color:#1f2937">Description</span>
        <button type="button" class="btn btn-light" data-action="auto-generate-description" style="padding:4px 9px;font-size:11px;font-weight:600;color:#b4862b;border-color:#b4862b">
          ✨ Auto-Generate Description
        </button>
      </div>
      <textarea name="description" id="admin-description-textarea" rows="3" placeholder="Description of the vehicle..." style="font-size:12px;line-height:1.5">${escapeHTML(value)}</textarea>
    </div>
  `;
}

function autoGenerateDescription() {
  const form = document.querySelector("#car-form");
  if (!form) return;
  const year = form.querySelector('[name="year"]')?.value || "";
  const model = form.querySelector('[name="model"]')?.value || "";
  const color = form.querySelector('[name="color"]')?.value || "";
  const transmission = form.querySelector('[name="transmission"]')?.value || "";
  const drivetrain = form.querySelector('[name="drivetrain"]')?.value || "";
  const descTextarea = document.querySelector("#admin-description-textarea");
  if (!descTextarea) return;

  const desc = `${year} Mercedes-Benz ${model}${color ? ` in ${color}` : ""}. ${transmission || "Automatic transmission"}${drivetrain ? `, ${drivetrain} drivetrain` : ""}. Pre-owned vehicle available to view at our Upper Hill showroom. Ask us about the documents available and feel free to arrange an independent assessment before purchase.`;
  descTextarea.value = desc;
  toast("Description auto-generated!");
}

function inputField(name,label,value="",type="text",extra="") { return `<label class="field"><span class="field-label">${label}</span><input name="${name}" type="${type}" value="${escapeHTML(value)}" ${extra}></label>`; }
function textareaField(name,label,value="") { return `<label class="field"><span class="field-label">${label}</span><textarea name="${name}" rows="4">${escapeHTML(value)}</textarea></label>`; }
function canonicalDrivetrain(value="") {
  const normalized=String(value).toLowerCase().replace(/[^a-z0-9]+/g," ").trim();
  if(normalized.includes("4matic")) return "4MATIC";
  if(normalized.includes("front wheel drive")||normalized==="fwd") return "FWD";
  if(normalized.includes("rear wheel drive")||normalized==="rwd") return "RWD";
  if(normalized.includes("all wheel drive")||normalized==="awd") return "AWD";
  return normalized ? String(value) : "";
}
function inventoryFieldOptions(field, additional=[]) {
  return [...new Set([...store.cars.map(car=>car[field]).filter(Boolean),...additional])].sort((a,b)=>a.localeCompare(b));
}
function selectField(name,label,values,selected,required=false) { const choices=[...new Set([...values,selected].filter(Boolean))]; return `<label class="field"><span class="field-label">${label}</span><select name="${name}" ${required?"required":""}>${selected?"":`<option value=\"\" selected disabled>Select ${escapeHTML(label.toLowerCase())}</option>`}${choices.map(v=>`<option value="${escapeHTML(v)}" ${v===selected?"selected":""}>${escapeHTML(v)}</option>`).join("")}</select></label>`; }

function wireCommon(){
  document.querySelector("#mobile-menu")?.addEventListener("click",e=>{const nav=document.querySelector("#main-nav"),open=!nav.classList.contains("open");nav.classList.toggle("open",open);e.currentTarget.setAttribute("aria-expanded",String(open));e.currentTarget.setAttribute("aria-label",open?"Close navigation":"Open navigation");});
  document.querySelectorAll("[data-saved-view]").forEach(button=>button.addEventListener("click",()=>{currentFilters.saved=!currentFilters.saved;mobileCategory="All";location.hash="#/";renderHome();document.querySelector("#inventory")?.scrollIntoView({behavior:"smooth"});}));
  document.querySelectorAll("[data-scroll]").forEach(a=>a.addEventListener("click",event=>{event.preventDefault();const scrollToTarget=()=>document.getElementById(a.dataset.scroll)?.scrollIntoView({behavior:"smooth",block:"start"});if(route()!=="#/"){location.hash="#/";setTimeout(scrollToTarget,80);}else scrollToTarget();}));
}
function closeVehicleModal(){
  if(uploadInProgress||vehicleSaveInProgress){setCarFormError(uploadInProgress?"Please wait for the photo upload to finish before closing this vehicle form.":"Please wait for the vehicle save to finish before closing this form.");return;}
  document.querySelector("#vehicle-editor")?.close();
  unlockPageScroll();
  vehicleModalOpen=false;
  editId=null;
  vehicleStep="details";
  for(const photos of Object.values(pendingPhotoFiles))for(const photo of photos)URL.revokeObjectURL(photo.preview);
  draftGallery=emptyDraftGallery();
  pendingPhotoFiles=emptyDraftGallery();
  void clearVehicleDraft();
  renderAdmin();
}
function setVehicleStep(step){
  vehicleStep=step;
  document.querySelectorAll("[data-vehicle-step]").forEach(section=>section.hidden=section.dataset.vehicleStep!==step);
  document.querySelectorAll("[data-step-actions]").forEach(actions=>actions.hidden=actions.dataset.stepActions!==step);
  document.querySelectorAll("[data-step-indicator]").forEach(label=>label.classList.toggle("active",label.dataset.stepIndicator===step));
  if(step==="photos")renderGalleryUploadWorkspace();
  scheduleVehicleDraftSave();
  document.querySelector("#vehicle-editor .admin-form-card")?.scrollTo({top:0,behavior:"smooth"});
}
function handleClick(event){
  const fav=event.target.closest("[data-favorite]");if(fav){const id=fav.dataset.favorite;store.favorites=store.favorites.includes(id)?store.favorites.filter(v=>v!==id):[...store.favorites,id];save();const detail=route().match(/^#\/cars\/([^/?]+)/);detail?renderVehicle(detail[1]):renderHome();return;}
  const tab=event.target.closest("[data-admin-tab]");if(tab)return;
  const button=event.target.closest("[data-action]");if(!button)return;
  const action=button.dataset.action,id=button.dataset.id||button.dataset.car;
  if(action==="open-password-dialog"){document.querySelector("#password-change-dialog")?.showModal();lockPageScroll();return;}
  if(action==="close-password-dialog"){document.querySelector("#password-change-dialog")?.close();unlockPageScroll();return;}
  if(action==="open-vehicle-modal"){vehicleModalOpen=true;editId=null;vehicleStep="details";uploadProgress=null;photoUploadMessage="Upload photos, then choose Save vehicle to attach them to this listing. Add at least one front photo.";draftGallery=emptyDraftGallery();pendingPhotoFiles=emptyDraftGallery();void clearVehicleDraft();renderAdmin();setVehicleStep("details");return;}
  if(action==="close-vehicle-modal"){closeVehicleModal();return;}
  if(action==="vehicle-step-next"){const form=document.querySelector("#car-form");if(form&&validateCarFormStep(form))setVehicleStep("photos");return;}
  if(action==="vehicle-step-back"){setVehicleStep("details");return;}
  if(action==="upload-photos"){uploadSelectedPhotos();return;}
  if(action==="toggle-feature-pill"){const f=button.dataset.feature;if(f)toggleFeaturePill(f);scheduleVehicleDraftSave();return;}
  if(action==="auto-generate-description"){autoGenerateDescription();scheduleVehicleDraftSave();return;}
  if(action==="use-main"){const input=document.querySelector('#car-form [name="image"]');if(input)input.value=button.dataset.useMain;scheduleVehicleDraftSave();toast("Main vehicle picture updated");return;}
  if(action==="clear-filters"){currentFilters={make:"all",model:"all",year:"all",body:"all",maxPrice:"all",maxMileage:"all",availability:"all",fuel:"all",transmission:"all",search:"",saved:false};mobileCategory="All";renderHome();}
  if(action==="toggle-search-filters"){searchExpanded=!searchExpanded;document.querySelector("#advanced-search")?.classList.toggle("expanded",searchExpanded);button.setAttribute("aria-expanded",String(searchExpanded));button.setAttribute("aria-label",`${searchExpanded?"Hide":"Show"} search filters`);}
  if(action==="toggle-filters")document.querySelector("#filter-panel")?.classList.toggle("expanded");
  if(action==="edit-car"){editId=id;vehicleModalOpen=true;vehicleStep="details";uploadProgress=null;photoUploadMessage="Upload photos, then choose Save vehicle to attach them to this listing. Add at least one front photo.";draftGallery=readDraftGallery(carById(id));pendingPhotoFiles=emptyDraftGallery();renderAdmin();setVehicleStep("details");}
  if(action==="cancel-edit"){editId=null;vehicleModalOpen=false;vehicleStep="details";draftGallery=emptyDraftGallery();pendingPhotoFiles=emptyDraftGallery();void clearVehicleDraft();renderAdmin();}
  if(action==="delete-car"&&confirm("Remove this vehicle from inventory?")){apiRequest(`/api/cars/${encodeURIComponent(id)}`,{method:"DELETE"}).then(()=>{store.cars=store.cars.filter(car=>car.id!==id);renderAdmin();toast("Vehicle removed");}).catch(error=>toast(`Could not remove vehicle: ${error.message}`));}
  if(action==="delete-lead"&&confirm("Remove this customer lead?")){store.leads.splice(Number(id),1);save();renderAdmin();toast("Lead removed");}
  if(action==="reset-demo"&&confirm("Restore the starting cars and clear saved cars and inquiries?")){apiRequest("/api/reset",{method:"POST"}).then(cars=>{store=resetDemoStore();store.cars=cars;editId=null;renderAdmin();toast("Sample inventory restored");}).catch(error=>toast(`Could not restore inventory: ${error.message}`));}
}

function render(){
  if(!inventoryLoaded)return;
  const r=route();
  if(!r.startsWith("#/admin")){
    location.hash="#/admin";
    return;
  }
  document.title="Admin | Tristar Motors";
  renderAdmin();
}
if ("scrollRestoration" in history) history.scrollRestoration="manual";
window.addEventListener("hashchange",()=>{
  if ("scrollRestoration" in history) history.scrollRestoration="manual";
  window.scrollTo({top:0,left:0,behavior:"instant"});
  render();
  requestAnimationFrame(()=>window.scrollTo({top:0,left:0,behavior:"instant"}));
});
app.addEventListener("click", handleClick);
refreshInventory().then(async()=>{await restoreVehicleDraft();render();}).catch((error)=>{
  console.error("Could not load vehicle inventory:",error);
  app.innerHTML=`${header()}<main class="shell section admin-connection-error"><h1>Admin server not connected</h1><p>Start the site with <code>npm run dev</code>, then reload this page.</p><a class="btn btn-dark" href="/">Back to website</a></main>${footer()}`;
});

// Shared delegated UI listeners for changes/submit events that survive rerenders.
app.addEventListener("change",event=>{
  if(event.target.matches("[data-status]"))return;
  if(event.target.matches("[data-filter]"))return;
  if(event.target.matches("#hero-make")){currentFilters.make=event.target.value;currentFilters.model="all";}
});
