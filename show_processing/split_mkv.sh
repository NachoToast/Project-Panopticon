#!/bin/bash

SUBTITLE_TRACK_INDEX=0 

if [ -z "$1" ]; then
    echo "Usage: $0 <path_to_folder>"
    exit 1
fi

INPUT_DIR="$(realpath "$1")"

OUTPUT_DIR="${INPUT_DIR}/viewing_ready"

echo "Input Directory: ${INPUT_DIR}"

if [ ! -d "$OUTPUT_DIR" ]; then
    mkdir -p "$OUTPUT_DIR"
fi

find "$INPUT_DIR" -maxdepth 1 -type f -name "*.mkv" -print0 | while IFS= read -r -d $'\0' MKV_FULLPATH; do
    
    MKV_FILENAME=$(basename "$MKV_FULLPATH")
    FILENAME_NO_EXT="${MKV_FILENAME%.*}"
    echo -e "\nProcessing file: **${MKV_FILENAME}**"

    MP4_OUTPUT="${OUTPUT_DIR}/${FILENAME_NO_EXT}.mp4"
    VTT_OUTPUT="${OUTPUT_DIR}/${FILENAME_NO_EXT}.vtt"

    if [ -f "$MP4_OUTPUT" ] && [ -f "$VTT_OUTPUT" ]; then
        continue
    fi

    echo "  - Extracting Subtitle Track **#${SUBTITLE_TRACK_INDEX}** to: ${VTT_OUTPUT}"
    
    ffmpeg -i "$MKV_FULLPATH" -map 0:s:$SUBTITLE_TRACK_INDEX -c:s webvtt -y "$VTT_OUTPUT" 2>/dev/null
    
    if [ $? -ne 0 ]; then
        echo "  *** WARNING: Subtitle extraction failed for ${MKV_FILENAME}. Check if track ${SUBTITLE_TRACK_INDEX} exists."
    fi

    ffmpeg -i "$MKV_FULLPATH" -map 0:v:0 -map 0:a:0 -c:v copy -c:a aac -b:a 128k -tag:v hvc1 -y "$MP4_OUTPUT" 2>/dev/null
    
    if [ $? -ne 0 ]; then
        echo "  *** ERROR: Video conversion failed for ${MKV_FILENAME}. ***"
    else
        echo "  - Conversion completed successfully."
    fi

done

echo -e "\n--- All Conversions Complete ---"