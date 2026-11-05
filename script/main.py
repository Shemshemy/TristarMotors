import argparse
import json
import os
import re
import urllib.request
from pathlib import Path

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


def main() -> None:
    parser = argparse.ArgumentParser(description="Download vehicle posts from an Instagram account.")
    parser.add_argument("--profile", default=os.environ.get("INSTAGRAM_PROFILE", "tristar.motors"), help="Instagram username to scrape")
    parser.add_argument("--max-posts", type=int, default=int(os.environ.get("MAX_POSTS", "0")), help="Maximum posts to scan (0 means all posts)")
    parser.add_argument("--base-dir", default=os.environ.get("BASE_DIR", "tristar_cars"), help="Directory to save images and metadata")
    parser.add_argument("--skip-scrape", action="store_true", help="Generate the slideshow from existing images without fetching new posts")
    parser.add_argument("--reset-data", action="store_true", help="Remove downloaded JPG/JSON files and the generated slideshow before scraping")
    args = parser.parse_args()

    if args.max_posts < 0:
        parser.error("--max-posts must be 0 or greater")
    if args.reset_data and args.skip_scrape:
        parser.error("--reset-data cannot be combined with --skip-scrape")

    base_dir = Path(args.base_dir)
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
        L = instaloader.Instaloader(sleep=True, quiet=True)
        username = os.environ.get("INSTAGRAM_USERNAME")
        password = os.environ.get("INSTAGRAM_PASSWORD")
        if username and password:
            L.login(username, password)

        profile = instaloader.Profile.from_username(L.context, args.profile)

        seen_urls = set()

        for index, post in enumerate(profile.get_posts(), start=1):
            if args.max_posts and index > args.max_posts:
                break
            scanned = index

            if post is None or getattr(post, "is_video", False):
                continue

            caption = post.caption or ""
            data = parse_caption(caption)
            if not data.get("make") or not data.get("model"):
                continue

            image_url = getattr(post, "display_url", None) or getattr(post, "url", None)
            if not image_url or image_url in seen_urls:
                continue
            seen_urls.add(image_url)

            make = data["make"]
            model = data["model"]
            folder = base_dir / make / model
            folder.mkdir(parents=True, exist_ok=True)

            counter = next_number(folder)
            meta = {
                "num": counter,
                "year": data["year"],
                "price_kes": data["price_kes"],
                "whatsapp": data["whatsapp"],
                "date": getattr(post, "date_local", None).isoformat() if getattr(post, "date_local", None) else None,
                "permalink": f"https://www.instagram.com/p/{post.shortcode}/",
            }

            if download_post(post, folder, meta, counter):
                processed += 1

            if index % 25 == 0:
                print(f"Scanned {index} posts; downloaded {processed} car posts.", flush=True)

    slideshow_path = build_slideshow(base_dir)
    print(f"Done. Scanned {scanned} posts; downloaded {processed} car posts.")
    print(f"Slideshow ready: {slideshow_path}")


if __name__ == "__main__":
    main()
