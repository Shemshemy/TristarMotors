#!/usr/bin/env python3
"""Convert JPEG and PNG inspiration photos to optimized WebP car images.

Install Pillow:
    python -m pip install Pillow

Run with the requested Desktop defaults:
    python convert_to_webp.py

Choose another source or output folder:
    python convert_to_webp.py ~/Desktop/inspiration --output "dealer-platform/public/images/cars"

The default source is ~/Desktop/inspiration and the default output is
dealer-platform/public/images/cars. Source photos are kept unchanged. Files
whose WebP destination already exists are skipped.
"""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image, ImageOps, UnidentifiedImageError


PROJECT_ROOT = Path(__file__).resolve().parent
DEFAULT_SOURCE = Path.home() / "Desktop" / "inspiration"
DEFAULT_OUTPUT = PROJECT_ROOT / "dealer-platform" / "public" / "images" / "cars"
SUPPORTED = {".jpg", ".jpeg", ".png"}


def convert_folder(source: Path, output: Path, quality: int = 82) -> tuple[int, int]:
    if not source.is_dir():
        raise NotADirectoryError(f"Source folder does not exist: {source}")
    output.mkdir(parents=True, exist_ok=True)
    paths = sorted(
        (p for p in source.iterdir() if p.is_file() and p.suffix.lower() in SUPPORTED),
        key=lambda p: p.name.lower(),
    )
    converted = skipped = 0
    for path in paths:
        target = output / f"{path.stem}.webp"
        if target.exists():
            print(f"Skip {path.name}: {target.name} already exists")
            skipped += 1
            continue
        try:
            with Image.open(path) as source_image:
                image = ImageOps.exif_transpose(source_image)
                if image.mode not in ("RGB", "RGBA"):
                    image = image.convert("RGBA" if "A" in image.getbands() else "RGB")
                image.save(target, "WEBP", quality=quality, method=6)
            print(f"Converted {path.name} -> {target}")
            converted += 1
        except (OSError, UnidentifiedImageError) as error:
            print(f"Could not convert {path.name}: {error}")
            skipped += 1
    if not paths:
        print(f"No .jpg, .jpeg, or .png files found in {source}")
    return converted, skipped


def main() -> int:
    parser = argparse.ArgumentParser(description="Batch-convert JPG, JPEG, and PNG images to WebP.")
    parser.add_argument("source", nargs="?", default=str(DEFAULT_SOURCE), help="input folder (default: ~/Desktop/inspiration)")
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT), help="output folder (default: dealer-platform/public/images/cars)")
    parser.add_argument("--quality", type=int, default=82, help="WebP quality 0–100 (default: 82)")
    args = parser.parse_args()
    if not 0 <= args.quality <= 100:
        parser.error("--quality must be between 0 and 100")
    source = Path(args.source).expanduser().resolve()
    output = Path(args.output).expanduser()
    if not output.is_absolute():
        output = PROJECT_ROOT / output
    try:
        done, skipped = convert_folder(source, output.resolve(), args.quality)
    except OSError as error:
        parser.error(str(error))
    print(f"Finished: {done} converted, {skipped} skipped. Output: {output.resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
