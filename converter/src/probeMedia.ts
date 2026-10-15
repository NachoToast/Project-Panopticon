import { spawn } from 'node:child_process';
import { describeSpawnFailure, StderrTail } from './stderrTail';

/**
 * ffprobe preflight/postflight probing.
 *
 * `runProbe` shells out (arrays only, never a shell string); everything else
 * here is pure and unit-testable with JSON fixtures.
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
    /** null when no usable rate is reported — inputs like that are rejected
     *  upstream as unvalidated rather than silently passed. */
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
 * Still-image codecs that carry cover art in practice. Real feature video
 * in this converter's scope is never mjpeg/png/bmp/tiff, but cover art
 * frequently is — including covers that were muxed WITHOUT the
 * `attached_pic` disposition (ffmpeg 9's matroska muxer, for one, drops
 * the flag on mapped video streams), which the codec check still catches.
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
 * Select the video stream to measure — the same one ffmpeg's default
 * stream selection would encode:
 *
 * 1. skip `disposition.attached_pic === 1` streams (ffmpeg never encodes
 *    attached pictures);
 * 2. skip still-image cover codecs (mjpeg/png/bmp/tiff) — the belt to
 *    the disposition's suspenders, covering covers whose flag was lost in
 *    remuxing;
 * 3. among the rest, pick the largest stream by pixel count
 *    (width × height);
 * 4. break ties by lowest stream index.
 *
 * A stream with unusable dimensions ranks below any dimensioned stream but
 * remains selectable when it is the only candidate — the envelope check
 * then rejects it honestly as unvalidated instead of the probe pretending
 * the file has no video.
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
 * Parse the JSON emitted by
 * `ffprobe -v error -print_format json -show_format -show_streams`.
 *
 * Stream selection policy (this is what makes the level-4.1 preflight
 * measure the stream ffmpeg will actually encode — see
 * `selectVideoStream` above for the video rules):
 * - Video: ffmpeg-mirroring — attached pictures and still-image cover
 *   codecs are skipped, the largest remaining stream by pixel count wins,
 *   ties break to the lowest index. Divergence here means the envelope
 *   validates one stream while ffmpeg encodes another (x264 only warns on
 *   impossible levels, so the file would be promoted with a lying level
 *   flag).
 * - Audio: FIRST audio stream by index, deliberately. ffmpeg's own default
 *   picks the stream with the most channels, but audio metadata is used
 *   only for presence (postflight `expectAudio`) and display, where the
 *   two policies are equivalent: any audio stream means ffmpeg maps one.
 *
 * fps preference: r_frame_rate first (the stream's base/maximum rate — the
 * conservative choice for a macroblocks-per-second limit), falling back to
 * avg_frame_rate for streams that only carry average metadata. Both use
 * parseFpsRate, so "0/0" yields null instead of a bogus 0.
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
 * Postflight acceptance test for a finished conversion. Returns null when the
 * probe matches the compatibility target (MP4 container, H.264 8-bit 4:2:0,
 * and — when the input had audio — AAC stereo), otherwise a message listing
 * every mismatch.
 *
 * When `sourceVideo` carries the SELECTED input stream's dimensions (the
 * same stream the level-4.1 envelope measured), the output video's
 * dimensions must match it within `MAX_DIMENSION_DRIFT_PX`. This is the
 * backstop against stream-selection drift: x264 does not fail on
 * impossible levels (it warns and writes a higher level flag), so without
 * this check a probe/ffmpeg selection divergence could promote
 * out-of-envelope output.
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
