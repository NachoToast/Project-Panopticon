import { basename, join, parse, resolve } from 'node:path';

/**
 * Pure ffmpeg argument and output-path construction.
 *
 * Everything here is data in / data out: no spawning, no filesystem access.
 * Arguments are always built as arrays (`spawn` semantics, never a shell
 * string), so file names can never be interpreted as shell syntax.
 */

/**
 * H.264 level 4.1 constraint set from ITU-T Rec. H.264 Table A-1 (level 4.1
 * row): MaxMBPS 245,760; MaxFS 8,192; MaxFR 68.75 (= 68.75 fps). MaxBR/MaxVBV
 * are not checked (CRF encoding has no fixed bitrate to compare), and the
 * DPB/reference-frame budget is the encoder's business.
 */
// TODO(levels): level 4.1 is hardcoded in checkLevel41Envelope's messages
// and name; extract a LEVELS table if another level ever becomes selectable.
export const H264_LEVEL_41 = {
    maxMacroblocksPerSecond: 245_760,
    maxFrameSizeInMacroblocks: 8_192,
    maxFrameRate: 68.75,
    /** Informational only — never read by the envelope check. Kept because
     *  it completes the Table A-1 level row for future multi-level work. */
    maxDpbMacroblocks: 32_768,
} as const;

/** A frame's size in 16×16 macroblocks; each pixel dimension rounds UP. */
export function macroblockDimensions(
    width: number,
    height: number,
): {
    widthMb: number;
    heightMb: number;
    frameMb: number;
} {
    const widthMb = Math.ceil(width / 16);
    const heightMb = Math.ceil(height / 16);

    return { widthMb, heightMb, frameMb: widthMb * heightMb };
}

export type EnvelopeMeasurements = {
    width: number;
    height: number;
    /** null when the source's frame rate could not be determined. */
    fps: number | null;
};

export type EnvelopeCheck =
    | {
          ok: true;
          measured: {
              width: number;
              height: number;
              fps: number;
              frameMb: number;
              macroblocksPerSecond: number;
          };
      }
    | {
          ok: false;
          code:
              | 'invalid-dimensions'
              | 'unknown-fps'
              | 'exceeds-max-frame-size'
              | 'exceeds-max-frame-rate'
              | 'exceeds-max-macroblocks-per-second';
          message: string;
          measured: { width: number; height: number; fps: number | null };
      };

const count = (value: number): string =>
    Math.round(value).toLocaleString('en-US');

/**
 * Can this width×height@fps be encoded as H.264 level 4.1? Rejections name
 * the measured value and the limit; unknown frame rates are rejected as
 * unvalidated rather than assumed safe.
 */
