import argparse
import json
import os
import re
import sys
import urllib.request
from pathlib import Path
from datetime import datetime, timedelta, timezone

import instaloader

BASE_DIR = Path("tristar_cars")
BASE_DIR.mkdir(exist_ok=True)

KNOWN_MAKES = {
    "alfa", "audi", "bmw", "bentley", "chevrolet", "chrysler", "citroen", "daihatsu",
    "dodge", "ferrari", "ford", "genesis", "gmc", "honda", "hyundai", "infiniti", "isuzu",
    "jaguar", "jeep", "kia", "lamborghini", "land", "lexus", "maserati", "mazda", "mercedes",
    "mini", "mitsubishi", "nissan", "opel", "peugeot", "porsche", "range", "renault", "subaru",
    "suzuki", "tesla", "toyota", "volkswagen", "volvo", "benz", "skoda", "seat", "proton",
    "mercedes-benz"
}


def sanitize_name(value: str | None) -> str | None:
    if not value:
        return None
    cleaned = re.sub(r"[^A-Za-z0-9]+", " ", value).strip()
    cleaned = re.sub(r"\s+", " ", cleaned)
    if not cleaned:
        return None
    if cleaned.isupper():
        return cleaned
    return cleaned.title()


def parse_caption(caption: str) -> dict:
    if not caption:
        return {}

    text = caption.strip()
    m = re.search(
        r"(?i)\b([A-Za-z]+(?:-[A-Za-z]+)?)\s+([A-Za-z0-9]+(?:[- ][A-Za-z0-9]+)*)\s+(\d{4})\b",
        text,
    )
    make = sanitize_name(m.group(1)) if m else None
    model = sanitize_name(m.group(2)) if m else None
    year = int(m.group(3)) if m else None

    if make and make not in KNOWN_MAKES and not any(make.lower().startswith(prefix.lower()) for prefix in ("mercedes", "bmw", "audi", "toyota", "nissan", "ford", "volvo", "vw")):
        return {}

    price_match = re.search(r"(?i)\b(?:KES|Price)\s*([\d,]+(?:\.\d+)?)\s*(M|Million|MN|K|Thousand)?\b", text)
    price_kes = None
    if price_match:
        value = float(price_match.group(1).replace(",", ""))
        suffix = (price_match.group(2) or "").upper()
        if suffix in {"M", "MILLION", "MN"}:
            price_kes = value * 1_000_000
        elif suffix in {"K", "THOUSAND"}:
            price_kes = value * 1_000
        else:
            price_kes = value

    w = re.search(r"(?i)\bWhatsApp\D+(\d[\d\s()+-]{7,})\b", text)
    whatsapp = re.sub(r"\D", "", w.group(1)) if w else None

    return {
        "make": make,
        "model": model,
        "year": year,
        "price_kes": price_kes,
        "whatsapp": whatsapp,
        "raw": text,
    }


def next_number(folder: Path) -> int:
    existing = []
    for path in folder.glob("*.jpg"):
        if path.stem.isdigit():
            existing.append(int(path.stem))
    return max(existing, default=0) + 1


def download_post(post: instaloader.Post, folder: Path, meta: dict, counter: int) -> bool:
    image_url = getattr(post, "display_url", None) or getattr(post, "url", None)
    if not image_url:
        return False

    image_path = folder / f"{counter:03d}.jpg"
    if image_path.exists():
        return False

    urllib.request.urlretrieve(image_url, image_path)

    metadata_path = folder / f"{counter:03d}.json"
    with metadata_path.open("w", encoding="utf-8") as fh:
        json.dump(meta, fh, indent=2)
    return True


def clear_downloaded_data(base_dir: Path) -> int:
    removed = 0
    for path in base_dir.rglob("*"):
        if path.is_file() and (
            path.suffix.lower() in {".jpg", ".json"} or path == base_dir / "index.html"
        ):
            path.unlink()
            removed += 1
    return removed


