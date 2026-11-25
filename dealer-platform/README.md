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

### Import Instagram posts for review

The admin page has an **Instagram drafts** queue. To collect every post on Tristar Motors' Instagram profile from the last six months and send it to the queue, start the local site, install the scraper dependency, then run this from the repository root:

```bash
python3 -m venv .venv-instagram
.venv-instagram/bin/pip install -r script/requirements.txt
.venv-instagram/bin/python script/main.py --admin-import
```

The scraper reads `TRISTAR_ADMIN_PASSWORD` from the environment or ignored `dealer-platform/.env.local`, logs into the local admin API, collects post captions, dates, permalinks, and available image URLs, and saves drafts keyed by Instagram post ID. Reruns skip existing drafts so they do not overwrite your review edits. It does not publish listings. You can set `TRISTAR_ADMIN_API_URL` to an HTTPS admin API URL when importing into a deployed site; use a trusted network and keep the admin password private. If Instagram requires authentication to read the profile, first sign in normally to the intended Instagram account in a supported local browser, then try importing that browser session with `.venv-instagram/bin/instaloader --load-cookies BROWSER_NAME --login=YOUR_INSTAGRAM_USERNAME`. Use a browser name supported by `.venv-instagram/bin/instaloader --help`; this reads browser cookies, not the browser's saved password. Instaloader saves a session file for later reuse. Set `INSTAGRAM_USERNAME` in your local environment and, if you save it somewhere non-default, set `INSTAGRAM_SESSION_FILE` to its path. Keep session and cookie files private. The scraper prints progress stages and clearer next steps on common session, profile, and date errors. Instagram can limit automated requests, so an interrupted run can be retried safely.

Every imported post appears in the admin review queue, including posts whose captions could not be parsed. Correct the year, make, model, asking price, and mileage in the queue, save any changes, then choose **Approve and add to site**. Approval uploads the post's images to the configured object storage and creates an available listing. Posts without a usable image or confirmed price cannot be published from the queue. Rejected posts are retained as rejected records and do not reappear as pending drafts on later imports.

When `DATABASE_URL` is set, inventory is stored in PostgreSQL. Without it, local development uses `dealer-platform/data/inventory.sqlite`. Startup creates missing tables and inserts starter listings only when their IDs do not already exist, preserving listing data and availability. Production requires `DATABASE_URL` and the five S3 settings in `.env.example`; uploads are WebP objects stored in the bucket, and the database stores their full public URLs. Production inventory and uploads are not written to the Render filesystem.

For the live Render service, the browser export can capture all admin-visible inventory and referenced same-site car images, convert images to WebP in memory, and package them into one private `inventory.json`. While signed into the live admin, paste `server/export-live-inventory-browser.js` into that tab's DevTools Console. Save the downloaded file to `/tmp/tristar-live-export/inventory.json`. This avoids SSH and a second password login. The command-line exporter remains available for old `/images/cars/uploads/` files when the source password is known; set `TRISTAR_SOURCE_ADMIN_PASSWORD` in the ignored `dealer-platform/.env.local` and run from the repository root:

```bash
node --env-file=dealer-platform/.env.local dealer-platform/server/export-live-inventory.js /tmp/tristar-live-export
```

This saves all admin-visible car records and referenced uploaded WebP files privately under `/tmp/tristar-live-export`. Do not deploy/restart the old service until this finishes. Once the new code is deployed with Neon and R2 configured in Render, import the export through the new app's HTTPS API:

```bash
node --env-file=dealer-platform/.env.local dealer-platform/server/import-live-inventory.js /tmp/tristar-live-export
```

The import upserts the exported records and statuses, uploads referenced car images to R2, and records upload mappings so it can be retried. Set `TRISTAR_TARGET_ADMIN_PASSWORD` locally to the new Render `TRISTAR_ADMIN_PASSWORD` for the import; the old and new admin passwords can differ. Neon and R2 credentials do not need to be copied to the local machine. Keep the export private because inventory may contain VINs, and remove it after verifying the migration. New photos selected in the admin are converted to WebP in memory and uploaded through the API directly to R2; the database stores the returned public URL.

### Backups

Use PostgreSQL point-in-time recovery or scheduled database backups, and enable versioning or a separate backup policy for the R2 bucket. The application does not create local filesystem backups in production.

### Administrator sign-in

