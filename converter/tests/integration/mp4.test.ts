import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doTranscode } from "../../src/doTranscode";
import { runProbe } from "../../src/probeMedia";

// Real-ffmpeg pipeline tests. These FAIL loudly when the binaries are
// missing (no test.skipIf): the converter is useless without them, and a
// silent skip would hide a broken environment in CI.

function requireBin(path: string | null, name: string): string {
    if (path === null) {
        throw new Error(
            `${name} is not on PATH — the converter integration tests need a real ${name}. ` +
                `Install the ffmpeg bundle (e.g. \`brew install ffmpeg\`; it includes ffprobe) and re-run.`,
        );
    }

    return path;
}

const ffmpeg = requireBin(Bun.which("ffmpeg"), "ffmpeg");
const ffprobe = requireBin(Bun.which("ffprobe"), "ffprobe");

let workDir: string;

function makeFixture(name: string, extraArgs: string[]): string {
    const path = join(workDir, name);
    const result = spawnSync(
        ffmpeg,
        ["-hide_banner", "-loglevel", "error", "-y", ...extraArgs, path],
        { encoding: "utf8" },
    );

    if (result.status !== 0) {
        throw new Error(`fixture ${name} could not be generated: ${result.stderr}`);
    }

    return path;
}

/** Raw ffprobe JSON for asserting what a fixture actually contains (the
 *  parseProbeOutput layer under test hides everything but the selected
 *  stream, so fixtures are verified at the raw stream level). */
function probeStreamsJson(path: string): { streams: { codec_name: string; width: number; height: number; disposition?: { attached_pic?: number } }[] } {
    const result = spawnSync(
        ffprobe,
        ["-v", "error", "-print_format", "json", "-show_streams", path],
        { encoding: "utf8" },
    );

    if (result.status !== 0) {
        throw new Error(`ffprobe failed on fixture ${path}: ${result.stderr}`);
    }

    return JSON.parse(result.stdout);
}

/** Mux a single-frame still-image cover (first video stream) in front of a
 *  feature clip, the way cover-art-first MKVs arrive in the wild. The
 *  `-disposition attached_pic` flag is passed for muxers that persist it;
 *  ffmpeg 9's matroska muxer drops it, which is exactly why the probe's
 *  still-image codec heuristic exists alongside the disposition check. */
function makeCoverFirstMkv(
    name: string,
    cover: { size: string; rate: number },
    feature: { size: string; rate: number },
): string {
    const coverClip = makeFixture(`${name}-cover.mkv`, [
        "-f", "lavfi", "-i", `testsrc2=duration=0.001:size=${cover.size}:rate=${cover.rate}`,
        "-frames:v", "1",
        "-c:v", "mjpeg",
    ]);
    const featureClip = makeFixture(`${name}-feature.mkv`, [
        "-f", "lavfi", "-i", `testsrc2=duration=1:size=${feature.size}:rate=${feature.rate}`,
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
        "-an",
    ]);
    const path = join(workDir, name);
    const result = spawnSync(
        ffmpeg,
        [
            "-hide_banner", "-loglevel", "error", "-y",
            "-i", coverClip,
            "-i", featureClip,
            "-map", "0:v:0",
            "-map", "1:v:0",
            "-c", "copy",
            "-disposition:v:0", "attached_pic",
            path,
        ],
        { encoding: "utf8" },
    );

    if (result.status !== 0) {
        throw new Error(`fixture ${name} could not be generated: ${result.stderr}`);
    }

    return path;
}

beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), "panopticon-converter-"));
});

afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
});

