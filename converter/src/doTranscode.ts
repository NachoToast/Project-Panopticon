import { spawn } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join, parse } from "node:path";
import { buildFfmpegArgs, checkLevel41Envelope, describeOutputRefusal, deriveOutputPath } from "./ffmpegArgs";
import { runProbe, verifyOutputProbe } from "./probeMedia";
import { describeSpawnFailure, StderrTail } from "./stderrTail";

/**
 * One conversion, done safely:
 *
 * 1. preflight probe of the input + H.264 level 4.1 envelope check
 *    (reject before any encoding work, with measured values and limits);
 * 2. ffmpeg writes to a converter-owned temp file `.tmp-<name>.mp4`
 *    inside the output directory (`-y` therefore only ever clobbers a
 *    stale temp file from a crashed run — never a user file);
 * 3. postflight probe verifies the temp file really is MP4 / h264 /
 *    yuv420p / aac-stereo (or audio-less when the input had none);
 * 4. only then is the temp file RENAMED into place. Any failure deletes
 *    the temp file, so partial output is never promoted.
 *
 * stderr is accumulated across all chunk boundaries into a bounded 64KiB
 * tail that rides along on every failure.
 */

const STDERR_TAIL_BYTES = 64 * 1024;

export class TranscodeError extends Error {
    constructor(
        readonly operation: string,
        message: string,
        readonly stderrTail?: string,
    ) {
        super(message);
        this.name = "TranscodeError";
    }
}

export type TranscodeProgress = {
    frame: number | null;
    outTimeSeconds: number | null;
    fps: number | null;
    speed: string | null;
    done: boolean;
};

export type ProgressSink = (progress: TranscodeProgress) => void;

export type TranscodeResult = {
    input: string;
    output: string;
    durationSeconds: number | null;
    elapsedMs: number;
};

/** The temp file sits next to the final output so the promotion is a plain
 *  rename within the same directory (never a cross-filesystem copy). */
export function tempOutputPath(output: string): string {
    const { dir, name } = parse(output);

    return join(dir, `.tmp-${name}.mp4`);
}

/** Parse one `-progress pipe:1` report (key=value lines). Returns null for
 *  chunks that contain no report. */
export function parseProgressReport(report: string): TranscodeProgress | null {
    const values = new Map<string, string>();

    for (const line of report.split("\n")) {
        const separator = line.indexOf("=");

        if (separator <= 0) continue;

        values.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
    }

    if (values.size === 0) return null;

    const outTimeUs = values.get("out_time_us");
    const outTimeNumber = outTimeUs === undefined ? Number.NaN : Number(outTimeUs);

    const frameValue = values.get("frame");
    const fpsValue = values.get("fps");

    return {
        frame: frameValue !== undefined && Number.isFinite(Number(frameValue)) ? Number(frameValue) : null,
        outTimeSeconds:
            Number.isFinite(outTimeNumber) && outTimeNumber >= 0 ? outTimeNumber / 1_000_000 : null,
        fps: fpsValue !== undefined && Number.isFinite(Number(fpsValue)) ? Number(fpsValue) : null,
        speed: values.get("speed") ?? null,
        done: values.get("progress") === "end",
    };
}

function removeTemp(temp: string): void {
    // The `.tmp-*` namespace inside outDir belongs to the converter; force +
    // recursive also clears a stale temp that some earlier crash left as a
    // directory. Best-effort: cleanup must never mask the original error.
    try {
        rmSync(temp, { force: true, recursive: true });
    } catch {
        // ignored on purpose
    }
}

/** Anything that can carry a bounded stderr tail out of a failed child
 *  process (ProbeError, TranscodeError). */
interface StderrTailCarrier {
    readonly stderrTail?: string;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export async function doTranscode(
    input: string,
    outDir: string,
    options?: { onProgress?: ProgressSink },
): Promise<TranscodeResult> {
    const onProgress = options?.onProgress;
    const startedAt = Date.now();

    mkdirSync(outDir, { recursive: true });

    const output = deriveOutputPath(input, outDir);

    // The final output is never overwritten; an existing file is a refusal
    // naming both paths. (`-y` below applies to the temp file only.)
    const refusal = describeOutputRefusal(input, output, existsSync(output));

    if (refusal !== null) {
        throw new TranscodeError("output-collision", refusal);
    }

    // Preflight: what are we actually converting?
    let preflight;

    try {
        preflight = await runProbe(input);
    } catch (error) {
        const tail = (error as StderrTailCarrier | null)?.stderrTail;

        throw new TranscodeError(
            "preflight-probe",
            `cannot probe input ${input}: ${errorMessage(error)}`,
            typeof tail === "string" ? tail : undefined,
        );
    }

    if (preflight.video === null) {
        // parseProbeOutput already refuses probe output without a video
        // stream; this is unreachable-in-practice defense.
        throw new TranscodeError("preflight-probe", `no video stream in ${input}`);
    }

    const envelope = checkLevel41Envelope({
        width: preflight.video.width,
        height: preflight.video.height,
        fps: preflight.video.fps,
    });

    if (!envelope.ok) {
        throw new TranscodeError("compatibility-preflight", envelope.message);
    }

    // Encode into the temp file.
    const temp = tempOutputPath(output);
    const stderr = new StderrTail(STDERR_TAIL_BYTES);

    const ffmpeg = spawn("ffmpeg", buildFfmpegArgs(input, temp));

    ffmpeg.stdout.setEncoding("utf-8");

    ffmpeg.stderr.on("data", (chunk: Buffer) => {
        stderr.push(chunk);
    });

    ffmpeg.stdout.on("data", (chunk: string) => {
        const progress = parseProgressReport(chunk);

        if (progress !== null) {
            onProgress?.(progress);
        }
    });

    const exitCode = await new Promise<number | null>((resolve, reject) => {
        ffmpeg.on("error", (error: Error) => {
            reject(new TranscodeError("ffmpeg", describeSpawnFailure("ffmpeg", error)));
        });
        ffmpeg.on("close", (code: number | null) => {
            resolve(code);
        });
    });

    if (exitCode !== 0) {
        removeTemp(temp);

        throw new TranscodeError(
            "ffmpeg",
            `ffmpeg exited with code ${exitCode ?? "signal"} converting ${input} → ${output}:\n${stderr.tail()}`,
            stderr.tail(),
        );
    }

    // Postflight: verify the temp file before it may take the final name.
    let postflight;

    try {
        postflight = await runProbe(temp);
    } catch (error) {
        removeTemp(temp);

        throw new TranscodeError(
            "postflight-probe",
            `cannot probe finished output ${temp}: ${errorMessage(error)}`,
            stderr.tail(),
        );
    }

    const problems = verifyOutputProbe(postflight, { expectAudio: preflight.audio !== null });

    if (problems !== null) {
        removeTemp(temp);

        throw new TranscodeError("postflight-verify", `${problems} (${temp})`, stderr.tail());
    }

    // Promotion: explicit rename, the only moment the final name is written.
    try {
        renameSync(temp, output);
    } catch (error) {
        removeTemp(temp);

        throw new TranscodeError(
            "promote",
            `cannot move finished output ${temp} → ${output}: ${errorMessage(error)}`,
        );
    }

    return {
        input,
        output,
        durationSeconds: preflight.durationSeconds,
        elapsedMs: Date.now() - startedAt,
    };
}
