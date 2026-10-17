import { describe, expect, it } from 'bun:test';
import { ProgressParser, type TranscodeProgress } from '../../src/doTranscode';
import { clock, createFileProgress } from '../../src/main';

// I3: `-progress pipe:1` reports arrive as arbitrary-sized data events,
// keys and values split mid-token across chunks. The parser must buffer on
// report boundaries (a report ends at its `progress=` terminator line) and
// only emit complete reports.

const FULL_REPORT = [
    'frame=150',
    'fps=25.4',
    'out_time_us=5000000',
    'total_size=123456',
    'speed=1.5x',
    'progress=continue',
    '',
].join('\n');

describe('ProgressParser', (): void => {
    it('parses a complete report delivered in one chunk', (): void => {
        const parser = new ProgressParser();

        const reports = parser.feed(FULL_REPORT);

        expect(reports).toHaveLength(1);
        expect(reports[0]).toMatchObject({
            frame: 150,
            outTimeSeconds: 5,
            fps: 25.4,
            speed: '1.5x',
            done: false,
        });
    });

    it('reassembles a report split mid-key', (): void => {
        const parser = new ProgressParser();

        expect(parser.feed('frame=150\nout_ti')).toEqual([]);
        const reports = parser.feed('me_us=5000000\nprogress=continue\n');

        expect(reports).toHaveLength(1);
        expect(reports[0]!.frame).toBe(150);
        expect(reports[0]!.outTimeSeconds).toBe(5);
    });

    it('reassembles a report split mid-value', (): void => {
        const parser = new ProgressParser();

        parser.feed('frame=90\nout_time_us=50');
        const reports = parser.feed('00000\nspeed=1.0x\nprogress=continue\n');

        expect(reports).toHaveLength(1);
        expect(reports[0]!.outTimeSeconds).toBe(5);
        expect(reports[0]!.speed).toBe('1.0x');
    });

    it('emits two reports from one chunk without leaking keys across them', (): void => {
        const parser = new ProgressParser();
        const twoReports = FULL_REPORT + 'frame=300\nprogress=continue\n';

        const reports = parser.feed(twoReports);

        expect(reports).toHaveLength(2);
        expect(reports[0]!.frame).toBe(150);
        expect(reports[1]!.frame).toBe(300);
        // fps/speed belonged to the first report only.
        expect(reports[1]!.fps).toBeNull();
        expect(reports[1]!.speed).toBeNull();
    });

    it('maps a negative out_time_us to null (startup jitter is not a time)', (): void => {
        const parser = new ProgressParser();

        const reports = parser.feed('out_time_us=-132000\nprogress=continue\n');

        expect(reports[0]!.outTimeSeconds).toBeNull();
    });

    it('maps a missing out_time_us to null', (): void => {
        const parser = new ProgressParser();

        const reports = parser.feed('frame=7\nprogress=continue\n');

        expect(reports[0]!.outTimeSeconds).toBeNull();
        expect(reports[0]!.frame).toBe(7);
    });

    it('marks the progress=end terminator as done', (): void => {
        const parser = new ProgressParser();

        const reports = parser.feed(
            'frame=300\nout_time_us=10000000\nprogress=end\n',
        );

        expect(reports).toHaveLength(1);
        expect(reports[0]!.done).toBe(true);
        expect(reports[0]!.outTimeSeconds).toBe(10);
    });

    it('flushes a trailing partial report that never got its terminator', (): void => {
        const parser = new ProgressParser();

        parser.feed('frame=3\nout_time_us=100000\n');

        const flushed = parser.flush();

        expect(flushed).not.toBeNull();
        expect(flushed!.frame).toBe(3);
        expect(flushed!.outTimeSeconds).toBe(0.1);
        expect(flushed!.done).toBe(false);
        // Flushing is one-shot: nothing is left afterwards.
        expect(parser.flush()).toBeNull();
    });

    it('returns nothing for chunks without a complete line', (): void => {
        const parser = new ProgressParser();

        expect(parser.feed('out_time_us=1')).toEqual([]);
        expect(parser.flush()).not.toBeNull();
    });
});

// I2: the preflight duration rides on every progress emission, so the TTY
// percent display works in production (not just in unit tests that hand a
// duration to formatProgressLine).
describe('progress display carries the input duration', (): void => {
    it('renders a percent from a real-shaped progress payload', (): void => {
        const writes: string[] = [];
        const display = createFileProgress('clip.mkv', {
            isTty: true,
            write: (text: string) => writes.push(text),
        });
        const progress: TranscodeProgress = {
            frame: 150,
            outTimeSeconds: 5,
            fps: 30,
            speed: '1.5x',
            done: false,
            durationSeconds: 10,
        };

        display.update(progress);

        expect(writes[0]).toContain('50%');
        expect(writes[0]).toContain('00:05.0 / 00:10.0');
    });

    it('omits the percent when the duration is unknown', (): void => {
        const writes: string[] = [];
        const display = createFileProgress('clip.mkv', {
            isTty: true,
            write: (text: string) => writes.push(text),
        });

        display.update({
            frame: 150,
            outTimeSeconds: 5,
            fps: 30,
            speed: '1.5x',
            done: false,
            durationSeconds: null,
        });

        expect(writes[0]).not.toContain('%');
    });
});

// M3: rounding the seconds remainder must carry into the minutes instead
// of rendering a nonexistent 00:60.0.
describe('clock', (): void => {
    it('carries rounding into the minutes (no 00:60.0)', (): void => {
        expect(clock(59.96)).toBe('01:00.0');
        expect(clock(3599.97)).toBe('60:00.0');
    });

    it('renders ordinary times unchanged', (): void => {
        expect(clock(5)).toBe('00:05.0');
        expect(clock(65.44)).toBe('01:05.4');
        expect(clock(0)).toBe('00:00.0');
    });
});
