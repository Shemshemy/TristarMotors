/**
 * Tristar Motors — Pre-Owned Mercedes-Benz Dealership
 * Upper Hill, Nairobi, Kenya
 */

const DEALER = {
  name: "Tristar Motors",
  phone: "+254 734 490 475",
  whatsapp: "254734490475",
  email: "sales@tristarmotors.co.ke",
  address: "La Colline Garden, Masaba Road, Upper Hill, Nairobi, Kenya",
  paymentNotice: "Outright Cash / Bank Wire (RTGS) / Banker's Cheque · Duty Paid in Full"
};

let vehicles = [];
let inventoryUnavailable = false;

async function loadVehicles() {
  let cars;
  try {
    const response = await fetch("/api/cars");
    if (!response.ok) throw new Error("Inventory service is unavailable.");
    cars = await response.json();
  } catch {
    const response = await fetch("/inventory-seed.json");
    if (!response.ok) throw new Error("Could not load vehicle listings.");
    cars = await response.json();
  }
  inventoryUnavailable = false;
  vehicles = cars
    .filter((car) => car.make === "Mercedes-Benz" && Number(car.price) > 0)
    .map((car) => {
      const gallery = orderVehicleGallery(car);
      return {
        ...car,
        class: car.class || car.model,
        type: car.type || car.body || "Sedan",
        mileage: `${new Intl.NumberFormat("en-US").format(Number(car.mileage) || 0)} km`,
        image: gallery[0] || car.image || "/images/cars/g350d_front.jpg",
        gallery,
        badge: car.status === "In Stock" ? (car.badge || car.badges?.[0] || "Available") : car.status,
        chassis: car.chassis || car.class || "Mercedes-Benz",
        features: Array.isArray(car.features) ? car.features : [],
      };
    });
}

