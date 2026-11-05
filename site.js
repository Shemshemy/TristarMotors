const vehicles = [
  { id: "bmw-5-series", make: "BMW", model: "520i M Sport", year: 2022, price: 8450000, mileage: "32,400 km", type: "Sedan", transmission: "Automatic", fuel: "Petrol", engine: "2.0L turbo", color: "Mineral White", image: "https://images.unsplash.com/photo-1555215695-3004980ad54e?auto=format&fit=crop&w=1200&q=85", badge: "Just arrived", description: "A beautifully balanced executive sedan with a refined cabin, confident performance and the everyday ease that makes every journey feel considered." },
  { id: "mercedes-glc", make: "Mercedes-Benz", model: "GLC 300 4MATIC", year: 2021, price: 11200000, mileage: "41,800 km", type: "SUV", transmission: "Automatic", fuel: "Petrol", engine: "2.0L turbo", color: "Obsidian Black", image: "https://images.unsplash.com/photo-1618843479313-40f8afb4b4d8?auto=format&fit=crop&w=1200&q=85", badge: "Tristar select", description: "Quietly assured and ready for the city or beyond, this GLC pairs Mercedes comfort with all wheel drive confidence." },
  { id: "porsche-macan", make: "Porsche", model: "Macan S", year: 2022, price: 15800000, mileage: "28,100 km", type: "SUV", transmission: "PDK Automatic", fuel: "Petrol", engine: "2.9L V6", color: "Dolomite Silver", image: "https://images.unsplash.com/photo-1611859266238-4b98091d9d9b?auto=format&fit=crop&w=1200&q=85", badge: "A little extra", description: "The Macan S brings sports car character to a versatile shape, with a beautifully finished interior and rewarding response." },
  { id: "audi-a5", make: "Audi", model: "A5 Sportback", year: 2021, price: 7650000, mileage: "36,200 km", type: "Coupe", transmission: "S tronic", fuel: "Petrol", engine: "2.0L TFSI", color: "Navarra Blue", image: "https://images.unsplash.com/photo-1606664515524-ed2f786a0bd6?auto=format&fit=crop&w=1200&q=85", badge: "Well kept", description: "Elegant proportions meet everyday practicality in this A5 Sportback, finished with Audi's understated attention to detail." },
  { id: "land-rover-defender", make: "Land Rover", model: "Defender 110 SE", year: 2023, price: 19750000, mileage: "18,700 km", type: "SUV", transmission: "Automatic", fuel: "Diesel", engine: "3.0L D300", color: "Pangea Green", image: "https://images.unsplash.com/photo-1519641471654-76ce0107ad1b?auto=format&fit=crop&w=1200&q=85", badge: "Low mileage", description: "A modern icon with genuine capability, generous space and a calm, thoughtful cabin for wherever the road leads." },
  { id: "porsche-911", make: "Porsche", model: "911 Carrera", year: 2020, price: 22900000, mileage: "22,600 km", type: "Coupe", transmission: "PDK Automatic", fuel: "Petrol", engine: "3.0L flat-six", color: "Carrara White", image: "https://images.unsplash.com/photo-1503376780353-7e6692767b70?auto=format&fit=crop&w=1200&q=85", badge: "Driver's choice", description: "A timeless sports car with a lively flat-six, engaging balance and the unmistakable character of a 911." },
];

const money = (amount) => `KSh ${new Intl.NumberFormat("en-KE").format(amount)}`;
const loadSaved = () => {
  try { return new Set(JSON.parse(localStorage.getItem("tristar-saved") || "[]")); }
  catch { return new Set(); }
};
let savedVehicles = loadSaved();
let activeType = "all";
let savedOnly = false;
let toastTimer;

function announce(message) {
  const toast = document.querySelector("#toast");
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2300);
}

function updateSavedCount() {
  document.querySelectorAll(".saved-count").forEach((el) => { el.textContent = savedVehicles.size; });
}

