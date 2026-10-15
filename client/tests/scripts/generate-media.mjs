#!/usr/bin/env node

// Generates the three tiny, distinguishable H.264/AAC MP4 fixtures used by the
// browser tests into client/tests/fixtures/public/data/, which is served by
// vite.test.config.ts's publicDir. The clips are produced entirely from
// FFmpeg's own lavfi synthesizers (solid color video + sine tone audio), so
// they are licensed by construction — no third-party content is bundled.
//
// Usage:
//   node client/tests/scripts/generate-media.mjs           # skip existing
//   node client/tests/scripts/generate-media.mjs --force   # regenerate all
//
// The output directory is gitignored; run this script after cloning.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));

const outputDir = resolve(scriptDir, '../fixtures/public/data');

// One clip per color; each also carries a distinct sine tone so they are
// distinguishable by ear as well as by sight.
const clips = [
    { name: 'red.mp4', color: 'red', tone: 440 },
    { name: 'green.mp4', color: 'green', tone: 554 },
    { name: 'blue.mp4', color: 'blue', tone: 659 },
];

const DURATION_SECONDS = 3;

const force = process.argv.includes('--force');

function run(command, args) {
    const result = spawnSync(command, args, { encoding: 'utf-8' });

    if (result.error !== undefined) {
        throw new Error(
            `Failed to run ${command} (${result.error.message}). Is it installed and on PATH?`,
        );
    }

    if (result.status !== 0) {
        throw new Error(
            `${command} ${args.join(' ')}\nfailed with status ${result.status}:\n${result.stderr}`,
        );
    }

    return result.stdout;
}

function generate(clip) {
    // Mirrors the playback-relevant parts of the real converter: H.264
    // (yuv420p, level 4.1) + AAC stereo + +faststart.
    run('ffmpeg', [
        '-y',
        '-f', 'lavfi',
        '-i', `color=c=${clip.color}:s=320x240:r=24:d=${DURATION_SECONDS}`,
        '-f', 'lavfi',
        '-i', `sine=frequency=${clip.tone}:b=0.5:d=${DURATION_SECONDS}`,
        '-shortest',
        '-c:v', 'libx264',
        '-level', '4.1',
        '-pix_fmt', 'yuv420p',
        '-preset', 'veryfast',
        '-crf', '30',
        '-c:a', 'aac',
        '-b:a', '64k',
        '-ac', '2',
        '-movflags', '+faststart',
        resolve(outputDir, clip.name),
    ]);
}

function verify(clip) {
    const videoCodec = run('ffprobe', [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=codec_name',
        '-of', 'csv=p=0',
        resolve(outputDir, clip.name),
    ]).trim();

    const audioCodec = run('ffprobe', [
        '-v', 'error',
        '-select_streams', 'a:0',
        '-show_entries', 'stream=codec_name',
        '-of', 'csv=p=0',
        resolve(outputDir, clip.name),
    ]).trim();

    if (videoCodec !== 'h264' || audioCodec !== 'aac') {
        throw new Error(
            `${clip.name}: expected h264/aac streams, got ${videoCodec}/${audioCodec}`,
        );
    }
}

mkdirSync(outputDir, { recursive: true });

for (const clip of clips) {
    const output = resolve(outputDir, clip.name);

    if (existsSync(output)) {
        if (!force) {
            console.log(`${clip.name}: already exists, skipping (--force to regenerate)`);
            continue;
        }

        unlinkSync(output);
    }

    console.log(`${clip.name}: generating ${DURATION_SECONDS}s ${clip.color} clip...`);

    generate(clip);
    verify(clip);

    console.log(`${clip.name}: ok (h264/aac)`);
}
