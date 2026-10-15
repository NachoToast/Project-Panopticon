import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { TranscodeProgress } from "../../src/doTranscode";
import {
    collectInputFiles,
    createFileProgress,
    formatProgressLine,
    summarizeRun,
} from "../../src/main";
import {
    parseFpsRate,
    parseProbeOutput,
    ProbeError,
    verifyOutputProbe,
    type MediaProbe,
} from "../../src/probeMedia";
import { describeSpawnFailure, StderrTail } from "../../src/stderrTail";

// RED case 3: process-level failures must produce useful errors. The pure
// pieces (bounded stderr tail, spawn-failure wording, ffprobe JSON parsing,
// postflight verification) are tested here; the spawning paths are exercised
// by tests/integration/mp4.test.ts.

describe("StderrTail", (): void => {
    it("keeps the most recent bytes within the 64KiB bound", (): void => {
        const tail = new StderrTail();

        for (let i = 0; i < 300; i += 1) {
            tail.push("a".repeat(512));
        }

        // 300 * 512 = 153600 bytes pushed, bound is 65536.
        expect(tail.byteLength).toBeLessThanOrEqual(64 * 1024 + 3);
        expect(tail.byteLength).toBeGreaterThan(63 * 1024);
    });

    it("preserves a message that is split across many chunk boundaries", (): void => {
        const tail = new StderrTail();

        for (let i = 0; i < 130; i += 1) {
            tail.push("0123456789abcdef".repeat(64)); // 130 KiB of padding
        }

        for (const piece of ["Conv", "ersion f", "ailed: ma", "rker-9f3", "!"]) {
            tail.push(piece);
        }

        expect(tail.tail()).toContain("Conversion failed: marker-9f3!");
    });

    it("does not begin with a broken UTF-8 sequence at the trim boundary", (): void => {
        const tail = new StderrTail();

        tail.push("x".repeat(64 * 1024 - 1));
        tail.push(Buffer.concat([Buffer.from([0xc3]), Buffer.from([0xa9])]));
        tail.push("!!!"); // 'é' + '!!!' straddles the boundary

        const text = tail.tail();

        expect(text.endsWith("!!!")).toBe(true);
        expect(text.startsWith("\uFFFD")).toBe(false);
    });
});

describe("describeSpawnFailure", (): void => {
    it("names the binary and PATH when spawning fails with ENOENT", (): void => {
        const message = describeSpawnFailure("ffprobe", Object.assign(new Error("spawn ffprobe ENOENT"), { code: "ENOENT" }));

        expect(message).toContain("ffprobe");
        expect(message).toContain("PATH");
    });

    it("falls back to the underlying message for other spawn errors", (): void => {
        expect(describeSpawnFailure("ffmpeg", new Error("EACCES: permission denied"))).toContain(
            "EACCES: permission denied",
        );
    });
});

describe("parseFpsRate", (): void => {
    it("parses integer and rational rates", (): void => {
        expect(parseFpsRate("25")).toBe(25);
        expect(parseFpsRate("30000/1001")).toBeCloseTo(29.9700299, 4);
    });

    it("rejects zero, garbage, and missing rates", (): void => {
        expect(parseFpsRate("0/0")).toBeNull();
        expect(parseFpsRate("0/1")).toBeNull();
        expect(parseFpsRate("N/A")).toBeNull();
        expect(parseFpsRate(null)).toBeNull();
    });
});

const MP4_FIXTURE = JSON.stringify({
    streams: [
        {
            index: 0,
            codec_name: "h264",
            codec_type: "video",
            width: 1920,
            height: 1080,
            r_frame_rate: "30000/1001",
            avg_frame_rate: "30000/1001",
            pix_fmt: "yuv420p",
        },
        {
            index: 1,
            codec_name: "aac",
            codec_type: "audio",
            channels: 2,
            sample_rate: "48000",
        },
    ],
    format: {
        format_name: "mov,mp4,m4a,3gp,3g2,mj2",
        duration: "12.345000",
    },
});

describe("parseProbeOutput", (): void => {
    it("reads container, duration, video, and audio fields", (): void => {
        const probe = parseProbeOutput(MP4_FIXTURE);

        expect(probe.container).toBe("mov,mp4,m4a,3gp,3g2,mj2");
        expect(probe.durationSeconds).toBeCloseTo(12.345, 3);
        expect(probe.video?.codec).toBe("h264");
        expect(probe.video?.width).toBe(1920);
        expect(probe.video?.height).toBe(1080);
        expect(probe.video?.pixFmt).toBe("yuv420p");
        expect(probe.video?.fps).toBeCloseTo(29.9700299, 4);
        expect(probe.audio?.codec).toBe("aac");
        expect(probe.audio?.channels).toBe(2);
    });

    it("falls back to avg_frame_rate when r_frame_rate is unusable", (): void => {
        const probe = parseProbeOutput(
            JSON.stringify({
                streams: [
                    {
                        codec_name: "h264",
                        codec_type: "video",
                        width: 1280,
                        height: 720,
                        r_frame_rate: "0/0",
                        avg_frame_rate: "25/1",
                        pix_fmt: "yuv420p",
                    },
                ],
                format: { format_name: "matroska,webm" },
            }),
        );

        expect(probe.video?.fps).toBe(25);
    });

    it("reports fps as null when no rate is usable", (): void => {
        const probe = parseProbeOutput(
            JSON.stringify({
                streams: [
                    {
                        codec_name: "h264",
                        codec_type: "video",
                        width: 1280,
                        height: 720,
                        r_frame_rate: "0/0",
                        avg_frame_rate: "0/0",
                    },
                ],
                format: { format_name: "matroska,webm" },
            }),
        );

        expect(probe.video?.fps).toBeNull();
    });

    it("throws a ProbeError on malformed JSON", (): void => {
        expect(() => parseProbeOutput("not json {")).toThrow(ProbeError);
        expect(() => parseProbeOutput("not json {")).toThrow(/malformed ffprobe JSON/);
    });

    it("throws a ProbeError when there is no video stream", (): void => {
        const audioOnly = JSON.stringify({
            streams: [{ codec_name: "aac", codec_type: "audio", channels: 2 }],
            format: { format_name: "mp3" },
        });

        expect(() => parseProbeOutput(audioOnly)).toThrow(/no video stream/i);
    });
});