function renderVehicles() {
  const grid = document.querySelector("#car-grid");
  if (!grid) return;
  const make = document.querySelector("#make-filter")?.value || "all";
  const maxPrice = document.querySelector("#budget-filter")?.value || "all";
  const results = vehicles.filter((car) =>
    (make === "all" || car.make === make) &&
    (maxPrice === "all" || car.price <= Number(maxPrice)) &&
    (activeType === "all" || car.type === activeType) &&
    (!savedOnly || savedVehicles.has(car.id))
  );

  document.querySelector("#result-count").textContent = String(results.length).padStart(2, "0");
  document.querySelector("#empty-state").hidden = results.length > 0;
  grid.innerHTML = results.map((car) => `
    <article class="car-card">
      <a class="car-image-wrap" href="vehicle.html?car=${encodeURIComponent(car.id)}" aria-label="View ${car.year} ${car.make} ${car.model}">
        <img class="car-image" src="${car.image}" alt="${car.year} ${car.make} ${car.model}" loading="lazy">
        <span class="car-badge">${car.badge}</span>
      </a>
      <button class="save-car ${savedVehicles.has(car.id) ? "saved" : ""}" type="button" data-save="${car.id}" aria-label="${savedVehicles.has(car.id) ? "Remove" : "Save"} ${car.make} ${car.model}" aria-pressed="${savedVehicles.has(car.id)}">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.8 8.8c0 5.1-8.8 10-8.8 10s-8.8-4.9-8.8-10A4.7 4.7 0 0 1 12 6.4a4.7 4.7 0 0 1 8.8 2.4Z"/></svg>
      </button>
      <div class="car-info">
        <div class="car-topline"><span class="car-make">${car.make}</span><span class="car-year">${car.year}</span></div>
        <h3 class="car-title">${car.model}</h3>
        <div class="car-specs"><span>${car.mileage}</span><span>${car.type}</span><span>${car.fuel}</span></div>
        <div class="car-bottom"><strong class="car-price">${money(car.price)}</strong><a class="car-link" href="vehicle.html?car=${encodeURIComponent(car.id)}">View details <span>↗</span></a></div>
      </div>
    </article>`).join("");
  updateSavedCount();
}

function toggleSaved(id) {
  if (savedVehicles.has(id)) {
    savedVehicles.delete(id);
    announce("Removed from your saved cars");
  } else {
    savedVehicles.add(id);
    announce("Saved for later");
  }
  localStorage.setItem("tristar-saved", JSON.stringify([...savedVehicles]));
  renderVehicles();
}

function setupHome() {
  const grid = document.querySelector("#car-grid");
  if (!grid) return;
  savedOnly = new URLSearchParams(location.search).get("saved") === "1";
  renderVehicles();
  grid.addEventListener("click", (event) => {
    const button = event.target.closest("[data-save]");
    if (button) toggleSaved(button.dataset.save);
  });
  document.querySelector("#search-form").addEventListener("submit", (event) => {
    event.preventDefault();
    savedOnly = false;
    renderVehicles();
    document.querySelector("#inventory").scrollIntoView({ behavior: "smooth" });
  });
  document.querySelectorAll(".brand-chip").forEach((button) => button.addEventListener("click", () => {
    document.querySelector("#make-filter").value = button.dataset.make;
    savedOnly = false;
    renderVehicles();
    document.querySelectorAll(".brand-chip").forEach((chip) => chip.classList.toggle("selected", chip === button));
    document.querySelector("#inventory").scrollIntoView({ behavior: "smooth" });
  }));
  document.querySelectorAll(".filter-tab").forEach((button) => button.addEventListener("click", () => {
    activeType = button.dataset.type;
    savedOnly = false;
    document.querySelectorAll(".filter-tab").forEach((tab) => tab.classList.toggle("active", tab === button));
    renderVehicles();
  }));
  document.querySelector("#clear-filters").addEventListener("click", () => {
    document.querySelector("#make-filter").value = "all";
    document.querySelector("#budget-filter").value = "all";
    activeType = "all";
    savedOnly = false;
    document.querySelectorAll(".filter-tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.type === "all"));
    renderVehicles();
  });
  document.querySelectorAll(".saved-link").forEach((button) => button.addEventListener("click", () => {
    savedOnly = !savedOnly;
    renderVehicles();
    document.querySelector("#inventory").scrollIntoView({ behavior: "smooth" });
    announce(savedOnly ? "Showing your saved cars" : "Showing the full collection");
  }));
  document.querySelector("#newsletter-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    document.querySelector("#newsletter-message").textContent = "Thank you — you're on the list.";
    event.target.reset();
  });
}

function setupNavigation() {
  const menuButton = document.querySelector("#menu-toggle");
  const nav = document.querySelector("#main-nav");
  menuButton?.addEventListener("click", () => {
    const expanded = menuButton.getAttribute("aria-expanded") === "true";
    menuButton.setAttribute("aria-expanded", String(!expanded));
    menuButton.setAttribute("aria-label", expanded ? "Open menu" : "Close menu");
    nav.classList.toggle("open", !expanded);
  });
  nav?.querySelectorAll("a").forEach((link) => link.addEventListener("click", () => {
    nav.classList.remove("open");
    menuButton?.setAttribute("aria-expanded", "false");
    menuButton?.setAttribute("aria-label", "Open menu");
  }));
}

