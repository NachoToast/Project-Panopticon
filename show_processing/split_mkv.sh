#!/usr/bin/env bash

set -euo pipefail

FF=ffmpeg
INPUT_DIR="${1:-}"

if [[ -z "$INPUT_DIR" || ! -d "$INPUT_DIR" ]]; then
  echo "Usage: $0 /path/to/folder"
  exit 1
fi

# Normalize path
INPUT_DIR="$(realpath "$INPUT_DIR")"
OUTDIR="$INPUT_DIR/viewing_ready"

mkdir -p "$OUTDIR"

shopt -s nullglob

for INPUT in "$INPUT_DIR"/*.mkv; do
  NAME="$(basename "$INPUT" .mkv)"

  OUTPUT_MP4="$OUTDIR/$NAME.mp4"
  OUTPUT_VTT="$OUTDIR/$NAME.vtt"

  echo "=========================================="
  echo "Processing: $INPUT"
  echo "Output video: $OUTPUT_MP4"
  echo "Output subs:  $OUTPUT_VTT"
  echo "=========================================="

  "$FF" -y -i "$INPUT" \
    -map 0:v:0 \
    -map 0:a:0 \
    -c:v libx264 \
    -preset slow \
    -crf 18 \
    -pix_fmt yuv420p \
    -movflags +faststart \
    -c:a aac \
    -b:a 192k \
    "$OUTPUT_MP4"

  "$FF" -y -i "$INPUT" \
    -map 0:s:0 \
    -c:s webvtt \
    "$OUTPUT_VTT" 2>/dev/null || true

  echo
done

echo "Done! Output in: $OUTDIR"