function orderVehicleGallery(car) {
  const categoryRank = new Map();
  const categoryOrder = ["front", "side", "rear", "interior", "other"];
  categoryOrder.forEach((category, rank) => {
    for (const image of car.galleryByCategory?.[category] || []) {
      if (!categoryRank.has(image)) categoryRank.set(image, rank);
    }
  });

  const photos = [...new Set([
    car.image,
    ...(Array.isArray(car.gallery) ? car.gallery : []),
    ...categoryOrder.flatMap((category) => car.galleryByCategory?.[category] || []),
  ].filter(Boolean))];

  const photoRank = (url) => {
    const name = String(url).split(/[?#]/, 1)[0].split("/").pop().toLowerCase();
    if (/(^|[-_])(front|frontview|headon|head-on)([-_.]|$)/.test(name)) return 0;
    if (/(^|[-_])side([-_.]|$)/.test(name)) return 1;
    if (/(^|[-_])(rear|back|backview)([-_.]|$)/.test(name)) return 2;
    if (/(^|[-_])(interior|cockpit|dashboard|cabin)([-_.]|$)/.test(name)) return 3;
    return categoryRank.get(url) ?? 4;
  };

  return photos
    .map((url, index) => ({ url, index, rank: photoRank(url) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ url }) => url);
}

// Helper: Money Formatter
const money = (amount) => `KSh ${new Intl.NumberFormat("en-KE").format(Number(amount) || 0)}`;
const escapeHTML = (value="") => String(value).replace(/[&<>"']/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","\'":"&#39;"}[ch]));

// Helper: Direct WhatsApp Link Generator for Kenyan Dealer
function getWhatsAppUrl(text) {
  return `https://wa.me/${DEALER.whatsapp}?text=${encodeURIComponent(text)}`;
}

// Local Storage for Wishlist
const loadSaved = () => {
  try {
    return new Set(JSON.parse(localStorage.getItem("tristar-benzes-saved") || "[]"));
  } catch {
    return new Set();
  }
};

let savedVehicles = loadSaved();
let activeMake = "all";
let activeType = "all";
let activeBudget = "all";
let activeFuel = "all";
let activeSort = "featured";
let savedOnly = false;
const INVENTORY_PAGE_SIZE = 6;
let currentPage = 1;
let toastTimer = null;

// Toast Alert
function showToast(message) {
  const toast = document.querySelector("#toast");
  if (!toast) return;
  toast.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg> <span>${message}</span>`;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2500);
}

// Update Saved Count Badges
function updateSavedCount() {
  document.querySelectorAll(".saved-count").forEach((el) => {
    el.textContent = savedVehicles.size;
  });
  document.querySelectorAll(".saved-link").forEach((btn) => {
    btn.classList.toggle("has-saved", savedVehicles.size > 0);
  });
}

// Toggle Wishlist
function toggleSaved(id) {
  if (savedVehicles.has(id)) {
    savedVehicles.delete(id);
    showToast("Removed from your saved Benzes");
  } else {
    savedVehicles.add(id);
    showToast("Saved to your wishlist");
  }
  localStorage.setItem("tristar-benzes-saved", JSON.stringify([...savedVehicles]));
  updateSavedCount();
  currentPage = 1;
  renderVehicles();
}

// Render E-Commerce Inventory Grid
function renderVehicles() {
  const grid = document.querySelector("#car-grid");
  if (!grid) return;
  if (inventoryUnavailable) {
    grid.innerHTML = `<p class="inventory-error">We couldn’t load the cars. Please refresh the page.</p>`;
    const pagination = document.querySelector("#inventory-pagination");
    if (pagination) pagination.hidden = true;
    return;
  }

  // Filter Logic
  let results = vehicles.filter((car) => {
    const matchMake = activeMake === "all" || car.make === activeMake;
    const matchType = activeType === "all" || car.type === activeType;
    const matchFuel = activeFuel === "all" || car.fuel === activeFuel;

    let matchBudget = true;
    if (activeBudget !== "all") {
      matchBudget = activeBudget === "20000000+"
        ? car.price >= 20000000
        : car.price < Number(activeBudget);
    }
    const matchSaved = !savedOnly || savedVehicles.has(car.id);
    return matchMake && matchType && matchFuel && matchBudget && matchSaved;
  });

  // Sort Logic
  if (activeSort === "price-asc") {
    results.sort((a, b) => a.price - b.price);
  } else if (activeSort === "price-desc") {
    results.sort((a, b) => b.price - a.price);
  } else if (activeSort === "year-desc") {
    results.sort((a, b) => b.year - a.year);
  } else if (activeSort === "mileage-asc") {
    results.sort((a, b) => parseInt(a.mileage.replace(/\D/g, "")) - parseInt(b.mileage.replace(/\D/g, "")));
  }

  // Update Inventory Counts
  const countEl = document.querySelector("#result-count");
  if (countEl) countEl.textContent = String(results.length).padStart(2, "0");
  const totalPages = Math.ceil(results.length / INVENTORY_PAGE_SIZE);
  currentPage = Math.min(Math.max(currentPage, 1), Math.max(totalPages, 1));
  const pageResults = results.slice((currentPage - 1) * INVENTORY_PAGE_SIZE, currentPage * INVENTORY_PAGE_SIZE);

  // Saved Filter Indicator
  const savedIndicator = document.querySelector("#saved-indicator");
  if (savedIndicator) {
    savedIndicator.hidden = !savedOnly;
    if (savedOnly) {
      savedIndicator.innerHTML = `<span>Showing <strong>${results.length}</strong> saved Benz${results.length === 1 ? "" : "es"}</span> <button type="button" id="exit-saved">View All</button>`;
      document.querySelector("#exit-saved")?.addEventListener("click", () => {
        savedOnly = false;
        renderVehicles();
      });
    }
  }

  // Empty State Toggle
  const emptyState = document.querySelector("#empty-state");
  if (emptyState) emptyState.hidden = results.length > 0;

  // Render Product Cards
  grid.innerHTML = pageResults.map((car) => {
    const isSaved = savedVehicles.has(car.id);
    const waText = `Hello Tristar Motors, I am interested in purchasing the ${car.year} Mercedes-Benz ${car.model} (Cash Price: ${money(car.price)}). Is it available to view at your La Colline Garden showroom on Masaba Road?`;
    const waUrl = getWhatsAppUrl(waText);

    return `
      <article class="car-card" data-id="${escapeHTML(car.id)}">
        <a class="car-image-wrap" href="/cars/${encodeURIComponent(car.id)}" aria-label="View ${escapeHTML(car.year)} ${escapeHTML(car.make)} ${escapeHTML(car.model)}">
          <img class="car-image" src="${escapeHTML(car.image)}" alt="${escapeHTML(`${car.year} ${car.make} ${car.model} exterior`)}" loading="lazy">
          <span class="car-badge ${car.status === "Sold" ? "car-badge-sold" : car.status === "Pending" ? "car-badge-pending" : ""}">${escapeHTML(car.badge)}</span>
          <span class="car-condition-tag">${escapeHTML(car.chassis)}</span>
        </a>
        <button class="save-car ${isSaved ? "saved" : ""}" type="button" data-save="${escapeHTML(car.id)}" aria-label="${isSaved ? "Remove from saved" : "Save this car"}" aria-pressed="${isSaved}">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.8 8.8c0 5.1-8.8 10-8.8 10s-8.8-4.9-8.8-10A4.7 4.7 0 0 1 12 6.4a4.7 4.7 0 0 1 8.8 2.4Z"/></svg>
        </button>
        <div class="car-info">
          <div class="car-topline">
            <span class="car-make">${escapeHTML(car.class)} · ${escapeHTML(car.type)}</span>
            <span class="car-year">${escapeHTML(car.year)}</span>
          </div>
          <h3 class="car-title">
            <a href="/cars/${encodeURIComponent(car.id)}">${escapeHTML(car.model)}</a>
          </h3>
          <div class="car-specs">
            <div class="car-spec-item" title="Odometer">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><polyline points="12 6 12 12 16 14"/></svg>
              <span>${escapeHTML(car.mileage)}</span>
            </div>
            <div class="car-spec-item" title="Fuel Type">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 22V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v17M13 10h4l3 3v6a2 2 0 0 1-2 2h-1"/><circle cx="8" cy="12" r="2"/></svg>
              <span>${escapeHTML(car.fuel)}</span>
            </div>
            <div class="car-spec-item" title="Transmission">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>
              <span>${escapeHTML(String(car.transmission || "").split(" ")[0])}</span>
            </div>
            <div class="car-spec-item" title="Engine">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 14h6v4H4zM14 10h6v8h-6z"/><path d="M4 10V6h16v4"/></svg>
              <span>${escapeHTML(String(car.engine || "").split(" ")[0])}</span>
            </div>
          </div>
          <div class="car-bottom">
            <div class="car-price-block">
              <span class="car-price-label">Cash Price (Duty Paid)</span>
              <strong class="car-price">${money(car.price)}</strong>
            </div>
            <div class="car-card-actions">
              <a class="button button-whatsapp car-btn-wa" href="${waUrl}" target="_blank" rel="noopener" aria-label="Ask about ${escapeHTML(car.model)} on WhatsApp">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M12.04 2a9.9 9.9 0 0 0-8.48 15.02L2 22l5.14-1.35A9.9 9.9 0 1 0 12.04 2Zm0 17.98a8.1 8.1 0 0 1-4.13-1.13l-.3-.18-3.05.8.82-2.97-.2-.31A8.1 8.1 0 1 1 12.04 20Zm4.45-6.06c-.24-.12-1.43-.7-1.65-.78-.22-.08-.38-.12-.54.12-.16.24-.62.78-.76.94-.14.16-.28.18-.52.06-.24-.12-1.02-.38-1.94-1.2-.72-.64-1.2-1.43-1.34-1.67-.14-.24-.02-.37.1-.49.1-.1.24-.28.36-.42.12-.14.16-.24.24-.4.08-.16.04-.3-.02-.42-.06-.12-.54-1.3-.74-1.78-.2-.47-.4-.4-.54-.4h-.46c-.16 0-.42.06-.64.3-.22.24-.84.82-.84 2s.86 2.32.98 2.48c.12.16 1.68 2.56 4.06 3.58.56.24 1 .39 1.34.5.56.18 1.07.16 1.47.1.45-.07 1.43-.58 1.63-1.14.2-.56.2-1.04.14-1.14-.06-.1-.22-.16-.46-.28Z"/></svg>
                <span>WhatsApp</span>
              </a>
              <a class="car-link" href="/cars/${encodeURIComponent(car.id)}">
                <span>Details</span> <span aria-hidden="true">↗</span>
              </a>
            </div>
          </div>
        </div>
      </article>
    `;
  }).join("");

  renderInventoryPagination(totalPages);

  updateDynamicCounts();
}

function renderInventoryPagination(totalPages) {
  const pagination = document.querySelector("#inventory-pagination");
  if (!pagination) return;
  pagination.hidden = totalPages <= 1;
  if (pagination.hidden) return;

  let startPage = Math.max(1, currentPage - 2);
  let endPage = Math.min(totalPages, startPage + 4);
  startPage = Math.max(1, endPage - 4);
  const pageButtons = [];
  if (startPage > 1) {
    pageButtons.push(`<button class="page-number" type="button" data-page="1" aria-label="Page 1">1</button>`);
    if (startPage > 2) pageButtons.push(`<span class="page-ellipsis" aria-hidden="true">…</span>`);
  }
  for (let page = startPage; page <= endPage; page += 1) {
    pageButtons.push(`<button class="page-number ${page === currentPage ? "active" : ""}" type="button" data-page="${page}" aria-label="Page ${page}" ${page === currentPage ? 'aria-current="page"' : ""}>${page}</button>`);
  }
  if (endPage < totalPages) {
    if (endPage < totalPages - 1) pageButtons.push(`<span class="page-ellipsis" aria-hidden="true">…</span>`);
    pageButtons.push(`<button class="page-number" type="button" data-page="${totalPages}" aria-label="Page ${totalPages}">${totalPages}</button>`);
  }

  pagination.innerHTML = `
    <button class="page-step" type="button" data-page="${currentPage - 1}" ${currentPage === 1 ? "disabled" : ""} aria-label="Previous page">← <span>Previous</span></button>
    <div class="page-numbers">${pageButtons.join("")}</div>
    <button class="page-step" type="button" data-page="${currentPage + 1}" ${currentPage === totalPages ? "disabled" : ""} aria-label="Next page"><span>Next</span> →</button>
  `;
}

// Update Counts on Badges
function updateDynamicCounts() {
  document.querySelectorAll("[data-class-count]").forEach((el) => {
    const c = el.dataset.classCount;
    const count = c === "all" ? vehicles.length : vehicles.filter((v) => v.class === c).length;
    el.textContent = count;
  });

  document.querySelectorAll("[data-type-count]").forEach((el) => {
    const t = el.dataset.typeCount;
    const count = t === "all" ? vehicles.length : vehicles.filter((v) => v.type === t).length;
    el.textContent = count;
  });

  document.querySelectorAll("[data-make-count]").forEach((el) => {
    const make = el.dataset.makeCount;
    el.textContent = vehicles.filter((vehicle) => vehicle.make === make).length;
  });
}

// Setup Homepage Listeners
function setupHome() {
  const grid = document.querySelector("#car-grid");
  if (!grid) return;

  savedOnly = new URLSearchParams(location.search).get("saved") === "1";
  renderVehicles();
  updateSavedCount();

  // Wishlist clicks
  grid.addEventListener("click", (e) => {
    const saveBtn = e.target.closest("[data-save]");
    if (saveBtn) {
      e.preventDefault();
      e.stopPropagation();
      toggleSaved(saveBtn.dataset.save);
    }
  });

  document.querySelector("#inventory-pagination")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-page]");
    if (!button || button.disabled) return;
    currentPage = Number(button.dataset.page);
    renderVehicles();
    document.querySelector("#inventory")?.scrollIntoView({ behavior: "smooth", block: "start" });
  });

  // Search Form
  const searchForm = document.querySelector("#search-form");
  searchForm?.addEventListener("submit", (e) => {
    e.preventDefault();
    activeBudget = document.querySelector("#budget-filter")?.value || "all";
    activeFuel = document.querySelector("#fuel-filter")?.value || "all";
    savedOnly = false;
    currentPage = 1;

    renderVehicles();

    document.querySelector("#inventory")?.scrollIntoView({ behavior: "smooth" });
  });

  // Marque Chips
  document.querySelectorAll(".brand-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      activeMake = chip.dataset.make;
      const makeSelect = document.querySelector("#make-filter");
      if (makeSelect) makeSelect.value = activeMake;
      savedOnly = false;
      currentPage = 1;
      syncMakeChips(activeMake);
      renderVehicles();
      document.querySelector("#inventory")?.scrollIntoView({ behavior: "smooth" });
    });
  });

  // Body Type Cards
  document.querySelectorAll(".body-type-card").forEach((card) => {
    card.addEventListener("click", () => {
      activeType = card.dataset.type;
      const typeSelect = document.querySelector("#type-filter");
      if (typeSelect) typeSelect.value = activeType;
      savedOnly = false;
      currentPage = 1;
      syncTypeTabs(activeType);
      renderVehicles();
      document.querySelector("#inventory")?.scrollIntoView({ behavior: "smooth" });
    });
  });

  // Body Style Filter Tabs in Toolbar
  document.querySelectorAll(".filter-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      activeType = tab.dataset.type;
      const typeSelect = document.querySelector("#type-filter");
      if (typeSelect) typeSelect.value = activeType;
      savedOnly = false;
      currentPage = 1;
      syncTypeTabs(activeType);
      renderVehicles();
    });
  });

  // Sort Dropdown
  document.querySelector("#sort-select")?.addEventListener("change", (e) => {
    activeSort = e.target.value;
    currentPage = 1;
    renderVehicles();
  });

  // Clear Filters
  document.querySelector("#clear-filters")?.addEventListener("click", () => {
    activeMake = "all";
    activeType = "all";
    activeBudget = "all";
    activeFuel = "all";
    activeSort = "featured";
    savedOnly = false;
    currentPage = 1;

    if (document.querySelector("#make-filter")) document.querySelector("#make-filter").value = "all";
    if (document.querySelector("#type-filter")) document.querySelector("#type-filter").value = "all";
    if (document.querySelector("#budget-filter")) document.querySelector("#budget-filter").value = "all";
    if (document.querySelector("#fuel-filter")) document.querySelector("#fuel-filter").value = "all";
    if (document.querySelector("#sort-select")) document.querySelector("#sort-select").value = "featured";

    syncMakeChips("all");
    syncTypeTabs("all");
    renderVehicles();
  });

  // Header Wishlist Button
  document.querySelectorAll(".saved-link").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      if (savedVehicles.size === 0 && !savedOnly) {
        showToast("Your wishlist is empty. Tap the heart on any Mercedes to save it.");
        return;
      }
      savedOnly = !savedOnly;
      currentPage = 1;
      renderVehicles();
      document.querySelector("#inventory")?.scrollIntoView({ behavior: "smooth" });
      showToast(savedOnly ? `Showing ${savedVehicles.size} saved Mercedes-Benz vehicle${savedVehicles.size === 1 ? "" : "s"}` : "Showing all in-stock Mercedes-Benz vehicles");
    });
  });

  // Newsletter
  document.querySelector("#newsletter-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const msg = document.querySelector("#newsletter-message");
    if (msg) msg.textContent = "Thank you — you will receive private alerts for newly landed Mercedes-Benz vehicles.";
    e.target.reset();
  });
}

function syncMakeChips(make) {
  document.querySelectorAll(".brand-chip").forEach((chip) => {
    chip.classList.toggle("selected", chip.dataset.make === make);
  });
}

function syncTypeTabs(type) {
  document.querySelectorAll(".filter-tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.type === type);
  });
  document.querySelectorAll(".body-type-card").forEach((card) => {
    card.classList.toggle("active", card.dataset.type === type);
  });
}

// Navigation & Mobile Sheet
function setupNavigation() {
  const menuToggle = document.querySelector("#menu-toggle");
  const nav = document.querySelector("#main-nav");

  if (!menuToggle || !nav) return;

  const toggleNav = (open) => {
    menuToggle.setAttribute("aria-expanded", String(open));
    menuToggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
    nav.classList.toggle("open", open);
  };

  menuToggle.addEventListener("click", () => {
    const isOpen = menuToggle.getAttribute("aria-expanded") === "true";
    toggleNav(!isOpen);
  });

  nav.querySelectorAll("a").forEach((link) => {
    link.addEventListener("click", () => toggleNav(false));
  });

  document.addEventListener("click", (e) => {
    if (!nav.contains(e.target) && !menuToggle.contains(e.target) && nav.classList.contains("open")) {
      toggleNav(false);
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && nav.classList.contains("open")) {
      toggleNav(false);
    }
  });
}

// Scroll Effects (Header Glassmorphism)
function setupScrollEffects() {
  const header = document.querySelector(".site-header");
  const hero = document.querySelector(".hero");
  const scrollProgress = document.querySelector("#scroll-progress");
  const scrollTopBtn = document.querySelector("#scroll-top");
  const sectionLinks = [...document.querySelectorAll('#main-nav a[href^="#"]')];
  const navSections = sectionLinks
    .map((link) => ({ link, section: document.getElementById(link.getAttribute("href").slice(1)) }))
    .filter(({ section }) => section)
    .sort((a, b) => a.section.getBoundingClientRect().top - b.section.getBoundingClientRect().top);

  if (hero && header) {
    header.classList.add("header-hero");
  }

  const onScroll = () => {
    const y = window.scrollY;
    const max = document.documentElement.scrollHeight - window.innerHeight;

    if (header) {
      header.classList.toggle("scrolled", y > (hero ? 60 : 10));
    }
    if (scrollProgress && max > 0) {
      scrollProgress.style.transform = `scaleX(${Math.min(1, y / max)})`;
    }
    if (scrollTopBtn) {
      scrollTopBtn.classList.toggle("visible", y > 450);
    }
    if (navSections.length) {
      const marker = y + (header?.getBoundingClientRect().height || 76) + 4;
      let current = null;
      for (const entry of navSections) {
        const top = entry.section.getBoundingClientRect().top + y;
        if (top <= marker) current = entry;
        else break;
      }
      for (const { link } of navSections) {
        const active = current?.link === link;
        link.classList.toggle("active", active);
        if (active) link.setAttribute("aria-current", "location");
        else link.removeAttribute("aria-current");
      }
    }
  };

  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  scrollTopBtn?.addEventListener("click", () => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
}

// Dense E-Commerce Vehicle Page Setup (vehicle.html)
function setupVehiclePage() {
  const detail = document.querySelector("#vehicle-detail");
  if (!detail) return;

  const params = new URLSearchParams(location.search);
  const carId = decodeURIComponent(location.pathname.match(/^\/cars\/([^/]+)$/)?.[1] || params.get("car") || "");
  const car = carId ? vehicles.find((v) => v.id === carId) : vehicles[0];
  if (!car) {
    detail.innerHTML = `<div class="empty-state"><h1>Vehicle not found</h1><p>This vehicle may no longer be in our collection.</p><a class="button button-dark" href="index.html#inventory">Browse the collection</a></div>`;
    return;
  }

  document.title = `${car.year} Mercedes-Benz ${car.model} | Tristar Motors Nairobi`;

  const setText = (id, text) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };

  // Header & Title
  setText("detail-title", `${car.year} Mercedes-Benz ${car.model}`);
  setText("detail-eyebrow-make", car.make);
  setText("detail-type", car.type);
  setText("detail-badge", car.badge);
  setText("detail-status", car.status === "In Stock" ? "Available for viewing" : car.status);
  setText("detail-condition", car.condition || "Duty Paid · Verified Provenance");
  setText("detail-price", money(car.price));

  // Technical Specs
  setText("detail-chassis", car.chassis || "Mercedes-Benz");
  setText("detail-mileage", car.mileage);
  setText("detail-fuel", car.fuel);
  setText("detail-transmission", car.transmission);
  setText("detail-engine", car.engine);
  setText("detail-drivetrain", car.drivetrain);
  setText("detail-power", car.power);
  setText("detail-acceleration", car.acceleration);
  setText("detail-color", car.color);
  setText("detail-interior", car.interior || "Luxury Leather");
  setText("sticky-price", money(car.price));

  // Gallery
  const mainImage = document.getElementById("detail-image");
  const galleryImages = car.gallery?.length ? car.gallery : [car.image];
  let activeGalleryIndex = 0;
  if (mainImage) {
    mainImage.src = galleryImages[0];
    mainImage.alt = `${car.year} Mercedes-Benz ${car.model} exterior`;
  }

  const thumbContainer = document.getElementById("detail-thumbs");
  if (thumbContainer && galleryImages.length > 0) {
    thumbContainer.innerHTML = galleryImages.map((imgUrl, i) => `
      <button class="thumb-btn ${i === 0 ? "active" : ""}" type="button" data-index="${i}" aria-label="Angle ${i + 1}" aria-current="${i === 0 ? "true" : "false"}">
        <img src="${imgUrl}" alt="${car.year} Mercedes-Benz ${car.model} photo ${i + 1}" loading="lazy">
      </button>
    `).join("");

    const showGalleryImage = (index) => {
      activeGalleryIndex = (index + galleryImages.length) % galleryImages.length;
      if (mainImage) mainImage.src = galleryImages[activeGalleryIndex];
      thumbContainer.querySelectorAll(".thumb-btn").forEach((button, buttonIndex) => {
        const active = buttonIndex === activeGalleryIndex;
        button.classList.toggle("active", active);
        button.setAttribute("aria-current", String(active));
      });
    };

    thumbContainer.querySelectorAll(".thumb-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        showGalleryImage(Number(btn.dataset.index));
      });
    });

    const imageWrap = mainImage?.closest(".detail-image-wrap");
    if (imageWrap && galleryImages.length > 1) {
      let swipeStart = null;
      imageWrap.addEventListener("pointerdown", (event) => {
        if (event.pointerType === "mouse" || event.target.closest("a, button")) return;
        swipeStart = { x: event.clientX, y: event.clientY };
      }, { passive: true });
      imageWrap.addEventListener("pointerup", (event) => {
        if (!swipeStart) return;
        const deltaX = event.clientX - swipeStart.x;
        const deltaY = event.clientY - swipeStart.y;
        swipeStart = null;
        if (Math.abs(deltaX) < 40 || Math.abs(deltaX) < Math.abs(deltaY) * 1.25) return;
        showGalleryImage(activeGalleryIndex + (deltaX < 0 ? 1 : -1));
      }, { passive: true });
      imageWrap.addEventListener("pointercancel", () => { swipeStart = null; }, { passive: true });
    }
  }

  // Features Checklist
  const featuresList = document.getElementById("detail-features");
  if (featuresList && car.features) {
    featuresList.innerHTML = car.features.map((f) => `
      <li>
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
        <span>${f}</span>
      </li>
    `).join("");
  }

  // Direct WhatsApp & Phone CTAs for Cash Deal
  const waMessage = `Hello Tristar Motors, I am asking about the ${car.year} Mercedes-Benz ${car.model}. Is it still available, and when can I view it?`;
  const waUrl = getWhatsAppUrl(waMessage);

  const waBtn = document.getElementById("detail-wa");
  if (waBtn) waBtn.href = waUrl;

  const stickyWaBtn = document.getElementById("sticky-wa");
  if (stickyWaBtn) stickyWaBtn.href = waUrl;

  const callBtn = document.getElementById("detail-call");
  if (callBtn) callBtn.href = `tel:${DEALER.phone.replace(/\s+/g, "")}`;

  const emailBtn = document.getElementById("detail-email");
  if (emailBtn) {
    const subject = `Inquiry: ${car.year} Mercedes-Benz ${car.model}`;
    emailBtn.href = `mailto:${DEALER.email}?subject=${encodeURIComponent(subject)}`;
  }

  // Save / Wishlist
  const saveBtn = document.getElementById("detail-save");
  if (saveBtn) {
    const updateSave = () => {
      const isSaved = savedVehicles.has(car.id);
      saveBtn.classList.toggle("saved", isSaved);
      saveBtn.setAttribute("aria-pressed", String(isSaved));
    };
    updateSave();
    saveBtn.addEventListener("click", () => {
      toggleSaved(car.id);
      updateSave();
    });
  }

  // Related Mercedes-Benz vehicles in stock.
  const relatedGrid = document.getElementById("related-grid");
  if (relatedGrid) {
    const related = vehicles.filter((v) => v.id !== car.id).slice(0, 3);
    relatedGrid.innerHTML = related.map((r) => {
      const relatedWaText = `Hello Tristar Motors, I am interested in the ${r.year} Mercedes-Benz ${r.model}. Is it available to view?`;
      const relatedWaUrl = getWhatsAppUrl(relatedWaText);
      return `
      <article class="car-card">
        <a class="car-image-wrap" href="/cars/${encodeURIComponent(r.id)}">
          <img class="car-image" src="${r.image}" alt="${r.model}" loading="lazy">
          <span class="car-badge">${r.badge}</span>
        </a>
        <div class="car-info">
          <div class="car-topline"><span class="car-make">${r.class}</span><span class="car-year">${r.year}</span></div>
          <h4 class="car-title" style="font-size: 16px; margin: 4px 0 10px;"><a href="/cars/${encodeURIComponent(r.id)}">${r.model}</a></h4>
          <div class="car-bottom">
            <strong class="car-price" style="font-size: 18px;">${money(r.price)}</strong>
            <div class="car-card-actions">
              <a class="button button-whatsapp car-btn-wa" href="${relatedWaUrl}" target="_blank" rel="noopener" aria-label="Ask about ${escapeHTML(r.model)} on WhatsApp">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M12.04 2a9.9 9.9 0 0 0-8.48 15.02L2 22l5.14-1.35A9.9 9.9 0 1 0 12.04 2Zm0 17.98a8.1 8.1 0 0 1-4.13-1.13l-.3-.18-3.05.8.82-2.97-.2-.31A8.1 8.1 0 1 1 12.04 20Zm4.45-6.06c-.24-.12-1.43-.7-1.65-.78-.22-.08-.38-.12-.54.12-.16.24-.62.78-.76.94-.14.16-.28.18-.52.06-.24-.12-1.02-.38-1.94-1.2-.72-.64-1.2-1.43-1.34-1.67-.14-.24-.02-.37.1-.49.1-.1.24-.28.36-.42.12-.14.16-.24.24-.4.08-.16.04-.3-.02-.42-.06-.12-.54-1.3-.74-1.78-.2-.47-.4-.4-.54-.4h-.46c-.16 0-.42.06-.64.3-.22.24-.84.82-.84 2s.86 2.32.98 2.48c.12.16 1.68 2.56 4.06 3.58.56.24 1 .39 1.34.5.56.18 1.07.16 1.47.1.45-.07 1.43-.58 1.63-1.14.2-.56.2-1.04.14-1.14-.06-.1-.22-.16-.46-.28Z"/></svg>
                <span>WhatsApp</span>
              </a>
              <a class="car-link" href="/cars/${encodeURIComponent(r.id)}">Details ↗</a>
            </div>
          </div>
        </div>
      </article>
    `;
    }).join("");
  }
}

// Safe Initialization
async function enterAdminPortal() {
  document.body.classList.add("admin-portal");
  const app = document.getElementById("app");
  if (app) app.hidden = false;
  try {
    await import("./admin-entry.js");
  } catch (error) {
    if (app) app.innerHTML = `<main class="shell section"><h1>Admin page unavailable</h1><p>Could not load the admin page. Please try again.</p></main>`;
    console.error("Could not load admin page:", error);
  }
}

function handleAdminRoute() {
  if (location.hash.startsWith("#/admin")) {
    enterAdminPortal();
  } else if (document.body.classList.contains("admin-portal")) {
    location.reload();
  }
}

async function init() {
  window.addEventListener("hashchange", handleAdminRoute);
  if (location.hash.startsWith("#/admin")) {
    enterAdminPortal();
    return;
  }
  try {
    await loadVehicles();
  } catch (error) {
    console.error("Could not load website inventory:", error);
    inventoryUnavailable = true;
  }
  setupHome();
  setupVehiclePage();
  setupNavigation();
  setupScrollEffects();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