export function checkLevel41Envelope(
    measurements: EnvelopeMeasurements,
): EnvelopeCheck {
    const { width, height, fps } = measurements;

    const dimensionsValid =
        Number.isFinite(width) &&
        Number.isFinite(height) &&
        width > 0 &&
        height > 0;

    if (!dimensionsValid) {
        return {
            ok: false,
            code: 'invalid-dimensions',
            message:
                `Cannot validate ${width}×${height} against H.264 level 4.1: ` +
                `width and height must be positive numbers ` +
                `(probe reported width=${width}, height=${height}).`,
            measured: { width, height, fps },
        };
    }

    if (fps === null || !Number.isFinite(fps) || fps <= 0) {
        return {
            ok: false,
            code: 'unknown-fps',
            message:
                `Frame rate of the ${width}×${height} input could not be ` +
                `determined, so its level 4.1 compliance is unvalidated. ` +
                `Refusing rather than silently producing an unverified file; ` +
                `fix the source's timing metadata or convert with different settings.`,
            measured: { width, height, fps },
        };
    }

    const { widthMb, heightMb, frameMb } = macroblockDimensions(width, height);

    if (frameMb > H264_LEVEL_41.maxFrameSizeInMacroblocks) {
        return {
            ok: false,
            code: 'exceeds-max-frame-size',
            message:
                `${width}×${height} needs ${count(frameMb)} macroblocks per frame ` +
                `(${widthMb}×${heightMb} 16×16 blocks), exceeding H.264 level 4.1 ` +
                `MaxFS (${count(H264_LEVEL_41.maxFrameSizeInMacroblocks)} macroblocks ` +
                `per frame). Convert with a smaller resolution or pick a different level.`,
            measured: { width, height, fps },
        };
    }

    if (fps > H264_LEVEL_41.maxFrameRate) {
        return {
            ok: false,
            code: 'exceeds-max-frame-rate',
            message:
                `${width}×${height} @ ${fps.toFixed(2)} fps exceeds H.264 level 4.1 ` +
                `MaxFR (${H264_LEVEL_41.maxFrameRate} fps). Convert with a lower frame ` +
                `rate or pick a different level.`,
            measured: { width, height, fps },
        };
    }

    const macroblocksPerSecond = frameMb * fps;

    if (macroblocksPerSecond > H264_LEVEL_41.maxMacroblocksPerSecond) {
        return {
            ok: false,
            code: 'exceeds-max-macroblocks-per-second',
            message:
                `${width}×${height} @ ${fps.toFixed(2)} fps produces ` +
                `${count(macroblocksPerSecond)} macroblocks per second, exceeding ` +
                `H.264 level 4.1 MaxMBPS (${count(H264_LEVEL_41.maxMacroblocksPerSecond)} ` +
                `macroblocks per second). Convert with different settings (lower ` +
                `resolution or frame rate) or pick a different level.`,
            measured: { width, height, fps },
        };
    }

    return {
        ok: true,
        measured: { width, height, fps, frameMb, macroblocksPerSecond },
    };
}

/**
 * Derive the final output path: every conversion targets MP4, so the input's
 * extension is replaced with `.mp4` (example.mkv → example.mp4; an .mp4
 * input's output lives in outDir and never collides with the source).
 * node:path treats a LEADING dot as part of the name, so dotfiles gain
 * `.mp4` instead of losing their name.
 */
export function deriveOutputPath(input: string, outDir: string): string {
    const { name } = parse(basename(input));
    return join(outDir, `${name}.mp4`);
}

/**
 * Explain why a conversion must be refused, or null when it may run. The
 * converter never overwrites or deletes user files; `outputExists` comes
 * from the caller so this stays pure.
 */
export function describeOutputRefusal(
    input: string,
    output: string,
    outputExists: boolean,
): string | null {
    if (resolve(input) === resolve(output)) {
        return (
            `Refusing to convert: input and output are the same file ` +
            `(${input}). Choose a different input folder or output directory.`
        );
    }

    if (outputExists) {
        return (
            `Refusing to write ${output} because it already exists ` +
            `(would clobber the output for input ${input}). ` +
            `Delete or move ${output} manually, then re-run; ` +
            `the converter never deletes existing files.`
        );
    }

    return null;
}

/**
 * ffmpeg invocation for the compatibility target (verified against ffmpeg
 * 9.0.2). Key points: `-f mp4` forces the MP4 muxer regardless of the output
 * name; `-level 4.1` only sets the flag — it does NOT make libx264 enforce
 * MaxFS/MaxMBPS (impossible combinations merely warn on stderr and exit 0),
 * so the preflight envelope in doTranscode is the ONLY enforcement and
 * doTranscode additionally surfaces those warnings. `-y` is safe because
 * `output` is a converter-owned temp file; `-nostats`/`-progress pipe:1`/
 * `-hide_banner` keep stderr clean for diagnostics.
 */
export function buildFfmpegArgs(input: string, output: string): string[] {
    return [
        '-hide_banner',
        '-nostats',
        '-y',
        '-progress',
        'pipe:1',
        '-i',
        input,
        '-c:v',
        'libx264',
        '-level',
        '4.1',
        '-pix_fmt',
        'yuv420p',
        '-preset',
        'slow',
        '-crf',
        '22',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-ac',
        '2',
        '-movflags',
        '+faststart',
        '-f',
        'mp4',
        output,
    ];
}
