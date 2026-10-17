import { describe, expect, it } from "bun:test";
import {
    checkLevel41Envelope,
    macroblockDimensions,
} from "../../src/ffmpegArgs";

// RED case 5: the compatibility envelope is DATA, not vibes. Numbers below
// come from ITU-T H.264 Annex A, Table A-1 (level 4.1 row), cross-checked
// with the published level table (en.wikipedia.org/wiki/Advanced_Video_Coding
// #Levels): MaxMBPS 245,760 macroblocks/s, MaxFS 8,192 macroblocks/frame,
// with documented examples 1280×720@68.3 and 1920×1080@30.1 for this level.
//
// Reference-frame / DPB limits (MaxDpbMbs 32,768) are approximated away:
// libx264 enforces them itself when -level 4.1 is passed, clamping its
// reference count to fit.

describe("macroblockDimensions", (): void => {
    it("rounds each dimension up to whole 16×16 macroblocks", (): void => {
        // 1920/16 = 120, 1080/16 = 67.5 -> 68 (level 4.1 documents 1080-line
        // pictures as 8160 MBs, i.e. the padded height counts).
        expect(macroblockDimensions(1920, 1080)).toEqual({
            widthMb: 120,
            heightMb: 68,
            frameMb: 8160,
        });
    });
});

describe("checkLevel41Envelope", (): void => {
    it("accepts 1920×1080@30 (the flagship level 4.1 signal)", (): void => {
        const result = checkLevel41Envelope({ width: 1920, height: 1080, fps: 30 });

        expect(result.ok).toBe(true);
    });

    it("accepts 1920×1088@30 and 2048×1024@30 exactly at the limits", (): void => {
        // 120×68 = 8160 MBs, ×30 = 244,800 MB/s. 128×64 = 8192 MBs (== MaxFS),
        // ×30 = 245,760 MB/s (== MaxMBPS). Boundary equality passes.
        expect(checkLevel41Envelope({ width: 1920, height: 1088, fps: 30 }).ok).toBe(true);
        expect(checkLevel41Envelope({ width: 2048, height: 1024, fps: 30 }).ok).toBe(true);
    });

    it("accepts NTSC-fractional 1920×1080@29.97", (): void => {
        expect(checkLevel41Envelope({ width: 1920, height: 1080, fps: 30000 / 1001 }).ok).toBe(
            true,
        );
    });

    it("rejects 1920×1080@60 for exceeding MaxMBPS, listing measured and limit", (): void => {
        const result = checkLevel41Envelope({ width: 1920, height: 1080, fps: 60 });

        expect(result.ok).toBe(false);

        if (!result.ok) {
            expect(result.code).toBe("exceeds-max-macroblocks-per-second");
            expect(result.message).toContain("489,600");
            expect(result.message).toContain("245,760");
            expect(result.message).toContain("level 4.1");
        }
    });

    it("rejects 2560×1440@30 for exceeding MaxFS (the honest MB math)", (): void => {
        // 2560/16 = 160, 1440/16 = 90 -> 14,400 MBs/frame > 8,192: rejected by
        // frame size before frame rate is even considered.
        const result = checkLevel41Envelope({ width: 2560, height: 1440, fps: 30 });

        expect(result.ok).toBe(false);

        if (!result.ok) {
            expect(result.code).toBe("exceeds-max-frame-size");
            expect(result.message).toContain("14,400");
            expect(result.message).toContain("8,192");
        }
    });

    it("rejects 3840×2160 regardless of frame rate", (): void => {
        const result = checkLevel41Envelope({ width: 3840, height: 2160, fps: 24 });

        expect(result.ok).toBe(false);

        if (!result.ok) {
            expect(result.code).toBe("exceeds-max-frame-size");
            // 4K measured in macroblocks: 240 × 135 = 32,400.
            expect(result.message).toContain("32,400");
        }
    });

    it("caps frame rate at the level's MaxFR even for small frames", (): void => {
        const result = checkLevel41Envelope({ width: 640, height: 480, fps: 100 });

        expect(result.ok).toBe(false);

        if (!result.ok) {
            expect(result.code).toBe("exceeds-max-frame-rate");
            expect(result.message).toContain("68.75");
        }
    });

    it("accepts 1280×720@68 (720p rides just under MaxMBPS)", (): void => {
        // 80×45 = 3600 MBs × 68 = 244,800 MB/s ≤ 245,760.
        expect(checkLevel41Envelope({ width: 1280, height: 720, fps: 68 }).ok).toBe(true);
    });

    it("rejects 1280×720@69", (): void => {
        expect(checkLevel41Envelope({ width: 1280, height: 720, fps: 69 }).ok).toBe(false);
    });

    it("rejects unknown fps as unvalidated instead of guessing", (): void => {
        const result = checkLevel41Envelope({ width: 1920, height: 1080, fps: null });

        expect(result.ok).toBe(false);

        if (!result.ok) {
            expect(result.code).toBe("unknown-fps");
            expect(result.message).toContain("unvalidated");
        }
    });

    it("rejects zero, negative, and NaN dimensions", (): void => {
        for (const bad of [
            { width: 0, height: 1080, fps: 30 },
            { width: 1920, height: 0, fps: 30 },
            { width: -1920, height: 1080, fps: 30 },
            { width: Number.NaN, height: 1080, fps: 30 },
            { width: 1920, height: Number.NaN, fps: 30 },
        ]) {
            const result = checkLevel41Envelope(bad);

            expect(result.ok).toBe(false);

            if (!result.ok) {
                expect(result.code).toBe("invalid-dimensions");
            }
        }
    });
});
