#!/usr/bin/env bash
# Publishes the files in media/ to the configured public media CDN and prints
# their addresses. Objects are keyed by content hash, cached forever and never overwritten.
# Run through direnv; PUBLIC_SITE_MEDIA_CDN_* settings come from the local environment.
# Uploader credentials are loaded from explicitly named pass entries or AWS env variables.
set -euo pipefail

cd "$(dirname "$0")/.."
readonly ENDPOINT="${PUBLIC_SITE_MEDIA_CDN_ENDPOINT:?Set PUBLIC_SITE_MEDIA_CDN_ENDPOINT}"
readonly REGION="${PUBLIC_SITE_MEDIA_CDN_REGION:?Set PUBLIC_SITE_MEDIA_CDN_REGION}"
readonly BUCKET="${PUBLIC_SITE_MEDIA_CDN_BUCKET:?Set PUBLIC_SITE_MEDIA_CDN_BUCKET}"
readonly CDN="${PUBLIC_SITE_MEDIA_CDN_URL:?Set PUBLIC_SITE_MEDIA_CDN_URL}"
readonly PREFIX="${PUBLIC_SITE_MEDIA_CDN_PREFIX:?Set PUBLIC_SITE_MEDIA_CDN_PREFIX}"

# Use the system CA bundle when available; AWS_CA_BUNDLE may override it.
export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_DEFAULT_REGION="$REGION" AWS_PAGER=""
[[ -n "${AWS_CA_BUNDLE:-}" || ! -f /etc/ssl/cert.pem ]] || export AWS_CA_BUNDLE=/etc/ssl/cert.pem
[[ -n "${AWS_ACCESS_KEY_ID:-}" ]] || AWS_ACCESS_KEY_ID=$(pass show "${MEDIA_ACCESS_KEY_PASS_ENTRY:?Set MEDIA_ACCESS_KEY_PASS_ENTRY}" | sed -n 1p)
[[ -n "${AWS_SECRET_ACCESS_KEY:-}" ]] || AWS_SECRET_ACCESS_KEY=$(pass show "${MEDIA_SECRET_KEY_PASS_ENTRY:?Set MEDIA_SECRET_KEY_PASS_ENTRY}" | sed -n 1p)

manifest="media/manifest.json"
echo "{" > "$manifest.tmp"
first=true
for path in media/*; do
  [[ -f "$path" && "$path" != "$manifest"* ]] || continue
  name=$(basename "$path")
  hash=$(shasum -a 256 "$path" | cut -c1-10)
  key="$PREFIX/${name%.*}-$hash.${name##*.}"
  case "${name##*.}" in
    mp4) type="video/mp4" ;; jpg|jpeg) type="image/jpeg" ;; png) type="image/png" ;; svg) type="image/svg+xml" ;; webp) type="image/webp" ;; *) type="application/octet-stream" ;;
  esac
  if aws --endpoint-url "$ENDPOINT" s3api head-object --bucket "$BUCKET" --key "$key" >/dev/null 2>&1; then
    echo "есть      $CDN/$key"
  else
    aws --endpoint-url "$ENDPOINT" s3api put-object --bucket "$BUCKET" --key "$key" --body "$path" \
      --content-type "$type" --cache-control "public, max-age=31536000, immutable" >/dev/null
    echo "загружен  $CDN/$key"
  fi
  $first || echo "," >> "$manifest.tmp"
  first=false
  printf '  "%s": "%s"' "$name" "$CDN/$key" >> "$manifest.tmp"
done
printf '\n}\n' >> "$manifest.tmp"
mv "$manifest.tmp" "$manifest"
echo "адреса записаны в $manifest"
