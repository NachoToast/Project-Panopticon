import { PlaybackSnapshot } from '../shared';

/**
 * Client-side projection of server playback snapshots.
 *
 * A snapshot received at local receipt-time t0 projects at t1 > t0 as
 * `snapshot.position + (playing ? (t1 - t0) / 1000 : 0)` — the same anchor
 * formula the server clock uses, but anchored at LOCAL receipt time via the
 * injected monotonic `now`. It never compares server/client clock origins,
 * so host/viewer clock skew cannot skew playback.
 *
 * The clock also owns the two revision rules from the wire contract:
 *
 * - stale drop: within a connection epoch, snapshots with a revision lower
 *   than the highest applied one are ignored (`apply` returns false);
 * - epoch reset: on a fresh socket connection the server may have restarted
 *   (revisions restarting at 0), so `resetEpoch` forgets the baseline — and
 *   the last snapshot, since it may no longer describe the room.
 *
 * Positions are carried exactly: an explicit seek 10 → 12 stays 12; there is
 * deliberately NO drift threshold here. Snapshots are expected to be
 * validated (`isPlaybackSnapshot`) by the caller before `apply`.
 */
export interface ProjectionClock {
    /**
     * Ingests a snapshot. Returns false when it was stale for this epoch
     * (revision below the highest applied) and therefore ignored.
     */
    apply(snapshot: PlaybackSnapshot): boolean;

    /** Projects the freshest snapshot to now; null when there is none. */
    project(): PlaybackSnapshot | null;

    /** Starts a new connection epoch: drops the revision baseline and state. */
    resetEpoch(): void;
}

/** Builds a projection clock; `now` defaults to the platform monotonic clock. */
export function createProjectionClock(now: () => number = (): number => performance.now()): ProjectionClock {
    let current: PlaybackSnapshot | null = null;
    let receivedAtMs = 0;
    let highestAppliedRevision = -1;

    return {
        apply(snapshot: PlaybackSnapshot): boolean {
            if (snapshot.revision < highestAppliedRevision) {
                return false;
            }

            current = snapshot;
            receivedAtMs = now();
            highestAppliedRevision = snapshot.revision;
            return true;
        },

        project(): PlaybackSnapshot | null {
            if (current === null) {
                return null;
            }

            const elapsedSeconds = current.playing
                ? Math.max(0, now() - receivedAtMs) / 1000
                : 0;

            return { ...current, position: current.position + elapsedSeconds };
        },

        resetEpoch(): void {
            current = null;
            highestAppliedRevision = -1;
        },
    };
}