def build_slideshow(base_dir: Path, interval_ms: int = 5000) -> Path:
    slides = []
    path_tokens = {token.lower() for token in KNOWN_MAKES}

    for image_path in sorted(base_dir.rglob("*.jpg")):
        meta_path = image_path.with_suffix(".json")
        if not meta_path.exists():
            continue

        path_text = image_path.as_posix().lower()
        if not any(token in path_text for token in path_tokens):
            continue

        try:
            with meta_path.open("r", encoding="utf-8") as fh:
                meta = json.load(fh)
        except Exception:
            continue

        if not meta.get("permalink") and not meta.get("year") and not meta.get("price_kes"):
            continue

        rel_path = image_path.relative_to(base_dir).as_posix()
        title = image_path.parent.name
        if meta.get("year"):
            title = f"{image_path.parent.name} {meta.get('year')}"

        slides.append(
            {
                "image": rel_path,
                "title": title,
                "year": meta.get("year"),
                "price_kes": meta.get("price_kes"),
                "whatsapp": meta.get("whatsapp"),
                "date": meta.get("date"),
                "permalink": meta.get("permalink"),
            }
        )

    output = base_dir / "index.html"
    slide_data = json.dumps(slides, ensure_ascii=False)
    html_lines = [
        "<!DOCTYPE html>",
        "<html lang='en'>",
        "<head>",
        "  <meta charset='UTF-8' />",
        "  <meta name='viewport' content='width=device-width, initial-scale=1.0' />",
        "  <title>Car Slideshow</title>",
        "  <style>",
        "    :root { color-scheme: dark; }",
        "    * { box-sizing: border-box; }",
        "    body { margin: 0; font-family: Arial, sans-serif; background: #111; color: #fff; }",
        "    .slide-shell { min-height: 100vh; display: grid; place-items: center; background: radial-gradient(circle at center, #202020, #111 60%); }",
        "    .slide { position: relative; width: min(1200px, 92vw); height: min(82vh, 840px); border-radius: 20px; overflow: hidden; box-shadow: 0 30px 80px rgba(0,0,0,0.45); background: #000; }",
        "    .slide img { width: 100%; height: 100%; object-fit: cover; display: block; filter: saturate(1.1) contrast(1.05); }",
        "    .overlay { position: absolute; inset: auto 0 0 0; background: linear-gradient(180deg, transparent 0%, rgba(0,0,0,0.82) 40%, rgba(0,0,0,0.94) 100%); padding: 28px 30px 20px; }",
        "    .title { font-size: clamp(1.8rem, 2vw, 3rem); font-weight: 700; margin: 0 0 10px; }",
        "    .meta { font-size: 1rem; line-height: 1.6; color: #e9e9e9; }",
        "    .nav { position: absolute; inset: 50% 18px auto 18px; transform: translateY(-50%); display: flex; justify-content: space-between; pointer-events: none; }",
        "    button { pointer-events: auto; border: none; background: rgba(255,255,255,0.2); color: white; width: 52px; height: 52px; border-radius: 50%; font-size: 2rem; cursor: pointer; backdrop-filter: blur(6px); }",
        "    .counter { position: absolute; right: 18px; top: 18px; background: rgba(0,0,0,0.4); border-radius: 999px; padding: 0.6rem 0.9rem; font-size: 0.9rem; }",
        "    .progress-track { position: absolute; z-index: 2; inset: 0 0 auto; height: 5px; background: rgba(255,255,255,0.3); }",
        "    .progress-bar { width: 0; height: 100%; background: #e11d48; }",
        "    a { color: #9cd3ff; }",
        "    @media (max-width: 640px) { .overlay { padding: 20px 18px 18px; } .meta { font-size: 0.85rem; } }",
        "  </style>",
        "</head>",
        "<body>",
        "  <div class='slide-shell'>",
        "    <div class='slide'>",
        "      <div class='progress-track' role='progressbar' aria-label='Time until next car' aria-valuemin='0' aria-valuemax='100' aria-valuenow='0'><div class='progress-bar' id='progress'></div></div>",
        "      <div class='counter' id='counter'>1 / 1</div>",
        "      <img id='image' src='' alt='Car slide' />",
        "      <div class='overlay'>",
        "        <h1 id='title' class='title'>Car</h1>",
        "        <div id='meta' class='meta'></div>",
        "      </div>",
        "      <div class='nav'><button id='prev' aria-label='Previous slide'>‹</button><button id='next' aria-label='Next slide'>›</button></div>",
        "    </div>",
        "  </div>",
        "  <script>",
        f"const slides = {slide_data};",
        "let index = 0;",
        "const image = document.getElementById('image');",
        "const title = document.getElementById('title');",
        "const meta = document.getElementById('meta');",
        "const counter = document.getElementById('counter');",
        "const progressTrack = document.querySelector('.progress-track');",
        "const progress = document.getElementById('progress');",
        "function formatPrice(value) { if (value == null) return ''; return 'KES ' + Number(value).toLocaleString(); }",
        "function renderSlide() {",
        "  const slide = slides[index] || slides[0];",
        "  if (!slide) return;",
        "  image.src = slide.image;",
        "  image.alt = slide.title || 'Car';",
        "  title.textContent = slide.title || 'Car';",
        "  const bits = [];",
        "  if (slide.year) bits.push(slide.year);",
        "  if (slide.price_kes != null) bits.push(formatPrice(slide.price_kes));",
        "  if (slide.whatsapp) bits.push('WhatsApp: ' + slide.whatsapp);",
        "  if (slide.date) bits.push(new Date(slide.date).toLocaleDateString());",
        "  if (slide.permalink) bits.push('<a href=\"' + slide.permalink + '\" target=\"_blank\" rel=\"noopener\">Instagram</a>');",
        "  meta.innerHTML = bits.join(' • ');",
        "  counter.textContent = (index + 1) + ' / ' + slides.length;",
        "}",
        "function next() { if (!slides.length) return; index = (index + 1) % slides.length; renderSlide(); resetTimer(); }",
        "function prev() { if (!slides.length) return; index = (index - 1 + slides.length) % slides.length; renderSlide(); resetTimer(); }",
        "let timer = null;",
        "function resetTimer() {",
        "  if (timer) clearTimeout(timer);",
        "  progress.style.transition = 'none';",
        "  progress.style.width = '0';",
        "  progressTrack.setAttribute('aria-valuenow', '0');",
        "  requestAnimationFrame(() => {",
        "    progress.style.transition = 'width " + str(interval_ms) + "ms linear';",
        "    progress.style.width = '100%';",
        "  });",
        "  timer = setTimeout(() => { progressTrack.setAttribute('aria-valuenow', '100'); next(); }, " + str(interval_ms) + ");",
        "}",
        "document.getElementById('next').addEventListener('click', next);",
        "document.getElementById('prev').addEventListener('click', prev);",
        "document.addEventListener('keydown', (event) => { if (event.key === 'ArrowRight') next(); if (event.key === 'ArrowLeft') prev(); });",
        "renderSlide();",
        "resetTimer();",
        "</script>",
        "</body>",
        "</html>",
    ]
    output.write_text("\n".join(html_lines), encoding="utf-8")
    return output


