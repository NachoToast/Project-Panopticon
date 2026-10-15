import { PlaybackCommand, PlaybackSnapshot } from '../shared/index.js';

/**
 * Server-authoritative playback clock.
 *
 * Projects the live position from an anchor:
 *
 * ```text
 * position(now) = basePosition + (playing ? max(0, now - anchorMs) / 1000 : 0)
 * ```
 *
 * `now` is injected (the server passes a monotonic `performance.now` wrapper;
 * tests teleport time) so the clock never depends on wall-clock dates and
 * never compares clock origins across machines. The revision is a
 * monotonically increasing counter that starts at 0, bumps on every state
 * change (including media resets), and never resets within a server
 * lifetime — clients use it to drop stale snapshots.
 *
 * Commands are expected to be VALIDATED (shared guards) and addressed to the
 * CURRENT media before they reach the clock; Room Cinema owns that boundary.
 */
export class PlaybackClock {
    private mediaId: string | null = null;

    private playing = false;

    private basePosition = 0;

    private anchorMs = 0;

    private revision = 0;

    public constructor(private readonly now: () => number) {}

    /**
     * Selects the media identity. Re-selecting the CURRENT media is a no-op
     * that preserves position, playing state, and revision (a host
     * re-announcing on reconnect must not reset the film). Selecting a
     * DIFFERENT media resets: paused at position 0, revision bumped.
     */
    public selectMedia(mediaId: string): void {
        if (mediaId === this.mediaId) {
            return;
        }

        this.mediaId = mediaId;
        this.playing = false;
        this.basePosition = 0;
        this.anchorMs = this.now();
        this.revision += 1;
    }

    /** Sets playing from the command position, re-anchored at now. */
    public play(command: PlaybackCommand): void {
        this.playing = true;
        this.basePosition = command.position;
        this.anchorMs = this.now();
        this.revision += 1;
    }

    /** Freezes at the command position; revision bumped. */
    public pause(command: PlaybackCommand): void {
        this.playing = false;
        this.basePosition = command.position;
        this.revision += 1;
    }

    /** Re-bases at the command position; playing state unchanged. */
    public seek(command: PlaybackCommand): void {
        this.basePosition = command.position;
        this.anchorMs = this.now();
        this.revision += 1;
    }

    /** Projects the current position per the anchor formula. */
    public snapshot(): PlaybackSnapshot {
        const elapsedSeconds = this.playing
            ? Math.max(0, this.now() - this.anchorMs) / 1000
            : 0;

        return {
            mediaId: this.mediaId,
            playing: this.playing,
            position: this.basePosition + elapsedSeconds,
            revision: this.revision,
        };
    }

    /** The selected mediaId without projecting a snapshot; null when none. */
    public currentMediaId(): string | null {
        return this.mediaId;
    }
}
