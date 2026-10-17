import { describe, expect, it } from 'vitest';
import { createProjectionClock } from '../../src/playback/clock';
import { PlaybackSnapshot } from '../../src/shared';

// Client-side projection: a snapshot received at local receipt-time t0
// projects at t1 > t0 as snapshot.position + elapsed while playing. The
// clock uses its OWN injected monotonic now(), anchoring at local receipt
// time and never compares server/client clock origins.

function snapshot(revision: number, position: number, playing: boolean): PlaybackSnapshot {
    return { mediaId: 'film.mp4', playing, position, revision };
}

describe('createProjectionClock', (): void => {
    it('projects nothing before any snapshot arrives', (): void => {
        const clock = createProjectionClock((): number => 0);

        expect(clock.project()).toBeNull();
    });

    it('advances a playing snapshot by the locally elapsed time', (): void => {
        let now = 1_000;
        const clock = createProjectionClock((): number => now);
        clock.apply(snapshot(1, 100, true));

        now = 601_000;
        const projected = clock.project();
        expect(projected?.playing).toBe(true);
        expect(projected?.position).toBe(700);
        expect(projected?.revision).toBe(1);
    });

    it('reports the advancing position to a viewer joining mid-film', (): void => {
        let now = 0;
        const clock = createProjectionClock((): number => now);
        clock.apply(snapshot(2, 0, true));

        now = 600_000;
        expect(clock.project()?.position).toBe(600);
    });

    it('never advances a paused snapshot', (): void => {
        let now = 0;
        const clock = createProjectionClock((): number => now);
        clock.apply(snapshot(1, 42, false));

        now = 3_600_000;
        const projected = clock.project();
        expect(projected?.playing).toBe(false);
        expect(projected?.position).toBe(42);
    });

    it('treats a negative local clock step as zero elapsed time', (): void => {
        let now = 10_000;
        const clock = createProjectionClock((): number => now);
        clock.apply(snapshot(1, 5, true));

        now = 4_000;
        expect(clock.project()?.position).toBe(5);
    });

    it('represents an explicit seek 10 to 12 exactly, distinct from drift', (): void => {
        let now = 0;
        const clock = createProjectionClock((): number => now);
        clock.apply(snapshot(1, 10, true));
        expect(clock.project()?.position).toBe(10);

        now = 5_000; // projection would be 15 if the seek were ignored
        clock.apply(snapshot(2, 12, true));
        expect(clock.project()?.position).toBe(12);
    });

    it('drops snapshots with a stale revision and keeps projecting the newer one', (): void => {
        let now = 0;
        const clock = createProjectionClock((): number => now);
        expect(clock.apply(snapshot(5, 100, true))).toBe(true);

        now = 2_000;
        expect(clock.apply(snapshot(3, 999, true))).toBe(false); // stale

        now = 4_000;
        expect(clock.project()?.position).toBe(104); // rev 5 + 4s, not rev 3
    });

    it('re-applies equal revisions (idempotent state refresh)', (): void => {
        const clock = createProjectionClock((): number => 0);
        expect(clock.apply(snapshot(4, 10, true))).toBe(true);
        expect(clock.apply(snapshot(4, 10, true))).toBe(true);
    });

    it('resets the stale baseline on a new connection epoch', (): void => {
        const clock = createProjectionClock((): number => 0);
        clock.apply(snapshot(9, 100, true));

        clock.resetEpoch();

        // A restarted server begins revising from 0 again, which is a new
        // epoch, so the low revision must apply instead of being dropped.
        expect(clock.apply(snapshot(1, 0, false))).toBe(true);
        expect(clock.project()?.position).toBe(0);
    });

    it('discards the last snapshot on an epoch reset', (): void => {
        const clock = createProjectionClock((): number => 0);
        clock.apply(snapshot(1, 100, true));

        clock.resetEpoch();

        expect(clock.project()).toBeNull();
    });
});
