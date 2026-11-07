#!/usr/bin/env sh
set -eu

output_dir="public-site-dist"
rm -rf "$output_dir"
mkdir -p "$output_dir"
cp index.html site.css site.js vehicle.html favicon.ico favicon.svg inventory-seed.json "$output_dir/"
mkdir -p "$output_dir/images/cars" "$output_dir/images/body-types" "$output_dir/Logos"
cp -R images/cars/. "$output_dir/images/cars/"
for image in suv.webp sedan.webp coupe.webp roadster.webp wagon.webp; do
  cp "images/body-types/$image" "$output_dir/images/body-types/$image"
done
cp "Logos/Tristar Motors Classic Wordmark.png" "$output_dir/Logos/tristar-black.png"
cp Logos/tristar_motors_white.png "$output_dir/Logos/tristar-white.png"
mkdir -p "$output_dir/assets" "$output_dir/images/brand"
cp -R dealer-platform/dist/assets/. "$output_dir/assets/"
cp -R dealer-platform/dist/images/brand/. "$output_dir/images/brand/"

admin_js=$(sed -n 's/.*src="\([^"]*\.js\)".*/\1/p' dealer-platform/dist/index.html | head -n 1)
admin_css=$(sed -n 's/.*href="\([^"]*\.css\)".*/\1/p' dealer-platform/dist/index.html | head -n 1)
if [ -z "$admin_js" ] || [ -z "$admin_css" ]; then
  echo "Could not find the built admin JavaScript or stylesheet." >&2
  exit 1
fi
{
  printf 'const stylesheet = document.createElement("link");\n'
  printf 'stylesheet.rel = "stylesheet";\n'
  printf 'stylesheet.href = "%s";\n' "$admin_css"
  printf 'document.head.append(stylesheet);\n'
  printf 'await import("%s");\n' "$admin_js"
} > "$output_dir/admin-entry.js"
