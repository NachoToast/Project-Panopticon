import { describe, expect, it } from "bun:test";
import { buildFfmpegArgs } from "../../src/ffmpegArgs";

// The encode target under test (verified against local ffmpeg 9.0.2 via
// `ffmpeg -h muxer=mp4` / `-h encoder=libx264`):
// MP4 container (explicit `-f mp4`), H.264 level 4.1 8-bit 4:2:0 via libx264,
// AAC-LC stereo 128k, faststart, CRF 22 slow preset.
describe("buildFfmpegArgs", (): void => {
    const input = "/media/example.mkv";
    const output = "/media/transcoded/.tmp-example.mp4";
    const args = buildFfmpegArgs(input, output);

    it("returns a string array (spawn-safe, never a shell string)", (): void => {
        expect(Array.isArray(args)).toBe(true);
        expect(args.every((arg: string): boolean => typeof arg === "string")).toBe(true);
    });

    it("reads the input and writes the exact output paths", (): void => {
        expect(args).toContain("-i");
        const inputIndex = args.indexOf("-i");
        expect(args[inputIndex + 1]).toBe(input);
        // Output is the final argument so every preceding flag applies to it.
        expect(args[args.length - 1]).toBe(output);
    });

    it("forces the MP4 muxer explicitly", (): void => {
        const formatIndex = args.indexOf("-f");
        expect(formatIndex).toBeGreaterThan(-1);
        expect(args[formatIndex + 1]).toBe("mp4");
        // The muxer flag must bind to the output, not the input.
        expect(formatIndex).toBeGreaterThan(args.indexOf("-i"));
    });

    it("encodes H.264 level 4.1 8-bit 4:2:0 at CRF 22 with the slow preset", (): void => {
        expect(args).toEqual(
            expect.arrayContaining([
                "-c:v", "libx264",
                "-level", "4.1",
                "-pix_fmt", "yuv420p",
                "-preset", "slow",
                "-crf", "22",
            ]),
        );
    });

    it("encodes AAC-LC stereo at 128k", (): void => {
        expect(args).toEqual(
            expect.arrayContaining(["-c:a", "aac", "-b:a", "128k", "-ac", "2"]),
        );
    });

    it("enables faststart for streaming playback", (): void => {
        expect(args).toEqual(
            expect.arrayContaining(["-movflags", "+faststart"]),
        );
    });

    it("stays scriptable: no stats on stderr, machine progress on stdout, overwrite allowed", (): void => {
        // `-y` only ever applies to the converter-owned temp file; promotion
        // to the final name is an explicit rename (see doTranscode).
        expect(args).toContain("-nostats");
        expect(args).toContain("-y");
        expect(args).toEqual(expect.arrayContaining(["-progress", "pipe:1"]));
    });
});
