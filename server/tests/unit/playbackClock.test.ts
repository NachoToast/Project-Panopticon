import { describe, expect, it } from 'vitest';
import { PlaybackClock } from '../../src/playback/PlaybackClock.js';

// Server-authoritative clock. position(now) = basePosition +
// (playing ? max(0, now - anchorMs) / 1000 : 0), with `now` injected so
// tests can teleport time.

describe('PlaybackClock', (): void => {
    it('starts paused at zero with no media and revision 0', (): void => {
        const now = 0;
        const clock = new PlaybackClock(() => now);

        expect(clock.snapshot()).toEqual({
            mediaId: null,
            playing: false,
            position: 0,
            revision: 0,
        });
    });

    it('reports the advancing position to a late joiner', (): void => {
        let now = 0;
        const clock = new PlaybackClock(() => now);
        clock.selectMedia('film-a.mp4');
        clock.play({ mediaId: 'film-a.mp4', position: 0 });
        now = 600_000;
        expect(clock.snapshot().position).toBe(600);
    });

    it('advances from a non-zero base after play', (): void => {
        let now = 1_000;
        const clock = new PlaybackClock(() => now);
        clock.selectMedia('film.mp4');
        clock.play({ mediaId: 'film.mp4', position: 100 });

        now = 11_000;
        expect(clock.snapshot().position).toBe(110);
    });

    it('does not advance while paused', (): void => {
        let now = 0;
        const clock = new PlaybackClock(() => now);
        clock.selectMedia('film.mp4');
        clock.pause({ mediaId: 'film.mp4', position: 33 });

        now = 3_600_000;
        const snapshot = clock.snapshot();
        expect(snapshot.playing).toBe(false);
        expect(snapshot.position).toBe(33);
    });

    it('freezes at the paused position regardless of elapsed time', (): void => {
        let now = 0;
        const clock = new PlaybackClock(() => now);
        clock.selectMedia('film.mp4');
        clock.play({ mediaId: 'film.mp4', position: 0 });

        now = 10_000; // playing position: 10
        clock.pause({ mediaId: 'film.mp4', position: 15 });

        now = 10_000_000;
        expect(clock.snapshot().position).toBe(15);
    });

    it('continues from the new base after a seek while playing', (): void => {
        let now = 0;
        const clock = new PlaybackClock(() => now);
        clock.selectMedia('film.mp4');
        clock.play({ mediaId: 'film.mp4', position: 0 });

        now = 50_000; // playing position: 50
        clock.seek({ mediaId: 'film.mp4', position: 200 });

        now = 60_000; // 10s after the seek anchor
        expect(clock.snapshot().position).toBe(210);
    });

    it('stays at the new base after a seek while paused', (): void => {
        let now = 0;
        const clock = new PlaybackClock(() => now);
        clock.selectMedia('film.mp4');
        clock.seek({ mediaId: 'film.mp4', position: 42 });

        now = 7_200_000;
        const snapshot = clock.snapshot();
        expect(snapshot.playing).toBe(false);
        expect(snapshot.position).toBe(42);
    });

    it('treats a negative wall-clock step as zero elapsed time', (): void => {
        let now = 5_000;
        const clock = new PlaybackClock(() => now);
        clock.selectMedia('film.mp4');
        clock.play({ mediaId: 'film.mp4', position: 10 });

        now = 2_000; // clock went backwards; must not rewind below base
        expect(clock.snapshot().position).toBe(10);
    });

    it('preserves state and revision when the same media is re-selected', (): void => {
        let now = 0;
        const clock = new PlaybackClock(() => now);
        clock.selectMedia('film.mp4');
        clock.play({ mediaId: 'film.mp4', position: 100 });
        now = 10_000; // playing position: 110
        const before = clock.snapshot();

        clock.selectMedia('film.mp4'); // e.g. host re-announces on reconnect

        const after = clock.snapshot();
        expect(after.mediaId).toBe('film.mp4');
        expect(after.playing).toBe(true);
        expect(after.position).toBe(110);
        expect(after.revision).toBe(before.revision);
    });

    it('resets to paused at zero with a bumped revision on a different media', (): void => {
        let now = 0;
        const clock = new PlaybackClock(() => now);
        clock.selectMedia('film-a.mp4');
        clock.play({ mediaId: 'film-a.mp4', position: 500 });
        now = 600_000;
        const revisionBefore = clock.snapshot().revision;

        clock.selectMedia('film-b.mp4');

        const snapshot = clock.snapshot();
        expect(snapshot.mediaId).toBe('film-b.mp4');
        expect(snapshot.playing).toBe(false);
        expect(snapshot.position).toBe(0);
        expect(snapshot.revision).toBe(revisionBefore + 1);
    });

    it('bumps the revision on every state change and never resets it', (): void => {
        const now = 0;
        const clock = new PlaybackClock(() => now);
        expect(clock.snapshot().revision).toBe(0);

        clock.selectMedia('film.mp4');
        expect(clock.snapshot().revision).toBe(1);

        clock.play({ mediaId: 'film.mp4', position: 0 });
        expect(clock.snapshot().revision).toBe(2);

        clock.seek({ mediaId: 'film.mp4', position: 30 });
        expect(clock.snapshot().revision).toBe(3);

        clock.pause({ mediaId: 'film.mp4', position: 31 });
        expect(clock.snapshot().revision).toBe(4);

        clock.selectMedia('other.mp4');
        expect(clock.snapshot().revision).toBe(5);

        // Selecting the same (current) media is a no-op: no bump.
        clock.selectMedia('other.mp4');
        expect(clock.snapshot().revision).toBe(5);
    });

    it('exposes the current mediaId for command validation', (): void => {
        const clock = new PlaybackClock((): number => 0);
        expect(clock.currentMediaId()).toBeNull();

        clock.selectMedia('film.mp4');
        expect(clock.currentMediaId()).toBe('film.mp4');
    });

    it('treats an explicit seek 10 to 12 as exact, distinct from drift', (): void => {
        const now = 0;
        const clock = new PlaybackClock(() => now);
        clock.selectMedia('film.mp4');
        clock.seek({ mediaId: 'film.mp4', position: 10 });
        expect(clock.snapshot().position).toBe(10);

        clock.seek({ mediaId: 'film.mp4', position: 12 });
        expect(clock.snapshot().position).toBe(12);
    });
});
