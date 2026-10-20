import { spawn } from 'node:child_process';
import { describeSpawnFailure, StderrTail } from './stderrTail';

/**
 * ffprobe preflight and postflight probing. `runProbe` shells out with
 * argument arrays only, everything else is pure and unit testable.
 */

export class ProbeError extends Error {
    constructor(
        readonly operation: string,
        message: string,
        readonly stderrTail?: string,
    ) {
        super(message);
        this.name = 'ProbeError';
    }
}

export type VideoStreamInfo = {
    codec: string;
    width: number;
    height: number;
    /** Null when no usable rate is reported. Those inputs get rejected
     *  upstream as unvalidated. */
    fps: number | null;
    pixFmt: string | null;
};

export type AudioStreamInfo = {
    codec: string;
    channels: number;
    sampleRate: number | null;
};

export type MediaProbe = {
    container: string;
    durationSeconds: number | null;
    video: VideoStreamInfo | null;
    audio: AudioStreamInfo | null;
};

/**
 * Parse an ffprobe frame rate such as "25", "30000/1001", or "0/0".
 * Returns null for zero, malformed, or missing rates.
 */
export function parseFpsRate(rate: unknown): number | null {
    if (typeof rate !== 'string') return null;

    const match = rate.match(/^(\d+)(?:\/(\d+))?$/);

    if (match === null) return null;

    const numerator = Number(match[1]);
    const denominator = match[2] === undefined ? 1 : Number(match[2]);

    if (numerator === 0 || denominator === 0) return null;

    const fps = numerator / denominator;

    return Number.isFinite(fps) && fps > 0 ? fps : null;
}

type RawStream = {
    codec_name?: unknown;
    codec_type?: unknown;
    width?: unknown;
    height?: unknown;
    r_frame_rate?: unknown;
    avg_frame_rate?: unknown;
    pix_fmt?: unknown;
    channels?: unknown;
    sample_rate?: unknown;
    disposition?: unknown;
};

function asNumber(value: unknown): number {
    const parsed = typeof value === 'number' ? value : Number(value);

    return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function asOptionalNumber(value: unknown): number | null {
    if (value === null || value === undefined) return null;

    const parsed = typeof value === 'number' ? value : Number(value);

    return Number.isFinite(parsed) ? parsed : null;
}

function asString(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
}

/**
 * Still image codecs that carry cover art in practice. Some muxers drop the
 * attached_pic flag, and the codec check still catches those.
 */
const COVER_ART_VIDEO_CODECS = new Set(['mjpeg', 'png', 'bmp', 'tiff']);

function isAttachedPic(stream: RawStream): boolean {
    // ffprobe reports disposition flags as 0/1 integers.
    return (
        (stream.disposition as { attached_pic?: unknown } | undefined)
            ?.attached_pic === 1
    );
}

function pixelCount(stream: RawStream): number {
    const width = asNumber(stream.width);
    const height = asNumber(stream.height);

    return Number.isFinite(width) && Number.isFinite(height)
        ? width * height
        : -1;
}

/**
 * Select the video stream to measure, the same one ffmpeg's default stream
 * selection would encode: skip attached pictures and still image cover
 * codecs, pick the largest stream by pixel count, break ties by lowest
 * index. An unusable dimension stream stays selectable when it is the only
 * candidate, and the envelope check rejects it honestly.
 */
function selectVideoStream(streams: RawStream[]): RawStream | undefined {
    let best: RawStream | undefined;
    let bestPixels = Number.NEGATIVE_INFINITY;

    for (const stream of streams) {
        if (stream.codec_type !== 'video') continue;
        if (isAttachedPic(stream)) continue;
        if (
            typeof stream.codec_name === 'string' &&
            COVER_ART_VIDEO_CODECS.has(stream.codec_name)
        ) {
            continue;
        }

        const pixels = pixelCount(stream);

        // Strictly greater: the earliest stream wins a tie, like ffmpeg.
        if (pixels > bestPixels) {
            best = stream;
            bestPixels = pixels;
        }
    }

    return best;
}

/**
 * Parse the JSON emitted by `ffprobe -v error -print_format json
 * -show_format -show_streams`. Video selection mirrors ffmpeg (see
 * `selectVideoStream`) so the envelope measures the stream ffmpeg will
 * actually encode. Audio takes the FIRST stream, which is equivalent for
 * the presence and display purposes it serves. fps prefers r_frame_rate
 * (the conservative choice for a macroblocks per second limit) over
 * avg_frame_rate, and both go through parseFpsRate so "0/0" yields null.
 */
export function parseProbeOutput(raw: string): MediaProbe {
    let parsed: unknown;

    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        throw new ProbeError(
            'ffprobe-parse',
            `malformed ffprobe JSON output (${error instanceof Error ? error.message : String(error)}): ${raw.slice(0, 200)}`,
        );
    }

    if (
        typeof parsed !== 'object' ||
        parsed === null ||
        !Array.isArray((parsed as { streams?: unknown }).streams)
    ) {
        throw new ProbeError(
            'ffprobe-parse',
            'malformed ffprobe JSON output: no streams array',
        );
    }

    const streams = (parsed as { streams: RawStream[] }).streams;
    const format = (
        parsed as { format?: { format_name?: unknown; duration?: unknown } }
    ).format;

    const rawVideo = selectVideoStream(streams);
    const rawAudio = streams.find(
        (stream: RawStream): boolean => stream.codec_type === 'audio',
    );

    if (rawVideo === undefined) {
        const anyVideo = streams.some(
            (stream: RawStream): boolean => stream.codec_type === 'video',
        );

        throw new ProbeError(
            'ffprobe-streams',
            anyVideo
                ? 'ffprobe output contains no usable video stream — every video stream is ' +
                      'cover art (an attached picture or still image), so there is no feature to convert'
                : 'ffprobe output contains no video stream — the file is not convertible video',
        );
    }

    const container =
        typeof format?.format_name === 'string'
            ? format.format_name
            : 'unknown';
    const durationSeconds = asOptionalNumber(format?.duration);

    const video: VideoStreamInfo = {
        codec: asString(rawVideo.codec_name) ?? 'unknown',
        width: asNumber(rawVideo.width),
        height: asNumber(rawVideo.height),
        fps:
            parseFpsRate(rawVideo.r_frame_rate) ??
            parseFpsRate(rawVideo.avg_frame_rate),
        pixFmt: asString(rawVideo.pix_fmt),
    };

    const audio: AudioStreamInfo | null =
        rawAudio === undefined
            ? null
            : {
                  codec: asString(rawAudio.codec_name) ?? 'unknown',
                  channels: asNumber(rawAudio.channels),
                  sampleRate: asOptionalNumber(rawAudio.sample_rate),
              };

    return { container, durationSeconds, video, audio };
}

