import { describe, expect, it } from 'bun:test';
import { parseProbeOutput, ProbeError } from '../../src/probeMedia';

// C1 regression: ffprobe reports EVERY stream, but ffmpeg's default stream
// selection skips attached pictures and encodes the highest-resolution real
// video stream. The preflight probe must measure the stream ffmpeg will
// actually encode, or the level-4.1 envelope validates the wrong stream:
// - cover-first files get falsely REJECTED (envelope measured the tiny,
//   high-fps cover) or falsely PROMOTED (cover passes the envelope while
//   ffmpeg encodes an out-of-envelope feature that x264 only warns about).

function videoStream(
    overrides: Record<string, unknown> = {},
): Record<string, unknown> {
    return {
        index: 0,
        codec_name: 'h264',
        codec_type: 'video',
        width: 1920,
        height: 1080,
        r_frame_rate: '30/1',
        avg_frame_rate: '30/1',
        pix_fmt: 'yuv420p',
        ...overrides,
    };
}

function probeOf(
    streams: Record<string, unknown>[],
): ReturnType<typeof parseProbeOutput> {
    return parseProbeOutput(
        JSON.stringify({
            streams,
            format: { format_name: 'matroska,webm', duration: '12.000000' },
        }),
    );
}

describe('video stream selection (ffmpeg-mirroring policy)', (): void => {
    it('skips an attached_pic cover and measures the real feature', (): void => {
        const probe = probeOf([
            videoStream({
                index: 0,
                codec_name: 'mjpeg',
                width: 400,
                height: 400,
                r_frame_rate: '1000/1',
                disposition: { attached_pic: 1 },
            }),
            videoStream({ index: 1 }),
        ]);

        expect(probe.video?.codec).toBe('h264');
        expect(probe.video?.width).toBe(1920);
        expect(probe.video?.height).toBe(1080);
        expect(probe.video?.fps).toBe(30);
    });

    it('skips still-image cover codecs even without the attached_pic disposition', (): void => {
        // The matroska muxer drops the disposition flag when a cover is
        // muxed as a mapped video stream — the codec heuristic is what
        // still identifies it as cover art.
        const probe = probeOf([
            videoStream({
                index: 0,
                codec_name: 'mjpeg',
                width: 300,
                height: 300,
            }),
            videoStream({ index: 1, width: 3840, height: 2160 }),
        ]);

        expect(probe.video?.width).toBe(3840);
        expect(probe.video?.height).toBe(2160);
    });

    it('recognizes png/bmp/tiff covers, not just mjpeg', (): void => {
        for (const codec of ['png', 'bmp', 'tiff']) {
            const probe = probeOf([
                videoStream({
                    index: 0,
                    codec_name: codec,
                    width: 300,
                    height: 300,
                }),
                videoStream({ index: 1, width: 1280, height: 720 }),
            ]);

            expect(probe.video?.width).toBe(1280);
        }
    });

    it('never selects an attached_pic stream by resolution, whatever its codec', (): void => {
        // A large album-art attachment (h264-coded, attached_pic) must not
        // win the max-resolution contest.
        const probe = probeOf([
            videoStream({
                index: 0,
                width: 5000,
                height: 4000,
                disposition: { attached_pic: 1 },
            }),
            videoStream({ index: 1, width: 1920, height: 1080 }),
        ]);

        expect(probe.video?.width).toBe(1920);
    });

    it('picks the largest stream by pixel count, not the first', (): void => {
        const probe = probeOf([
            videoStream({ index: 0, width: 1280, height: 720 }),
            videoStream({ index: 1, width: 1920, height: 1080 }),
        ]);

        expect(probe.video?.width).toBe(1920);
    });

    it('breaks resolution ties by lowest stream index', (): void => {
        const probe = probeOf([
            videoStream({
                index: 0,
                codec_name: 'hevc',
                width: 1920,
                height: 1080,
            }),
            videoStream({
                index: 1,
                codec_name: 'h264',
                width: 1920,
                height: 1080,
            }),
        ]);

        expect(probe.video?.codec).toBe('hevc');
    });

    it('prefers dimensioned streams over streams with unusable dimensions', (): void => {
        const probe = probeOf([
            videoStream({ index: 0, width: undefined, height: undefined }),
            videoStream({ index: 1, width: 640, height: 480 }),
        ]);

        expect(probe.video?.width).toBe(640);
    });

    it('still selects a lone stream with unusable dimensions (rejected later by the envelope)', (): void => {
        const probe = probeOf([
            videoStream({ width: undefined, height: undefined }),
        ]);

        expect(probe.video?.width).toBeNaN();
    });

    it('refuses a file whose only video streams are cover art', (): void => {
        expect(() =>
            probeOf([
                videoStream({
                    codec_name: 'mjpeg',
                    width: 400,
                    height: 400,
                    disposition: { attached_pic: 1 },
                }),
            ]),
        ).toThrow(ProbeError);
        expect(() => probeOf([videoStream({ codec_name: 'png' })])).toThrow(
            /cover/i,
        );
    });

    it('keeps refusing an audio-only file with the original wording', (): void => {
        expect(() =>
            probeOf([{ codec_name: 'aac', codec_type: 'audio', channels: 2 }]),
        ).toThrow(/no video stream/i);
    });
});

describe('audio stream selection (documented first-audio-wins policy)', (): void => {
    it('reports the FIRST audio stream even when a later one has more channels', (): void => {
        // Deliberate, documented divergence from ffmpeg's default audio
        // selection (most channels): audio metadata is only used for
        // presence (expectAudio) and display, where first vs best is
        // equivalent — any audio stream means ffmpeg maps one.
        const probe = probeOf([
            videoStream(),
            {
                index: 1,
                codec_name: 'aac',
                codec_type: 'audio',
                channels: 2,
                sample_rate: '48000',
            },
            { index: 2, codec_name: 'ac3', codec_type: 'audio', channels: 6 },
        ]);

        expect(probe.audio?.codec).toBe('aac');
        expect(probe.audio?.channels).toBe(2);
    });
});