def load_local_environment() -> None:
    env_path = Path(__file__).resolve().parents[1] / "dealer-platform" / ".env.local"
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip("\"'"))


def import_admin_drafts(drafts: list[dict], api_url: str) -> int:
    username = os.environ.get("TRISTAR_ADMIN_USERNAME", "Allan")
    password = os.environ.get("TRISTAR_ADMIN_PASSWORD")
    if not password:
        raise RuntimeError("Set TRISTAR_ADMIN_PASSWORD in dealer-platform/.env.local or the environment to import drafts.")

    def post(path: str, payload: dict, cookie: str = "") -> tuple[dict, str]:
        request = urllib.request.Request(
            f"{api_url.rstrip('/')}{path}",
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={"Content-Type": "application/json", **({"Cookie": cookie} if cookie else {})},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=60) as response:
            set_cookie = response.headers.get("Set-Cookie", "")
            token = set_cookie.split(";", 1)[0]
            return json.loads(response.read().decode("utf-8")), token

    _, cookie = post("/api/auth/login", {"username": username, "password": password})
    if not cookie:
        raise RuntimeError("Admin login did not return a session cookie.")
    imported = 0
    for offset in range(0, len(drafts), 20):
        result, _ = post("/api/instagram/drafts/import", {"drafts": drafts[offset:offset + 20]}, cookie)
        imported += int(result.get("imported", 0))
        print(f"Sent {min(offset + 20, len(drafts))} of {len(drafts)} posts to admin drafts.", flush=True)
    return imported


def post_image_urls(post: instaloader.Post) -> list[str]:
    def image_url(node: dict) -> str | None:
        candidates = node.get("image_versions2", {}).get("candidates", [])
        for candidate in candidates:
            if candidate.get("url"):
                return candidate["url"]
        return node.get("display_url") or node.get("display_uri") or node.get("display_src")

    node = post._node
    carousel = node.get("carousel_media") or []
    if carousel:
        return [url for url in (image_url(item) for item in carousel) if url][:20]
    edges = node.get("edge_sidecar_to_children", {}).get("edges", [])
    if edges:
        return [url for url in (image_url(edge.get("node", {})) for edge in edges) if url][:20]
    url = image_url(node)
    return [url] if url else []


def post_caption(post: instaloader.Post) -> str:
    caption = post._node.get("caption")
    if isinstance(caption, dict):
        return caption.get("text") or ""
    if isinstance(caption, str):
        return caption
    legacy_edges = post._node.get("edge_media_to_caption", {}).get("edges", [])
    return legacy_edges[0].get("node", {}).get("text", "") if legacy_edges else ""