/**
 * Postflight acceptance test: null when the probe matches the target (MP4,
 * H.264 8-bit 4:2:0, AAC stereo when the input had audio), otherwise a
 * message listing every mismatch. When `sourceVideo` carries the selected
 * input stream's dimensions, the output must match within
 * MAX_DIMENSION_DRIFT_PX, which backs up the stream selection.
 */
export const MAX_DIMENSION_DRIFT_PX = 16;

export function verifyOutputProbe(
    probe: MediaProbe,
    options: {
        expectAudio: boolean;
        sourceVideo?: { width: number; height: number } | null;
    },
): string | null {
    const problems: string[] = [];

    if (!probe.container.split(',').includes('mp4')) {
        problems.push(
            `container is "${probe.container}", expected an MP4 family container`,
        );
    }

    if (probe.video === null) {
        problems.push('no video stream in output');
    } else {
        if (probe.video.codec !== 'h264') {
            problems.push(`video codec is ${probe.video.codec}, expected h264`);
        }

        if (probe.video.pixFmt !== 'yuv420p') {
            problems.push(
                `pixel format is ${probe.video.pixFmt ?? 'unknown'}, expected yuv420p`,
            );
        }

        const source = options.sourceVideo;

        if (source !== undefined && source !== null) {
            const width = probe.video.width;
            const height = probe.video.height;

            if (!Number.isFinite(width) || !Number.isFinite(height)) {
                problems.push(
                    `output video dimensions are unusable (${width}×${height}); ` +
                        `cannot confirm the encoded stream matches the validated ` +
                        `${source.width}×${source.height} input`,
                );
            } else if (
                Math.abs(width - source.width) > MAX_DIMENSION_DRIFT_PX ||
                Math.abs(height - source.height) > MAX_DIMENSION_DRIFT_PX
            ) {
                problems.push(
                    `output video is ${width}×${height} but the validated input stream was ` +
                        `${source.width}×${source.height} — ffmpeg encoded a different stream ` +
                        `than the one the level 4.1 envelope measured (drift beyond ` +
                        `${MAX_DIMENSION_DRIFT_PX}px of macroblock padding is never legitimate)`,
                );
            }
        }
    }

    if (probe.audio === null) {
        if (options.expectAudio) {
            problems.push('input had audio but the output has no audio stream');
        }
    } else if (probe.audio.codec !== 'aac' || probe.audio.channels !== 2) {
        problems.push(
            `audio is ${probe.audio.codec} × ${probe.audio.channels} channel(s), expected aac stereo`,
        );
    }

    return problems.length === 0
        ? null
        : `output verification failed: ${problems.join('; ')}`;
}

/** Probe a media file with ffprobe. Throws ProbeError with the failing
 *  operation named and a bounded stderr tail attached. */
export async function runProbe(path: string): Promise<MediaProbe> {
    if (Bun.which('ffprobe') === null) {
        throw new ProbeError(
            'ffprobe',
            describeSpawnFailure(
                'ffprobe',
                Object.assign(new Error('ffprobe ENOENT'), { code: 'ENOENT' }),
            ),
        );
    }

    return await new Promise<MediaProbe>((resolve, reject) => {
        const ffprobe = spawn('ffprobe', [
            '-v',
            'error',
            '-print_format',
            'json',
            '-show_format',
            '-show_streams',
            path,
        ]);

        const stdout: Buffer[] = [];
        const stderr = new StderrTail();

        ffprobe.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
        ffprobe.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));

        ffprobe.on('error', (error: Error) => {
            reject(
                new ProbeError(
                    'ffprobe',
                    describeSpawnFailure('ffprobe', error),
                ),
            );
        });

        ffprobe.on('close', (code: number | null) => {
            if (code !== 0) {
                reject(
                    new ProbeError(
                        'ffprobe',
                        `ffprobe failed on ${path} (exit ${code ?? 'signal'}): ${stderr.tail()}`,
                        stderr.tail(),
                    ),
                );
                return;
            }

            try {
                resolve(
                    parseProbeOutput(Buffer.concat(stdout).toString('utf8')),
                );
            } catch (error) {
                reject(
                    error instanceof ProbeError
                        ? error
                        : new ProbeError('ffprobe-parse', String(error)),
                );
            }
        });
    });
}
