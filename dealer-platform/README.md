# Tristar Motors Dealer Platform

A responsive, mobile-first dealership storefront and dealer workspace built with HTML, Tailwind CSS 4, and vanilla JavaScript. The visual language follows the provided Carea marketplace reference: bright white panels, soft gray surfaces, rounded cards, bold dark type, and simple high contrast controls. Desktop keeps the same visual language in a wider catalogue layout.

## Run locally

Requirements: Node.js 22.5+ and npm. The local API uses Node's built-in `node:sqlite`.

```bash
cd dealer-platform
npm install
read -s -p "Set Allan's local admin password (12+ characters): " TRISTAR_ADMIN_PASSWORD
export TRISTAR_ADMIN_PASSWORD
printf '\n'
npm run dev
```

For a password that should load automatically on later starts, put `TRISTAR_ADMIN_PASSWORD=...` in the ignored `.env.local` file in `dealer-platform`; the local API loads it at startup. Keep that file private and never commit or share it.

Open the Vite URL printed in the terminal (normally `http://127.0.0.1:5173`). This starts the Vite storefront and a local inventory API on `http://127.0.0.1:4174`; Vite proxies `/api` requests to it. Create a production bundle with `npm run build`; preview it with `npm run preview` while the local API is running.

Inventory and availability are stored in `data/inventory.sqlite`, and uploaded photos are stored in the ignored `data/uploads/` directory; both survive page reloads and server restarts. On startup, existing local upload files under `public/images/cars/uploads/` are copied into `data/uploads/` without overwriting existing files. On first run, the database is initialized with the demonstration vehicles. The dealer portal at `#/admin` shows explicit Available, Pending, or Sold indicators and lets you change availability. Public listings and vehicle detail pages show each vehicle's current availability, including pending and sold vehicles. Customer leads and saved vehicles remain in this browser's local storage.

### Administrator sign-in

The administrator username is **Allan**. Set `TRISTAR_ADMIN_PASSWORD` in the shell or ignored `.env.local` before starting the app; choose a password with at least 12 characters. There is no default password; the app never prints the password or stores it in the inventory database. If this variable is missing or too short, the storefront remains available but admin sign-in and inventory changes stay disabled. Existing sessions are held in memory for up to eight hours and are invalidated when the API restarts. Sign-in is rate-limited after repeated failures.

In local mode, the API binds to loopback (`127.0.0.1`) and refuses non-loopback clients. Admin sessions use a `Secure`, `HttpOnly`, `SameSite=Strict` cookie. The Render production configuration enables the public listener required by Render, serves it behind Render's TLS endpoint, and continues to require Allan's session for inventory changes. This is still a small prototype login rather than a reviewed production identity system; see the Render section for its operational limitations.

### Vehicle photo uploads

In the admin vehicle form, choose multiple images for **Front**, **Side**, **Rear**, **Interior**, and **Other pictures**. Selected originals are previewed locally first; choosing more photos appends to the previews, and individual pending photos can be removed before upload. Choose **Convert previews to WebP & upload** to convert in the browser with the bundled WebAssembly WebP encoder, then send the converted files to `data/uploads/`. The first newly uploaded Front photo becomes the main image; existing photos are retained and displayed by category. The API accepts only validated WebP files up to 8 MB each. Photos are uploaded before saving the vehicle record; if saving is canceled, the uploaded files remain available in the local uploads folder and are not deleted implicitly. Existing URL-based main image and 360-frame fields remain available.

## Convert images to WebP

From the repository root, install Pillow and run the converter:

```bash
python -m pip install Pillow
python convert_to_webp.py
```

The defaults scan `~/Desktop/inspiration`, convert `.jpg`, `.jpeg`, and `.png` images at 82% quality, and put the WebP files in `dealer-platform/public/images/cars/`. Originals are preserved and existing output files are skipped. To choose a folder or quality:

```bash
python convert_to_webp.py ~/Pictures/cars --output "dealer-platform/public/images/cars" --quality 82
```

Use a converted image in a listing with the public URL, for example `/images/cars/my-car.webp`. The inventory editor keeps the primary-image URL and 360-frame URL-base options alongside its categorized device-upload workflow.

## Render deployment

The workspace-level `render.yaml` defines one Node web service for `dealer-platform`: Render runs `npm ci && npm run build`, starts the built app with `npm start`, and checks `/api/health`. The production server serves the Vite build and `/api` from the same origin. It binds to `0.0.0.0` on Render's `PORT`; local development remains bound to loopback.

