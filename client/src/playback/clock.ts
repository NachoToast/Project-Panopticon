import { PlaybackSnapshot } from '../shared';

/**
 * Client projection of server snapshots. A snapshot received at local time
 * t0 projects as position + (playing ? elapsed : 0), anchored at local
 * receipt time so clock skew between host and viewer cannot skew playback.
 * Stale snapshots get dropped within a connection epoch, and resetEpoch
 * forgets the baseline on reconnect since a restarted server may restart
 * revisions at 0. Positions are carried exactly, with no drift threshold.
 */
export interface ProjectionClock {
    /** Ingests a snapshot. False means it was stale and ignored. */
    apply(snapshot: PlaybackSnapshot): boolean;

    /** Projects the freshest snapshot to now. Null when there is none. */
    project(): PlaybackSnapshot | null;

    /** Starts a new connection epoch. */
    resetEpoch(): void;
}

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
