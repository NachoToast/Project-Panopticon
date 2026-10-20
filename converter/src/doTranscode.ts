import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join, parse } from 'node:path';
import {
    buildFfmpegArgs,
    checkLevel41Envelope,
    describeOutputRefusal,
    deriveOutputPath,
} from './ffmpegArgs';
import { runProbe, verifyOutputProbe } from './probeMedia';
import { describeSpawnFailure, StderrTail } from './stderrTail';

/**
 * One conversion, done safely: (1) a preflight probe plus the H.264 level
 * 4.1 envelope check rejects before any encoding work starts. (2) ffmpeg
 * writes to a converter owned temp file `.tmp-<name>.mp4`, so `-y` can
 * only ever clobber a stale temp. (3) a postflight probe verifies the temp
 * file really is MP4/h264/yuv420p/aac-stereo. (4) only then does the temp
 * file get renamed into place, and any failure deletes it first. stderr
 * accumulates into a bounded 64KiB tail on every failure.
 */

const STDERR_TAIL_BYTES = 64 * 1024;

export class TranscodeError extends Error {
    constructor(
        readonly operation: string,
        message: string,
        readonly stderrTail?: string,
    ) {
        super(message);
        this.name = 'TranscodeError';
    }
}

export type TranscodeProgress = {
    frame: number | null;
    outTimeSeconds: number | null;
    fps: number | null;
    speed: string | null;
    done: boolean;
    /** Total input duration from the preflight probe so progress can
     *  render a percent. Null when the container reports no duration. */
    durationSeconds: number | null;
};

export type ProgressSink = (progress: TranscodeProgress) => void;

export type TranscodeResult = {
    input: string;
    output: string;
    durationSeconds: number | null;
    elapsedMs: number;
    /** Non fatal diagnostics surfaced on success, e.g. x264 level warnings. */
    warnings: string[];
};

/** The temp file sits next to the final output so promotion is a plain
 *  rename, never a cross filesystem copy. */
export function tempOutputPath(output: string): string {
    const { dir, name } = parse(output);

    return join(dir, `.tmp-${name}.mp4`);
}

function buildProgress(values: Map<string, string>): TranscodeProgress | null {
    if (values.size === 0) return null;

    const outTimeUs = values.get('out_time_us');
    const outTimeNumber =
        outTimeUs === undefined ? Number.NaN : Number(outTimeUs);

    const frameValue = values.get('frame');
    const fpsValue = values.get('fps');

    return {
        frame:
            frameValue !== undefined && Number.isFinite(Number(frameValue))
                ? Number(frameValue)
                : null,
        outTimeSeconds:
            Number.isFinite(outTimeNumber) && outTimeNumber >= 0
                ? outTimeNumber / 1_000_000
                : null,
        fps:
            fpsValue !== undefined && Number.isFinite(Number(fpsValue))
                ? Number(fpsValue)
                : null,
        speed: values.get('speed') ?? null,
        done: values.get('progress') === 'end',
        durationSeconds: null,
    };
}

/**
 * Stateful parser for ffmpeg `-progress pipe:1` output. Data events split
 * anywhere, so chunks are buffered and consumed one complete line at a
 * time. A report is emitted exactly when its `progress=` terminator
 * arrives, which keeps keys from leaking across reports.
 */
export class ProgressParser {
    private buffer = '';
    private values = new Map<string, string>();

    /** Feed one stdout chunk and get the completed reports back. */
    feed(chunk: string): TranscodeProgress[] {
        this.buffer += chunk;

        const reports: TranscodeProgress[] = [];

        let newline = this.buffer.indexOf('\n');

        while (newline !== -1) {
            const line = this.buffer.slice(0, newline);

            this.buffer = this.buffer.slice(newline + 1);

            const separator = line.indexOf('=');

            if (separator > 0) {
                const key = line.slice(0, separator).trim();

                this.values.set(key, line.slice(separator + 1).trim());

                if (key === 'progress') {
                    const report = buildProgress(this.values);

                    if (report !== null) reports.push(report);

                    this.values.clear();
                }
            }

            newline = this.buffer.indexOf('\n');
        }

        return reports;
    }

    /** Emits a final unterminated report at end of stream, once. */
    flush(): TranscodeProgress | null {
        const trailing = this.buffer;

        this.buffer = '';

        const separator = trailing.indexOf('=');

        if (separator > 0) {
            this.values.set(
                trailing.slice(0, separator).trim(),
                trailing.slice(separator + 1).trim(),
            );
        }

        const report = buildProgress(this.values);

        this.values.clear();

        return report;
    }
}

