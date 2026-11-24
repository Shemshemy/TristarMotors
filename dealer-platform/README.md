# Tristar Motors Dealer Platform

A responsive, mobile-first dealership storefront and dealer workspace built with HTML, Tailwind CSS 4, and vanilla JavaScript. The visual language follows the provided Carea marketplace reference: bright white panels, soft gray surfaces, rounded cards, bold dark type, and simple high contrast controls. Desktop keeps the same visual language in a wider catalogue layout.

## Run locally

Requirements: Node.js 22.5+ and npm. The local API uses Node's built-in `node:sqlite`.

```bash
cd ..
npm --prefix dealer-platform install
read -s -p "Set Allan's local admin password (12+ characters): " TRISTAR_ADMIN_PASSWORD
export TRISTAR_ADMIN_PASSWORD
printf '\n'
npm run dev
```

For a password that should load automatically on later starts, put `TRISTAR_ADMIN_PASSWORD=...` in the ignored `.env.local` file in `dealer-platform`; the local API loads it at startup. Keep that file private and never commit or share it.

Open `http://127.0.0.1:4174` for the public website. Open `http://127.0.0.1:4174/#/admin` to sign in and manage cars. This builds the site and starts the website and local inventory API together. The dealer platform's old storefront is no longer used.

Inventory and availability are stored in `data/inventory.sqlite`, and uploaded photos are stored in the ignored `data/uploads/` directory. Locally, these survive page reloads and server restarts. On startup, existing local upload files under `public/images/cars/uploads/` are copied into `data/uploads/` without overwriting existing files. The database starts with the eight cars currently shown on the main website. The admin page at `/#/admin` edits those same listings, including their photos, descriptions, specifications, prices, and availability. The first startup after this update removes the old sample cars and adds the current website cars. Other custom listings and uploaded photos are kept. In production, the server uses `TRISTAR_DATA_DIR` when set; otherwise it uses a temporary directory under the operating system's temp path. That is a temporary deployment setting: files stored there, including vehicle changes and photos, can disappear when the service restarts or is replaced. Set `TRISTAR_DATA_DIR` to a mounted persistent disk path once permanent hosting storage is available.

### Backups and recovery

The server creates a backup at startup and every 24 hours in a worker thread, so backup hashing and file work do not block the web server. Admins can use **Download backup** on the inventory page to save a `.tar.gz` archive directly to their device. Each dated snapshot contains a consistent SQLite copy, the admin password hash when present, uploaded vehicle photos, and a SHA-256 manifest. The database snapshot is checked with SQLite's integrity check before it is saved. The latest seven snapshots are kept. Photo files are hard-linked into snapshots to avoid duplicating their storage; uploaded photo names are immutable. If the inventory database file is missing at startup, the server checks completed snapshots and restores the newest one with matching checksums.

To restore a snapshot, stop the server first. Remove the live database's `inventory.sqlite-wal` and `inventory.sqlite-shm` files, copy the snapshot's `inventory.sqlite` over the live database, replace `uploads/` with the snapshot's `uploads/` folder, and restore `admin-password.json` if it is included. Do not copy the snapshot's `manifest.json` or `.complete` marker into the live data directory. Start the server and confirm the inventory and photos are present. Keep a separate copy of the selected snapshot before restoring.

In production, Render also creates daily snapshots of the persistent disk and keeps them for seven days. Those are whole-disk restores; use the application snapshot above for SQLite recovery. Application backups are stored on the same persistent disk, so periodically copy a dated backup directory off the server for protection against disk loss. Render supports transferring files from disk-backed services with SSH/SCP; keep exported backups in a private location because they include vehicle inventory and the admin password hash.

### Administrator sign-in

The administrator username is **Allan**. Set `TRISTAR_ADMIN_PASSWORD` in the shell or ignored `.env.local` before starting the app; choose a strong password with at least 12 characters. There is no default password; the app never prints the password or stores it in the inventory database. Once signed in, use **Change password** on the admin page. A password change is stored as a salted hash in the ignored runtime file `data/admin-password.json` on the persistent disk. To recover access, change `TRISTAR_ADMIN_PASSWORD` in the server environment; a new value resets the stored password on the next start. If this variable is missing or too short, the storefront remains available but admin sign-in and inventory changes stay disabled. Sessions use a secure, host-only cookie, last up to two hours, and are invalidated when the API restarts. Sign-in is rate-limited after repeated failures.

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

The workspace-level `render.yaml` serves the public website from the repository root, so `/` opens the root `index.html` and `/#/admin` opens the admin sign-in. The inventory API and admin page run on the same Node service. The current temporary configuration stores SQLite and uploaded photos in ephemeral temporary storage; they can be lost on restart or service replacement. Add a persistent disk and set `TRISTAR_DATA_DIR` to its mount path when permanent hosting storage is ready.

Render generates the `TRISTAR_ADMIN_PASSWORD` secret for the admin sign-in. No persistent disk is required for the temporary configuration.

Deploy the root website by pushing this workspace to your Git provider and creating a Render Blueprint from the repository root. The dealer-platform server can still be run locally with the commands above.

### 360° photo sequences

For each listing, upload an ordered set of 24–36 same-size WebP frames. In the dealer portal, set **360 frame URL base** to a path containing `{frame}`, such as `/images/cars/vehicle-123/frame-{frame}.webp`; files should then be named `frame-01.webp` through `frame-24.webp` (or the last frame in your sequence). The viewer preloads the sequence and supports pointer drag, touch swipe, arrow keys, and rotate buttons. Without a configured sequence, it shows the listing photo and a clear setup note.

## Included views and components

- Admin page at `/#/admin`: add, edit, or remove dealer inventory; change vehicle availability; and review or remove customer messages.
- Source modules: `src/main.js` (views and interactions), `src/data.js` (seed data and dealer details), `src/store.js` (local leads and saved vehicles), `src/viewer.js` (360° component), `src/styles.css` (Tailwind plus application styles), and `server/` (local SQLite inventory API).
- Body-type category WebP images are in `public/images/body-types/`; the original source images are kept in the workspace-level `Mercedes Body Types/` folder.

## Before using this for a live dealership

The dealer name, WhatsApp/phone number, Masaba Road address, appointment-viewing note, and brand messaging are based on the public Tristar Motors Instagram profile. The sample cars, VINs, review text, and images remain demonstration content and must be replaced with verified inventory and approved content before launch. WhatsApp opens the configured number in `src/data.js`; map directions use the configured address.

Vehicle prices are cash prices in Kenyan shillings (KES), formatted for the Kenya locale. Demonstration prices are indicative Kenyan asking-price comparisons, not verified prices for actual Tristar Motors stock. Unpriced vehicles remain in admin but are not shown on the public storefront until their cash price is confirmed.

To run the backend checks, use `npm test`. Before relying on the site for business-critical operations, review identity and authorization, operational monitoring and restore procedures; move leads from browser storage to a protected server-side system; and connect licensed vehicle-history reports and your CRM. Confirm every vehicle's cash price and inventory details with the dealer before publishing them.