describe("doTranscode against real ffmpeg", () => {
    it(
        "converts an mkv into a verified mp4 and leaves no temp files",
        async () => {
            const input = makeFixture("clip-ok.mkv", [
                "-f", "lavfi", "-i", "testsrc2=duration=2:size=320x240:rate=30",
                "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
                "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
                "-c:a", "aac", "-ac", "2", "-shortest",
            ]);
            const outDir = join(workDir, "out-ok");

            const result = await doTranscode(input, outDir);

            // MKV input → MP4 output name in outDir; no temp leftovers.
            expect(result.output).toBe(join(outDir, "clip-ok.mp4"));
            expect(readdirSync(outDir)).toEqual(["clip-ok.mp4"]);

            // Postflight contract, verified independently of doTranscode.
            const probe = await runProbe(result.output);

            expect(probe.container).toContain("mp4");
            expect(probe.video?.codec).toBe("h264");
            expect(probe.video?.pixFmt).toBe("yuv420p");
            expect(probe.audio?.codec).toBe("aac");
            expect(probe.audio?.channels).toBe(2);
        },
        120_000,
    );

    it(
        "rejects a 4K input against the level 4.1 envelope without producing output",
        async () => {
            const input = makeFixture("clip-4k.mkv", [
                "-f", "lavfi", "-i", "testsrc2=duration=1:size=3840x2160:rate=30",
                "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
                "-an",
            ]);
            const outDir = join(workDir, "out-4k");

            const failure = doTranscode(input, outDir);

            // 3840×2160 = 240×135 macroblocks = 32,400 MBs > MaxFS 8,192.
            await expect(failure).rejects.toThrow(/level 4\.1/);
            await expect(failure).rejects.toThrow(/32,400/);
            expect(readdirSync(outDir)).toEqual([]);
        },
        120_000,
    );

    // C1 regression, false-PROMOTION direction: a small cover in front of a
    // 4K feature must be rejected. The envelope has to measure the 4K
    // feature (32,400 MBs > MaxFS 8,192), not the 300×300 cover that old
    // first-video-stream probing measured — ffmpeg's own default selection
    // skips the cover, encodes the 4K feature, and x264 only warns
    // (`> level limit`, exit 0), so without this fix the file was promoted
    // with a lying level flag.
    it(
        "rejects a cover-art-first MKV whose feature is 4K (envelope measures the feature)",
        async () => {
            const input = makeCoverFirstMkv(
                "clip-cover-4k.mkv",
                { size: "300x300", rate: 25 },
                { size: "3840x2160", rate: 30 },
            );

            // Fixture sanity: the tiny cover really is stream 0, in front of
            // the 4K feature (attached_pic disposition may or may not be
            // persisted by the muxer — see makeCoverFirstMkv).
            const raw = probeStreamsJson(input);

            expect(raw.streams[0]!.codec_name).toBe("mjpeg");
            expect(raw.streams[0]!.width).toBe(300);
            expect(raw.streams[1]!.width).toBe(3840);
            expect(raw.streams[1]!.height).toBe(2160);

            const outDir = join(workDir, "out-cover-4k");

            const failure = doTranscode(input, outDir);

            await expect(failure).rejects.toThrow(/level 4\.1/);
            await expect(failure).rejects.toThrow(/32,400/);
            expect(readdirSync(outDir)).toEqual([]);
        },
        120_000,
    );

    // C1 regression, false-REJECTION direction: a 400×400@1000fps cover in
    // front of a perfectly fine 1080p feature must be ACCEPTED. Old
    // first-video-stream probing measured the cover (1000 fps > MaxFR
    // 68.75) and refused a file that converts cleanly.
    it(
        "accepts a cover-art-first MKV with a 1080p feature (no false rejection on the cover)",
        async () => {
            const input = makeCoverFirstMkv(
                "clip-cover-1080.mkv",
                { size: "400x400", rate: 1000 },
                { size: "1920x1080", rate: 30 },
            );

            const raw = probeStreamsJson(input);

            expect(raw.streams[0]!.codec_name).toBe("mjpeg");
            expect(raw.streams[0]!.width).toBe(400);
            expect(raw.streams[1]!.width).toBe(1920);
            expect(raw.streams[1]!.height).toBe(1080);

            const outDir = join(workDir, "out-cover-1080");

            const result = await doTranscode(input, outDir);

            expect(result.output).toBe(join(outDir, "clip-cover-1080.mp4"));
            expect(readdirSync(outDir)).toEqual(["clip-cover-1080.mp4"]);

            // The FEATURE was converted, not the cover: output dimensions
            // match the selected (largest real) input stream.
            const probe = await runProbe(result.output);

            expect(probe.video?.codec).toBe("h264");
            expect(probe.video?.width).toBe(1920);
            expect(probe.video?.height).toBe(1080);
        },
        120_000,
    );

    it(
        "reports a nonzero ffmpeg exit with a stderr tail and removes the temp file",
        async () => {
            const input = makeFixture("clip-fail.mkv", [
                "-f", "lavfi", "-i", "testsrc2=duration=1:size=320x240:rate=30",
                "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
                "-an",
            ]);
            const outDir = join(workDir, "out-fail");

            // Sabotage: occupy the converter-owned temp path with a directory
            // so ffmpeg cannot open its output file and exits nonzero.
            mkdirSync(join(outDir, ".tmp-clip-fail.mp4"), { recursive: true });

            const failure = doTranscode(input, outDir);

            await expect(failure).rejects.toThrow(/exited with code/);
            expect(readdirSync(outDir)).toEqual([]);
        },
        120_000,
    );

    it(
        "refuses a pre-existing output file instead of overwriting it",
        async () => {
            const input = makeFixture("clip-ok2.mkv", [
                "-f", "lavfi", "-i", "testsrc2=duration=1:size=320x240:rate=30",
                "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
                "-an",
            ]);
            const outDir = join(workDir, "out-exists");

            mkdirSync(outDir, { recursive: true });
            writeFileSync(join(outDir, "clip-ok2.mp4"), "precious previous run");

            const failure = doTranscode(input, outDir);

            await expect(failure).rejects.toThrow(/already exists/);
            expect(readdirSync(outDir)).toEqual(["clip-ok2.mp4"]);
        },
        120_000,
    );

    it(
        "rejects a non-media input with a clear probe error and no temp file",
        async () => {
            const input = join(workDir, "garbage.mkv");

            writeFileSync(input, "this is not video data");

            const outDir = join(workDir, "out-garbage");

            await expect(doTranscode(input, outDir)).rejects.toThrow(/garbage\.mkv/);
            expect(readdirSync(outDir)).toEqual([]);
        },
        120_000,
    );
});
