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
