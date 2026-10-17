import { PlaybackCommand, PlaybackSnapshot } from '../shared/index.js';

/**
 * Server-authoritative playback clock: position(now) = basePosition +
 * (playing ? max(0, now - anchorMs) / 1000 : 0), with `now` injected (never
 * wall-clock, never cross-machine origins). The revision counter bumps on
 * every state change and never resets within a server lifetime. Commands
 * must be validated and addressed to the current media before reaching the
 * clock; Cinema owns that boundary.
 */
export class PlaybackClock {
    private mediaId: string | null = null;

    private playing = false;

    private basePosition = 0;

    private anchorMs = 0;

    private revision = 0;

    public constructor(private readonly now: () => number) {}

    /**
     * Selects the media identity. Re-selecting the current media is a no-op
     * (a host re-announcing on reconnect must not reset the film); a
     * different media resets to paused at 0.
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