function setupVehiclePage() {
  const detail = document.querySelector("#vehicle-detail");
  if (!detail) return;
  const car = vehicles.find((vehicle) => vehicle.id === new URLSearchParams(location.search).get("car")) || vehicles[0];
  document.title = `${car.year} ${car.make} ${car.model} | Tristar Motors`;
  const setText = (selector, text) => { const el = detail.querySelector(selector); if (el) el.textContent = text; };
  const mainImage = detail.querySelector("#detail-image");
  mainImage.src = car.image;
  mainImage.alt = `${car.year} ${car.make} ${car.model}`;
  setText("#detail-make", car.make);
  setText("#detail-title", `${car.year} ${car.model}`);
  setText("#detail-price", money(car.price));
  setText("#detail-description", car.description);
  setText("#detail-mileage", car.mileage);
  setText("#detail-transmission", car.transmission);
  setText("#detail-fuel", car.fuel);
  setText("#detail-engine", car.engine);
  setText("#detail-color", car.color);
  setText("#detail-type", car.type);
  document.querySelector("#detail-inquiry").href = `mailto:hello@tristarmotors.co.ke?subject=${encodeURIComponent(`Enquiry: ${car.year} ${car.make} ${car.model}`)}`;
  const saveButton = detail.querySelector("#detail-save");
  const paintSaved = () => {
    saveButton.classList.toggle("saved", savedVehicles.has(car.id));
    saveButton.setAttribute("aria-pressed", String(savedVehicles.has(car.id)));
    saveButton.setAttribute("aria-label", savedVehicles.has(car.id) ? "Remove from saved cars" : "Save this car");
  };
  paintSaved();
  saveButton.addEventListener("click", () => {
    if (savedVehicles.has(car.id)) savedVehicles.delete(car.id); else savedVehicles.add(car.id);
    localStorage.setItem("tristar-saved", JSON.stringify([...savedVehicles]));
    paintSaved(); updateSavedCount(); announce(savedVehicles.has(car.id) ? "Saved for later" : "Removed from your saved cars");
  });
}

/* ==========================================================================
   DESIGN ENHANCEMENTS — Scroll Effects, Animations, Image Loading
   ========================================================================== */

function setupScrollEffects() {
  const header = document.querySelector('.site-header');
  const hero = document.querySelector('.hero');
  const heroPhoto = document.querySelector('.hero-photo');
  const scrollProgress = document.querySelector('#scroll-progress');
  const scrollTopBtn = document.querySelector('#scroll-top');

  if (hero && header) header.classList.add('header-hero');

  const checkScroll = () => {
    const y = window.scrollY;
    const max = document.documentElement.scrollHeight - window.innerHeight;

    if (header) header.classList.toggle('scrolled', y > (hero ? 80 : 10));
    if (scrollProgress && max > 0) scrollProgress.style.transform = `scaleX(${y / max})`;
    if (scrollTopBtn) scrollTopBtn.classList.toggle('visible', y > 600);

    if (heroPhoto && hero && y < hero.offsetHeight) {
      heroPhoto.style.backgroundPosition = `center calc(56% + ${y * 0.04}px)`;
    }
  };

  checkScroll();

  let ticking = false;
  window.addEventListener('scroll', () => {
    if (!ticking) {
      requestAnimationFrame(() => { checkScroll(); ticking = false; });
      ticking = true;
    }
  }, { passive: true });

  scrollTopBtn?.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
}

function setupRevealAnimations() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const observer = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (e.isIntersecting) {
        e.target.classList.add('visible');
        observer.unobserve(e.target);
      }
    });
  }, { threshold: 0.12, rootMargin: '0px 0px -50px 0px' });

  document.querySelectorAll('.reveal, .brand-list, .car-grid').forEach((el) => observer.observe(el));
}

function setupImageLoadEffects() {
  const attach = (img) => {
    if (img.dataset.la) return;
    img.dataset.la = '1';
    if (img.complete && img.naturalWidth) {
      img.classList.add('loaded');
    } else {
      img.addEventListener('load', () => img.classList.add('loaded'), { once: true });
      img.addEventListener('error', () => img.classList.add('loaded'), { once: true });
    }
  };

  document.querySelectorAll('.car-image, #detail-image').forEach(attach);

  new MutationObserver((muts) => {
    muts.forEach((m) => m.addedNodes.forEach((n) => {
      if (n.nodeType !== 1) return;
      if (n.classList?.contains('car-image')) attach(n);
      n.querySelectorAll?.('.car-image').forEach(attach);
    }));
  }).observe(document.body, { childList: true, subtree: true });
}

setupHome();
setupVehiclePage();
setupNavigation();
setupScrollEffects();
setupRevealAnimations();
setupImageLoadEffects();
