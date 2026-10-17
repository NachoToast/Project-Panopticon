import { PlaybackSnapshot } from '../shared';

/**
 * Client-side projection of server playback snapshots: a snapshot received
 * at local receipt-time t0 projects as position + (playing ? elapsed : 0),
 * anchored at LOCAL receipt time, so host/viewer clock skew cannot skew
 * playback. Also owns the revision rules: stale snapshots are dropped
 * within an epoch, and `resetEpoch` forgets the baseline (and state) on a
 * fresh connection, since a restarted server may restart revisions at 0.
 * Positions are carried exactly — there is deliberately NO drift threshold.
 */
export interface ProjectionClock {
    /** Ingests a snapshot; false when stale (revision below highest applied). */
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