The administrator username is **Allan**. Set `TRISTAR_ADMIN_PASSWORD` in the shell or ignored `.env.local` before starting the app; use a unique, randomly generated password. There is no default password; the app never prints the password or stores it in the inventory database. The production admin password comes from the `TRISTAR_ADMIN_PASSWORD` environment variable. To rotate it, update that variable in Render and redeploy. If this variable is missing or too short, the storefront remains available but admin sign-in and inventory changes stay disabled. Sessions use a secure, host-only cookie, last up to two hours, and are invalidated when the API restarts. Sign-in is rate-limited after repeated failures.

In local mode, the API binds to loopback (`127.0.0.1`) and refuses non-loopback clients. Admin sessions use a `Secure`, `HttpOnly`, `SameSite=Strict` cookie. The Render production configuration enables the public listener required by Render, serves it behind Render's TLS endpoint, and continues to require Allan's session for inventory changes. This is still a small prototype login rather than a reviewed production identity system; see the Render section for its operational limitations.

### Vehicle photo uploads

In the admin vehicle form, choose multiple images for **Front**, **Side**, **Rear**, **Interior**, and **Other pictures**. Selected originals are previewed in the browser; choosing more photos appends to the previews, and individual pending photos can be removed before upload. The browser converts photos to WebP, and the API writes the bytes directly to Cloudflare R2 without creating local server files. The first newly uploaded Front photo becomes the main image; existing photos are retained and displayed by category. Production only accepts photo URLs from the configured public R2 domain. The API accepts validated WebP files up to 8 MB each. Photos are uploaded before saving the vehicle record; if saving is canceled, the uploaded objects remain in the bucket and are not deleted implicitly.

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

The converter is for preparing local development assets. For production listings, use the admin photo uploader so images are placed in R2 and the database stores their public HTTPS URLs.

## Render deployment

The workspace-level `render.yaml` serves the public website from the repository root, so `/` opens the root `index.html` and `/#/admin` opens the admin sign-in. The inventory API and admin page run on the same Node service. The Render service requires PostgreSQL and Cloudflare R2 environment variables; the server refuses to start in production if they are missing. Inventory stays in PostgreSQL and uploaded photos stay in R2 across restarts and replacements. Render generates the `TRISTAR_ADMIN_PASSWORD` secret for the admin sign-in.

Deploy the root website by pushing this workspace to your Git provider and creating a Render Blueprint from the repository root. The dealer-platform server can still be run locally with the commands above.

### 360° photo sequences

For each listing, store an ordered set of 24–36 same-size WebP frames in R2. Set **360 frame URL base** to the public R2 URL containing `{frame}`. The viewer preloads the sequence and supports pointer drag, touch swipe, arrow keys, and rotate buttons. Without a configured sequence, it shows the listing photo and a clear setup note.

## Included views and components

- Admin page at `/#/admin`: add, edit, or remove dealer inventory and change vehicle availability.
- Source modules: `src/main.js` (views and interactions), `src/data.js` (dealer details), `src/store.js` (browser-saved favorites), `src/viewer.js` (360° component), `src/styles.css` (Tailwind plus application styles), and `server/` (PostgreSQL / local SQLite inventory API and S3-compatible media storage).
- Body-type category WebP images are in `public/images/body-types/`; the original source images are kept in the workspace-level `Mercedes Body Types/` folder.

## Before using this for a live dealership

The dealer name, WhatsApp/phone number, Nairobi location, appointment-viewing note, and brand messaging are based on the public Tristar Motors Instagram profile. The sample cars, VINs, review text, and images remain demonstration content and must be replaced with verified inventory and approved content before launch. WhatsApp opens the configured number in `src/data.js`; map directions open the current Google Maps pin.

Vehicle prices are cash prices in Kenyan shillings (KES), formatted for the Kenya locale. Demonstration prices are indicative Kenyan asking-price comparisons, not verified prices for actual Tristar Motors stock. Unpriced vehicles remain in admin but are not shown on the public storefront until their cash price is confirmed.

To run the backend checks, use `npm test`. Before relying on the site for business-critical operations, review identity and authorization, operational monitoring and restore procedures; move leads from browser storage to a protected server-side system; and connect licensed vehicle-history reports and your CRM. Confirm every vehicle's cash price and inventory details with the dealer before publishing them.