describe("verifyOutputProbe", (): void => {
    const good = parseProbeOutput(MP4_FIXTURE);

    it("accepts an mp4/h264/yuv420p/aac-stereo probe", (): void => {
        expect(verifyOutputProbe(good, { expectAudio: true })).toBeNull();
        expect(verifyOutputProbe(good, { expectAudio: false })).toBeNull();
    });

    it("rejects a non-MP4 container", (): void => {
        const mkv: MediaProbe = {
            ...good,
            container: "matroska,webm",
        };

        expect(verifyOutputProbe(mkv, { expectAudio: true })).toMatch(/container/i);
    });

    it("rejects the wrong video codec or pixel format", (): void => {
        const hevc: MediaProbe = {
            ...good,
            video: { ...good.video!, codec: "hevc", pixFmt: "yuv420p10le" },
        };

        const message = verifyOutputProbe(hevc, { expectAudio: true });

        expect(message).toMatch(/h264/);
        expect(message).toMatch(/yuv420p10le/);
    });

    it("rejects missing audio when audio was expected", (): void => {
        const silent: MediaProbe = { ...good, audio: null };

        expect(verifyOutputProbe(silent, { expectAudio: true })).toMatch(/audio/i);
    });

    it("rejects non-stereo audio", (): void => {
        const surround: MediaProbe = {
            ...good,
            audio: { ...good.audio!, channels: 6 },
        };

        expect(verifyOutputProbe(surround, { expectAudio: true })).toMatch(/stereo|channels/i);
    });
});

describe("formatProgressLine", (): void => {
    const halfway: TranscodeProgress = {
        frame: 150,
        outTimeSeconds: 5,
        fps: 30,
        speed: "1.5x",
        done: false,
    };

    it("renders time, percent, and speed when duration is known", (): void => {
        const line = formatProgressLine("clip.mkv", halfway, 10);

        expect(line).toContain("clip.mkv");
        expect(line).toContain("50%");
        expect(line).toContain("1.5x");
    });

    it("omits the percent when duration is unknown", (): void => {
        const line = formatProgressLine("clip.mkv", halfway, null);

        expect(line).not.toContain("%");
    });
});

// RED case 4: non-TTY progress must never throw (no moveCursor/clearLine —
// those throw on pipes) and must stay quiet: one line per file completion is
// all a piped run gets.
describe("createFileProgress", (): void => {
    const sample: TranscodeProgress = {
        frame: 1,
        outTimeSeconds: 1,
        fps: 30,
        speed: "2x",
        done: false,
    };

    it("writes nothing when the output is not a TTY", (): void => {
        const writes: string[] = [];
        const display = createFileProgress("clip.mkv", {
            isTty: false,
            write: (text: string) => writes.push(text),
        });

        expect(() => {
            display.update(sample);
            display.end();
        }).not.toThrow();

        expect(writes).toEqual([]);
    });

    it("overwrites in place with \\r when on a TTY", (): void => {
        const writes: string[] = [];
        const display = createFileProgress("clip.mkv", {
            isTty: true,
            write: (text: string) => writes.push(text),
        });

        display.update({ ...sample, outTimeSeconds: 1 });
        display.update({ ...sample, outTimeSeconds: 100 });
        display.update({ ...sample, outTimeSeconds: 50 }); // shorter line pads over leftovers
        display.end();

        expect(writes.slice(0, 3).every((text: string) => text.startsWith("\r"))).toBe(true);
        expect(writes[2]!.length).toBeGreaterThanOrEqual(writes[1]!.length);
        expect(writes[3]).toBe("\n");
    });
});

describe("summarizeRun", (): void => {
    it("reports full success with exit code 0", (): void => {
        const summary = summarizeRun(["/a/x.mkv", "/a/y.mkv"], []);

        expect(summary.line).toContain("2 converted");
        expect(summary.line).toContain("0 failed");
        expect(summary.exitCode).toBe(0);
    });

    it("names the failures and exits nonzero", (): void => {
        const summary = summarizeRun(["/a/x.mkv"], [
            { file: "/a/broken.mkv", error: new Error("boom") },
        ]);

        expect(summary.line).toContain("1 failed");
        expect(summary.line).toContain("broken.mkv");
        expect(summary.exitCode).toBe(1);
    });
});

describe("collectInputFiles", (): void => {
    it("collects matching files and ignores directories and other extensions", (): void => {
        const dir = mkdtempSync(join(tmpdir(), "panopticon-collect-"));

        try {
            writeFileSync(join(dir, "a.mkv"), "x");
            writeFileSync(join(dir, "b.mkv"), "x");
            writeFileSync(join(dir, "c.mp4"), "x");
            mkdirSync(join(dir, "d.mkv"));

            expect(collectInputFiles(dir, "mkv").map((file: string) => basename(file)).sort()).toEqual([
                "a.mkv",
                "b.mkv",
            ]);
            expect(() => collectInputFiles(dir, "avi")).toThrow(/No avi files/);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