def post_created_at(post: instaloader.Post) -> datetime | None:
    for key in ("date", "taken_at_timestamp", "taken_at"):
        value = post._node.get(key)
        if value:
            return datetime.fromtimestamp(float(value), timezone.utc)
    try:
        return post.date_utc.replace(tzinfo=timezone.utc)
    except (KeyError, TypeError, ValueError):
        return None


def main() -> None:
    parser = argparse.ArgumentParser(description="Collect recent Instagram posts and optionally save them as admin drafts.")
    parser.add_argument("--profile", default=os.environ.get("INSTAGRAM_PROFILE", "tristar.motors"), help="Instagram username to scrape")
    parser.add_argument("--max-posts", type=int, default=int(os.environ.get("MAX_POSTS", "0")), help="Maximum posts to scan (0 means all recent posts)")
    parser.add_argument("--base-dir", default=os.environ.get("BASE_DIR", "tristar_cars"), help="Directory for the legacy local export")
    parser.add_argument("--skip-scrape", action="store_true", help="Generate the slideshow from existing images without fetching new posts")
    parser.add_argument("--reset-data", action="store_true", help="Remove downloaded JPG/JSON files and the generated slideshow before scraping")
    parser.add_argument("--months", type=int, default=6, help="Look back this many months (default: 6)")
    parser.add_argument("--admin-import", action="store_true", help="Save every recent post as a draft in the authenticated admin queue")
    parser.add_argument("--api-url", default=os.environ.get("TRISTAR_ADMIN_API_URL", "http://127.0.0.1:4174"), help="Admin API base URL")
    args = parser.parse_args()

    if args.max_posts < 0:
        parser.error("--max-posts must be 0 or greater")
    if not 1 <= args.months <= 60:
        parser.error("--months must be between 1 and 60")
    if args.reset_data and args.skip_scrape:
        parser.error("--reset-data cannot be combined with --skip-scrape")
    if args.admin_import and args.reset_data:
        parser.error("--admin-import cannot be combined with --reset-data")

    load_local_environment()
    base_dir = Path(args.base_dir)
    if not args.admin_import:
        if args.reset_data:
            resolved_base_dir = base_dir.resolve()
            workspace_dir = Path.cwd().resolve()
            if resolved_base_dir == workspace_dir or workspace_dir not in resolved_base_dir.parents:
                parser.error("--reset-data is limited to a directory inside the current workspace")
        base_dir.mkdir(parents=True, exist_ok=True)
        if args.reset_data:
            removed = clear_downloaded_data(base_dir)
            print(f"Cleared {removed} downloaded/generated files from {base_dir}.")

    processed = 0
    scanned = 0
    if not args.skip_scrape:
        print("[1/4] Preparing Instagram connection…", flush=True)
        L = instaloader.Instaloader(sleep=True, quiet=True)
        username = os.environ.get("INSTAGRAM_USERNAME")
        password = os.environ.get("INSTAGRAM_PASSWORD")
        session_file = os.environ.get("INSTAGRAM_SESSION_FILE")
        if username and session_file:
            print(f"[2/4] Loading saved Instagram session for {username} from configured session file…", flush=True)
            L.load_session_from_file(username, session_file)
        elif username and password:
            print(f"[2/4] Signing into Instagram as {username} using the configured password…", flush=True)
            L.login(username, password)
        elif username:
            print(f"[2/4] Loading saved Instagram session for {username}…", flush=True)
            L.load_session_from_file(username)
        else:
            print("[2/4] No Instagram account configured; trying public profile access. This may not include post dates or media details.", flush=True)
        print(f"[3/4] Opening Instagram profile @{args.profile}…", flush=True)
        try:
            profile = instaloader.Profile.from_username(L.context, args.profile)
        except instaloader.LoginRequiredException as exc:
            raise RuntimeError(f"Instagram requires a logged-in session to open @{args.profile}. Create a session while signed into Instagram in a browser with `instaloader --load-cookies BROWSER --login={username or 'YOUR_USERNAME'}` (supported browser names are shown by `instaloader --help`), then set INSTAGRAM_USERNAME and INSTAGRAM_SESSION_FILE if you use a non-default session path. Instagram error: {exc}") from exc
        cutoff = datetime.now(timezone.utc) - timedelta(days=30.4375 * args.months)
        drafts = []
        seen_shortcodes = set()

        print(f"[4/4] Reading posts and selecting the last {args.months} months…", flush=True)
        posts = profile.get_posts()
        # Use timeline nodes directly to avoid one extra request per post. Missing dates
        # fail closed so a post outside the requested window cannot be imported by mistake.
        def wrap_timeline_node(node: dict) -> instaloader.Post:
            # Instagram's current XDT timeline uses `taken_at`; Instaloader's Post
            # ordering logic still reads `taken_at_timestamp` from each node.
            if "taken_at_timestamp" not in node and node.get("taken_at"):
                node = {**node, "taken_at_timestamp": node["taken_at"]}
            return instaloader.Post(L.context, node)

        posts._node_wrapper = wrap_timeline_node
        for index, post in enumerate(posts, start=1):
            if args.max_posts and index > args.max_posts:
                break
            scanned = index
            if post is None:
                continue
            post_date = post_created_at(post)
            if post_date is None:
                raise RuntimeError(f"Instagram returned post #{index} without a date, so I stopped to avoid importing posts outside the requested {args.months}-month window. Confirm the session is valid; if login via password failed, try importing browser cookies with Instaloader's `--load-cookies` option. No drafts have been sent yet.")
            if post_date < cutoff:
                break
            shortcode = str(getattr(post, "shortcode", "")).strip()
            if not shortcode or shortcode in seen_shortcodes:
                continue
            seen_shortcodes.add(shortcode)
            caption = post_caption(post)
            parsed = parse_caption(caption)
            image_urls = post_image_urls(post)
            meta = {
                "mediaId": shortcode,
                "shortcode": shortcode,
                "caption": caption,
                "date": post_date.isoformat() if post_date else None,
                "permalink": f"https://www.instagram.com/p/{shortcode}/",
                "imageUrls": image_urls,
                "parsed": parsed,
                "year": parsed.get("year"),
                "make": "Mercedes-Benz" if str(parsed.get("make") or "").lower().startswith("mercedes") else parsed.get("make"),
                "model": parsed.get("model"),
                "price": parsed.get("price_kes"),
                "mileage": None,
            }
            drafts.append(meta)

            if not args.admin_import and image_urls:
                make = parsed.get("make") or "Unsorted"
                model = parsed.get("model") or "Instagram"
                folder = base_dir / make / model
                folder.mkdir(parents=True, exist_ok=True)
                counter = next_number(folder)
                local_meta = {**meta, "num": counter, "price_kes": parsed.get("price_kes"), "whatsapp": parsed.get("whatsapp")}
                if download_post(post, folder, local_meta, counter):
                    processed += 1
            else:
                processed += 1

            if index % 25 == 0:
                print(f"Scanned {index} posts; collected {len(drafts)} posts from the last {args.months} months.", flush=True)
            elif index == 1:
                print(f"First post read ({post_date.date().isoformat()}); collecting posts newer than {cutoff.date().isoformat()}…", flush=True)

        if args.admin_import:
            print(f"Importing {len(drafts)} draft(s) to the admin API at {args.api_url}…", flush=True)
            imported = import_admin_drafts(drafts, args.api_url) if drafts else 0
            print(f"Saved {imported} new posts as drafts ({len(drafts)} collected; existing drafts kept intact).", flush=True)

    if args.admin_import:
        print(f"Done. Scanned {scanned} Instagram posts; collected {processed} drafts.")
    else:
        slideshow_path = build_slideshow(base_dir)
        print(f"Done. Scanned {scanned} posts; saved {processed} image posts.")
        print(f"Slideshow ready: {slideshow_path}")


