# Tristar Motors Dealer Platform

A responsive, mobile-first dealership storefront and dealer workspace built with HTML, Tailwind CSS 4, and vanilla JavaScript. The visual language follows the provided Carea marketplace reference: bright white panels, soft gray surfaces, rounded cards, bold dark type, and simple high contrast controls. Desktop keeps the same visual language in a wider catalogue layout.

## Run locally

Requirements: Node.js 22.5+ and npm. Local development uses SQLite when `DATABASE_URL` is unset; production requires PostgreSQL and S3-compatible object storage.

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

When `DATABASE_URL` is set, inventory is stored in PostgreSQL. Without it, local development uses `dealer-platform/data/inventory.sqlite`. Startup creates missing tables and inserts starter listings only when their IDs do not already exist, preserving listing data and availability. Production requires `DATABASE_URL` and the five S3 settings in `.env.example`; uploads are WebP objects stored in the bucket, and the database stores their full public URLs. Production inventory and uploads are not written to the Render filesystem.

For the live Render service, export from the old app before deploying or restarting it. If the source admin password is unavailable, use the existing signed-in browser session: open the old live admin, sign in, and paste the contents of `server/export-live-inventory-browser.js` into that tab's DevTools Console. It downloads a private `inventory.json` containing the live records and referenced uploaded photos. Save that file in `/tmp/tristar-live-export/inventory.json` (create the folder first). This avoids a second password login and works on Render Free without SSH. If you do know the accepted source password, the command-line export is also available; set `TRISTAR_SOURCE_ADMIN_PASSWORD` in the ignored `dealer-platform/.env.local` and run from the repository root:

```bash
node --env-file=dealer-platform/.env.local dealer-platform/server/export-live-inventory.js /tmp/tristar-live-export
```

This saves all admin-visible car records and referenced uploaded WebP files privately under `/tmp/tristar-live-export`. Do not deploy/restart the old service until this finishes. Once the new code is deployed with Neon and R2 configured in Render, import the export through the new app's HTTPS API:

```bash
node --env-file=dealer-platform/.env.local dealer-platform/server/import-live-inventory.js /tmp/tristar-live-export
```

The import upserts the exported records and statuses, uploads legacy photos to R2, and records upload mappings so it can be retried. Set `TRISTAR_TARGET_ADMIN_PASSWORD` locally to the new Render `TRISTAR_ADMIN_PASSWORD` for the import; the old and new admin passwords can differ. Neon and R2 credentials do not need to be copied to the local machine. Keep the export private because inventory may contain VINs, and remove it after verifying the migration. `migrate-to-postgres.js` remains available for direct SQLite-to-Neon imports from networks that permit PostgreSQL connections.

### Backups

Use PostgreSQL point-in-time recovery or scheduled database backups, and enable versioning or a separate backup policy for the R2 bucket. The application does not create local filesystem backups in production.

### Administrator sign-in

The administrator username is **Allan**. Set `TRISTAR_ADMIN_PASSWORD` in the shell or ignored `.env.local` before starting the app; choose a strong password with at least 12 characters. There is no default password; the app never prints the password or stores it in the inventory database. The production admin password comes from the `TRISTAR_ADMIN_PASSWORD` environment variable. To rotate it, update that variable in Render; the production password form is disabled because the deployment uses environment-managed credentials. If this variable is missing or too short, the storefront remains available but admin sign-in and inventory changes stay disabled. Sessions use a secure, host-only cookie, last up to two hours, and are invalidated when the API restarts. Sign-in is rate-limited after repeated failures.

In local mode, the API binds to loopback (`127.0.0.1`) and refuses non-loopback clients. Admin sessions use a `Secure`, `HttpOnly`, `SameSite=Strict` cookie. The Render production configuration enables the public listener required by Render, serves it behind Render's TLS endpoint, and continues to require Allan's session for inventory changes. This is still a small prototype login rather than a reviewed production identity system; see the Render section for its operational limitations.

### Vehicle photo uploads

In the admin vehicle form, choose multiple images for **Front**, **Side**, **Rear**, **Interior**, and **Other pictures**. Selected originals are previewed locally first; choosing more photos appends to the previews, and individual pending photos can be removed before upload. Choose **Convert previews to WebP & upload** to convert in the browser with the bundled WebAssembly WebP encoder, then send the converted bytes to the configured S3-compatible bucket. The first newly uploaded Front photo becomes the main image; existing photos are retained and displayed by category. The API accepts only validated WebP files up to 8 MB each. Photos are uploaded before saving the vehicle record; if saving is canceled, the uploaded objects remain in the bucket and are not deleted implicitly. Existing URL-based main image and 360-frame fields remain available.

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

The workspace-level `render.yaml` serves the public website from the repository root, so `/` opens the root `index.html` and `/#/admin` opens the admin sign-in. The inventory API and admin page run on the same Node service. The Render service requires PostgreSQL and Cloudflare R2 environment variables; the server refuses to start in production if they are missing. Inventory stays in PostgreSQL and uploaded photos stay in R2 across restarts and replacements. Render generates the `TRISTAR_ADMIN_PASSWORD` secret for the admin sign-in.

Deploy the root website by pushing this workspace to your Git provider and creating a Render Blueprint from the repository root. The dealer-platform server can still be run locally with the commands above.

### 360° photo sequences

For each listing, upload an ordered set of 24–36 same-size WebP frames. In the dealer portal, set **360 frame URL base** to a path containing `{frame}`, such as `/images/cars/vehicle-123/frame-{frame}.webp`; files should then be named `frame-01.webp` through `frame-24.webp` (or the last frame in your sequence). The viewer preloads the sequence and supports pointer drag, touch swipe, arrow keys, and rotate buttons. Without a configured sequence, it shows the listing photo and a clear setup note.

## Included views and components

- Admin page at `/#/admin`: add, edit, or remove dealer inventory; change vehicle availability; and review or remove customer messages.
- Source modules: `src/main.js` (views and interactions), `src/data.js` (seed data and dealer details), `src/store.js` (local leads and saved vehicles), `src/viewer.js` (360° component), `src/styles.css` (Tailwind plus application styles), and `server/` (PostgreSQL / local SQLite inventory API and S3-compatible media storage).
- Body-type category WebP images are in `public/images/body-types/`; the original source images are kept in the workspace-level `Mercedes Body Types/` folder.

## Before using this for a live dealership

The dealer name, WhatsApp/phone number, Nairobi location, appointment-viewing note, and brand messaging are based on the public Tristar Motors Instagram profile. The sample cars, VINs, review text, and images remain demonstration content and must be replaced with verified inventory and approved content before launch. WhatsApp opens the configured number in `src/data.js`; map directions open the current Google Maps pin.

Vehicle prices are cash prices in Kenyan shillings (KES), formatted for the Kenya locale. Demonstration prices are indicative Kenyan asking-price comparisons, not verified prices for actual Tristar Motors stock. Unpriced vehicles remain in admin but are not shown on the public storefront until their cash price is confirmed.

To run the backend checks, use `npm test`. Before relying on the site for business-critical operations, review identity and authorization, operational monitoring and restore procedures; move leads from browser storage to a protected server-side system; and connect licensed vehicle-history reports and your CRM. Confirm every vehicle's cash price and inventory details with the dealer before publishing them.