The Blueprint provisions a **Starter** web service and a **1 GB persistent disk** mounted at `/var/data`. Render generates a secret for `TRISTAR_ADMIN_PASSWORD`; retrieve it from the service's Environment settings and use it for the Allan administrator sign-in. Do not put credentials in the Blueprint or commit them. The service fails startup if the production password is missing or too short. For a service created outside this Blueprint, add `TRISTAR_ADMIN_PASSWORD` manually in its Render Environment settings with a private value of at least 12 characters, then redeploy. `TRISTAR_DATA_DIR=/var/data` puts both `inventory.sqlite` and uploaded vehicle photos under the mounted disk. The first deployment on a new disk initializes the sample inventory; it does not automatically transfer your local SQLite records or ignored `data/uploads/` files. If you need to retain local changes, migrate the database and photos onto the mounted disk before using the live admin to make updates. Files bundled under the public uploads folder are copied into persistent storage on first startup without overwriting existing files.

A free web service cannot attach a persistent disk. Its filesystem is ephemeral, so the SQLite inventory and uploaded photos would be lost on redeploy, restart, or spin-down; it is not suitable for this data-backed app. A paid web-service plan and disk are required. The disk is billed separately by size; the Blueprint starts with 1 GB, and the compute plan is also billable. Check Render's [current pricing](https://render.com/pricing) and your selected region before creating the service rather than relying on a stale estimate. Render's [disk documentation](https://render.com/docs/disks) notes that a disk is single-instance, prevents scaling the service to multiple instances, and causes brief downtime during deploys. Keep independent database and photo backups; disk snapshots are not a substitute for application-level backups.

To deploy, push this workspace to a connected Git provider, select the repository in Render, and use the Blueprint from the repository root. Review the selected region, Starter compute plan, disk mount/size, and current costs, then create the service. No Render account, service, or deployment has been created from this workspace.

The production server accepts public requests behind Render's TLS-terminating load balancer. Admin writes still require Allan's password and authenticated session; the session cookie is Secure, HttpOnly, and SameSite=Strict. Sessions are held in memory and will need a fresh sign-in after a service restart. This remains a small single-instance prototype: review authentication, operational monitoring, backup/restore, and data management before relying on it for business-critical inventory.

### 360° photo sequences

For each listing, upload an ordered set of 24–36 same-size WebP frames. In the dealer portal, set **360 frame URL base** to a path containing `{frame}`, such as `/images/cars/vehicle-123/frame-{frame}.webp`; files should then be named `frame-01.webp` through `frame-24.webp` (or the last frame in your sequence). The viewer preloads the sequence and supports pointer drag, touch swipe, arrow keys, and rotate buttons. Without a configured sequence, it shows the listing photo and a clear setup note.

## Included views and components

- Storefront: vehicle search for make, model, year, body style, maximum price, and mileage; rounded body-type choices with WebP thumbnails; inventory filters for availability, fuel, body type, transmission, and make; vehicle cards with availability badges; saved cars; address/map shortcut; WhatsApp CTA; appointment-viewing information.
- Vehicle detail: gallery, configurable 360° viewer with a cover-cropped primary image, KSh price, vehicle description and highlights, and a direct WhatsApp test-drive link.
- Dealer portal at `#/admin`: add/edit/remove listings, change stock status, and review or remove incoming leads.
- Source modules: `src/main.js` (views and interactions), `src/data.js` (seed data and dealer details), `src/store.js` (local leads and saved vehicles), `src/viewer.js` (360° component), `src/styles.css` (Tailwind plus application styles), and `server/` (local SQLite inventory API).
- Body-type category WebP images are in `public/images/body-types/`; the original source images are kept in the workspace-level `Mercedes Body Types/` folder.

## Before using this for a live dealership

The dealer name, WhatsApp/phone number, Masaba Road address, appointment-viewing note, and brand messaging are based on the public Tristar Motors Instagram profile. The sample cars, VINs, review text, and images remain demonstration content and must be replaced with verified inventory and approved content before launch. WhatsApp opens the configured number in `src/data.js`; map directions use the configured address.

Vehicle prices are cash prices in Kenyan shillings (KES), formatted for the Kenya locale. Demonstration prices are indicative Kenyan asking-price comparisons, not verified prices for actual Tristar Motors stock. Unpriced vehicles remain in admin but are not shown on the public storefront until their cash price is confirmed.

To run the backend checks, use `npm test`. Before relying on the site for business-critical operations, review identity and authorization, operational monitoring and restore procedures; move leads from browser storage to a protected server-side system; and connect licensed vehicle-history reports and your CRM. Confirm every vehicle's cash price and inventory details with the dealer before publishing them.