if __name__ == "__main__":
    try:
        main()
    except instaloader.LoginException as exc:
        print(f"Instagram sign-in failed: {exc or 'Instagram returned a generic login failure with no details.'}", file=sys.stderr)
        print("What this means: Instagram rejected this login attempt before a scraper session was established. Your password is not saved by Instaloader unless a session is successfully created.", file=sys.stderr)
        print("Next step: log into Instagram normally in your browser, then try Instaloader's browser-cookie import (`instaloader --load-cookies BROWSER --login=USERNAME`). Do not share your password or cookie/session files.", file=sys.stderr)
        sys.exit(1)
    except (instaloader.ConnectionException, instaloader.LoginRequiredException) as exc:
        print(f"Instagram request failed: {exc or 'Instagram did not provide details.'}", file=sys.stderr)
        print("The profile may require a valid session, or Instagram may be temporarily throttling automated requests. Wait before retrying and confirm the saved session is valid.", file=sys.stderr)
        sys.exit(1)
    except FileNotFoundError as exc:
        print(f"Saved Instagram session file was not found: {exc.filename or exc}", file=sys.stderr)
        print("Sign into Instagram in your browser and import its session using Instaloader's `--load-cookies` option, or set INSTAGRAM_SESSION_FILE to an existing Instaloader session file.", file=sys.stderr)
        sys.exit(1)
    except Exception as exc:
        print(f"Scraper stopped: {exc}", file=sys.stderr)
        sys.exit(1)