/**
 * libx264 does NOT fail on an impossible level: it warns on stderr, exits 0,
 * and writes a higher level flag. The preflight envelope does the actual
 * enforcing, and this scan surfaces those warnings on success.
 */
export function findX264LevelWarnings(stderrText: string): string[] {
    return stderrText
        .split('\n')
        .filter((line: string): boolean => line.includes('> level limit'));
}

function removeTemp(temp: string): void {
    // The `.tmp-*` namespace inside outDir belongs to the converter, and
    // recursive also clears a stale temp directory. Cleanup stays best
    // effort so it cannot mask the original error.
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

    // An existing output is a refusal naming both paths. Duplicated with
    // main.ts's batch pre-check to cover the TOCTOU window, keep both.
    const refusal = describeOutputRefusal(input, output, existsSync(output));

    if (refusal !== null) {
        throw new TranscodeError('output-collision', refusal);
    }

    // Preflight: what are we actually converting?
    let preflight;

    try {
        preflight = await runProbe(input);
    } catch (error) {
        const tail = (error as StderrTailCarrier | null)?.stderrTail;

        throw new TranscodeError(
            'preflight-probe',
            `cannot probe input ${input}: ${errorMessage(error)}`,
            typeof tail === 'string' ? tail : undefined,
        );
    }

    if (preflight.video === null) {
        // parseProbeOutput already refuses output without a video stream,
        // this is a backstop.
        throw new TranscodeError(
            'preflight-probe',
            `no video stream in ${input}`,
        );
    }

    const envelope = checkLevel41Envelope({
        width: preflight.video.width,
        height: preflight.video.height,
        fps: preflight.video.fps,
    });

    if (!envelope.ok) {
        throw new TranscodeError('compatibility-preflight', envelope.message);
    }

    // Encode into the temp file.
    const temp = tempOutputPath(output);
    const stderr = new StderrTail(STDERR_TAIL_BYTES);
    const parser = new ProgressParser();
    const durationSeconds = preflight.durationSeconds;

    const ffmpeg = spawn('ffmpeg', buildFfmpegArgs(input, temp));

    ffmpeg.stdout.setEncoding('utf-8');

    ffmpeg.stderr.on('data', (chunk: Buffer) => {
        stderr.push(chunk);
    });

    ffmpeg.stdout.on('data', (chunk: string) => {
        for (const report of parser.feed(chunk)) {
            // The preflight duration rides on every emission so progress
            // displays can render a percent.
            onProgress?.({ ...report, durationSeconds });
        }
    });

    const exitCode = await new Promise<number | null>((resolve, reject) => {
        ffmpeg.on('error', (error: Error) => {
            reject(
                new TranscodeError(
                    'ffmpeg',
                    describeSpawnFailure('ffmpeg', error),
                ),
            );
        });
        ffmpeg.on('close', (code: number | null) => {
            resolve(code);
        });
    });

    if (exitCode !== 0) {
        removeTemp(temp);

        throw new TranscodeError(
            'ffmpeg',
            `ffmpeg exited with code ${exitCode ?? 'signal'} converting ${input} → ${output}:\n${stderr.tail()}`,
            stderr.tail(),
        );
    }

    // Verify the temp file before it takes the final name. sourceVideo
    // pins the output to the stream the envelope measured.
    let postflight;

    try {
        postflight = await runProbe(temp);
    } catch (error) {
        removeTemp(temp);

        throw new TranscodeError(
            'postflight-probe',
            `cannot probe finished output ${temp}: ${errorMessage(error)}`,
            stderr.tail(),
        );
    }

    const problems = verifyOutputProbe(postflight, {
        expectAudio: preflight.audio !== null,
        sourceVideo: preflight.video,
    });

    if (problems !== null) {
        removeTemp(temp);

        throw new TranscodeError(
            'postflight-verify',
            `${problems} (${temp})`,
            stderr.tail(),
        );
    }

    // Promotion: explicit rename, the only moment the final name is written.
    try {
        renameSync(temp, output);
    } catch (error) {
        removeTemp(temp);

        throw new TranscodeError(
            'promote',
            `cannot move finished output ${temp} → ${output}: ${errorMessage(error)}`,
        );
    }

    return {
        input,
        output,
        durationSeconds,
        elapsedMs: Date.now() - startedAt,
        warnings: findX264LevelWarnings(stderr.tail()),
    };
}
