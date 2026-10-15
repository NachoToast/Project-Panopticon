import { basename, join, parse, resolve } from "node:path";

/**
 * Pure ffmpeg argument and output-path construction.
 *
 * Everything here is data in / data out: no spawning, no filesystem access.
 * Arguments are always built as arrays (`spawn` semantics, never a shell
 * string), so file names can never be interpreted as shell syntax.
 */

/**
 * Derive the final output path for an input file.
 *
 * Every conversion targets the MP4 container, so the input's final extension
 * is replaced with `.mp4`:
 *   example.mkv  → <outDir>/example.mp4
 *   example.mp4  → <outDir>/example.mp4   (re-transcode; output lives in
 *                                           outDir, so it never collides with
 *                                           the source file itself)
 */
export function deriveOutputPath(input: string, outDir: string): string {
    const { name } = parse(basename(input));
    return join(outDir, `${name}.mp4`);
}

/**
 * Explain why a conversion must be refused, or return null when it may run.
 *
 * The converter never overwrites or deletes user files. If the derived output
 * already exists (a previous run's result, or a sibling `example.mp4` input),
 * the user is told to delete/move it manually. `outputExists` is supplied by
 * the caller so this function stays pure.
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
 * ffmpeg invocation for the compatibility target.
 *
 * Verified against ffmpeg 9.0.2 (`ffmpeg -h muxer=mp4`, `-h encoder=libx264`):
 * - `-f mp4` forces the MP4 muxer regardless of the output file name —
 *   renaming an MKV without this would keep the Matroska container.
 * - `-level 4.1` makes libx264 enforce level 4.1 limits (it clamps reference
 *   frames etc. on its own); the preflight envelope check in doTranscode
 *   rejects impossible inputs before ffmpeg is even spawned.
 * - `-y` is safe here because `output` is a converter-owned temp file
 *   (`.tmp-<name>.mp4`); promotion to the final name is an explicit rename.
 * - `-nostats` + `-progress pipe:1` keep stderr clean for diagnostics and
 *   emit machine-readable progress on stdout. `-hide_banner` drops the
 *   startup banner so the retained stderr tail is all signal.
 */
export function buildFfmpegArgs(input: string, output: string): string[] {
    return [
        "-hide_banner",
        "-nostats",
        "-y",
        "-progress", "pipe:1",
        "-i", input,
        "-c:v", "libx264",
        "-level", "4.1",
        "-pix_fmt", "yuv420p",
        "-preset", "slow",
        "-crf", "22",
        "-c:a", "aac",
        "-b:a", "128k",
        "-ac", "2",
        "-movflags", "+faststart",
        "-f", "mp4",
        output,
    ];
}
