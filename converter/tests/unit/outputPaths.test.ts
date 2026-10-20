import { describe, expect, it } from "bun:test";
import {
    deriveOutputPath,
    describeOutputRefusal,
} from "../../src/ffmpegArgs";

// Output naming policy (documented decision):
// - Every conversion targets the MP4 container, so the output name is the
//   input's basename with its final extension replaced by `.mp4`.
// - `example.mp4` → `example.mp4`: re-transcoding an MP4 input is allowed and
//   lands in <outDir>/example.mp4, a different directory from the source, so
//   there is no self-collision. A pre-existing file at the output path is a
//   refusal (see describeOutputRefusal), never an overwrite.
describe("deriveOutputPath", (): void => {
    it("rewrites an .mkv input to .mp4 inside the output directory", (): void => {
        expect(deriveOutputPath("/media/example.mkv", "/media/transcoded")).toBe(
            "/media/transcoded/example.mp4",
        );
    });

    it("keeps the same basename for an .mp4 input (re-transcode into outDir)", (): void => {
        expect(deriveOutputPath("/media/example.mp4", "/media/transcoded")).toBe(
            "/media/transcoded/example.mp4",
        );
    });

    it("only replaces the final extension", (): void => {
        expect(deriveOutputPath("/a/b/clip.tar.mkv", "/out")).toBe("/out/clip.tar.mp4");
    });

    it("appends .mp4 when the input has no extension", (): void => {
        expect(deriveOutputPath("/a/clip", "/out")).toBe("/out/clip.mp4");
    });

    it("pins dotfile behavior: .mkv → .mkv.mp4, .hidden → .hidden.mp4", (): void => {
        // node:path's parse treats a leading dot as part of the name, not an
        // extension, dotfile inputs gain `.mp4` instead of losing their name.
        expect(deriveOutputPath("/m/.mkv", "/out")).toBe("/out/.mkv.mp4");
        expect(deriveOutputPath("/m/.hidden", "/out")).toBe("/out/.hidden.mp4");
    });

    it("drops a trailing dot: clip. → clip.mp4", (): void => {
        expect(deriveOutputPath("/m/clip.", "/out")).toBe("/out/clip.mp4");
    });
});

describe("describeOutputRefusal", (): void => {
    it("allows a fresh output path", (): void => {
        expect(
            describeOutputRefusal("/media/example.mkv", "/media/transcoded/example.mp4", false),
        ).toBeNull();
    });

    it("refuses when the output file already exists, naming both paths", (): void => {
        const refusal = describeOutputRefusal(
            "/media/example.mkv",
            "/media/transcoded/example.mp4",
            true,
        );

        expect(refusal).not.toBeNull();
        expect(refusal!.length).toBeGreaterThan(0);
        expect(refusal!).toContain("/media/example.mkv");
        expect(refusal!).toContain("/media/transcoded/example.mp4");
        expect(refusal!).toContain("delete");
    });

    it("reports a same-file refusal without an existence requirement", (): void => {
        const refusal = describeOutputRefusal(
            "/media/transcoded/example.mp4",
            "/media/transcoded/example.mp4",
            true,
        );

        expect(refusal).not.toBeNull();
        expect(refusal).toContain("same file");
    });
});
