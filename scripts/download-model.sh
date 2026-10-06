#!/usr/bin/env bash
# Downloads the Whisper model for the local recognizer (1.6 GB) and verifies its checksum.
set -euo pipefail

model_path="${WHISPER_MODEL:-$HOME/.cache/live-slides/models/ggml-large-v3-turbo.bin}"
model_url="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin"
expected_sha1="4af2b29d7ec73d781377bfd1758ca957a807e941"

mkdir -p "$(dirname "$model_path")"
if [[ ! -s "$model_path" ]] || [[ "$(shasum "$model_path" | awk '{print $1}')" != "$expected_sha1" ]]; then
  curl --fail --location --continue-at - --output "$model_path" "$model_url"
fi
if [[ "$(shasum "$model_path" | awk '{print $1}')" != "$expected_sha1" ]]; then
  echo "Контрольная сумма модели не совпала: $model_path" >&2
  exit 65
fi
echo "Модель на месте: $model_path"
