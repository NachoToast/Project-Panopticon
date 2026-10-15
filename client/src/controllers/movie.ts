import { issueStore } from '../diagnostics/issues';
import { IssueCode } from '../diagnostics/snapshot';
import { MOVIE_MEDIA_ID, MOVIE_SOURCE, MOVIE_TYPE, socket, SUBTITLES } from '../main';
import { createProjectionClock } from '../playback/clock';
import {
    ClientEvents,
    isCommandRejection,
    isPlaybackSnapshot,
    PlaybackSnapshot,
    ServerEvents,
} from '../shared';
import { getElement, safeStorage } from '../util';

const element = getElement('#movie', HTMLVideoElement);

const LOCAL_STORAGE_KEY = 'volume';
const DEFAULT_VOLUME = 0.15; // 100% is always crazy loud

/**
 * Local projection of server snapshots: advances playing positions between
 * snapshots and drops stale revisions. `resetEpoch` runs on disconnect/
 * reconnect so a restarted server's revision counter cannot be mistaken
 * for stale data. Task 6 wires the full reconciliation loop.
 */
const projection = createProjectionClock();

let isAdmin = false;
let lastSeenPlaying = false;
let lastSeenTime = 0;

function update(): void {
    if (lastSeenPlaying) {
        if (element.paused) void element.play();
    } else if (!element.paused) {
        element.pause();
    }

    if (Math.abs(element.currentTime - lastSeenTime) > 5) {
        element.currentTime = lastSeenTime;
    }
}

/**
 * Applies one server playback snapshot (join list, admin action, or state
 * broadcast). Invalid payloads surface as an InvalidServerState issue and
 * are ignored; stale revisions (this connection epoch) are dropped by the
 * projection clock. A mediaId mismatch reports MediaMismatch but still
 * applies the update — Task 6 owns the hardened response.
 */
function applySnapshot(snapshot: PlaybackSnapshot): void {
    if (!isPlaybackSnapshot(snapshot)) {
        issueStore.reportIssue({ code: IssueCode.InvalidServerState });
        return;
    }

    if (!projection.apply(snapshot)) {
        return;
    }

    // apply() returning true guarantees the clock holds this snapshot, so
    // project() cannot return null; ?? only satisfies the compiler.
    const projected = projection.project() ?? snapshot;
    lastSeenPlaying = projected.playing;
    lastSeenTime = projected.position;

    if (
        MOVIE_MEDIA_ID !== null &&
        snapshot.mediaId !== null &&
        snapshot.mediaId !== MOVIE_MEDIA_ID
    ) {
        issueStore.reportIssue({ code: IssueCode.MediaMismatch });
    }

    update();
}

export function addListeners(): void {
    socket.on(ServerEvents.Connection.Accepted, (admin) => {
        isAdmin = admin;
    });

    socket.on(ServerEvents.Cinema.Users, (_, snapshot) => {
        setHidden(false);

        const source = document.createElement('source');
        source.type = MOVIE_TYPE;
        source.src = MOVIE_SOURCE;

        element.volume = getStoredVolume();
        element.appendChild(source);

        for (const subtitle of SUBTITLES) {
            const track = document.createElement('track');
            track.kind = 'subtitles';

            track.label = subtitle.label;
            track.srclang = subtitle.srclang;
            track.src = `data/${subtitle.file}`;

            element.appendChild(track);
        }

        const firstTrack = element.querySelectorAll('track')[0];

        if (firstTrack) {
            firstTrack.default = true;
        }

        // The host announces its media here rather than on
        // Connection.Accepted: the server attaches its select listener in
        // the same synchronous join block that emits this event, so the
        // announcement cannot race a not-yet-attached listener (Accepted
        // precedes the room join). Re-announcing on reconnect is safe — a
        // same-media select is a server-side no-op.
        if (isAdmin && MOVIE_MEDIA_ID !== null) {
            socket.emit(ClientEvents.Cinema.Select, MOVIE_MEDIA_ID);
        }

        applySnapshot(snapshot);
    });

    socket.on(ServerEvents.Cinema.Playing, (_, snapshot) => {
        applySnapshot(snapshot);
    });

    socket.on(ServerEvents.Cinema.Paused, (_, snapshot) => {
        applySnapshot(snapshot);
    });

    socket.on(ServerEvents.Cinema.Seeked, (_, snapshot) => {
        applySnapshot(snapshot);
    });

    socket.on(ServerEvents.Cinema.State, (snapshot) => {
        applySnapshot(snapshot);
    });

    socket.on(ServerEvents.Cinema.CommandRejected, (rejection) => {
        // Minimal wiring: rejections (and garbage where a rejection should
        // be) surface as InvalidServerState; the full UX lands in PR 2.
        if (!isCommandRejection(rejection)) {
            issueStore.reportIssue({ code: IssueCode.InvalidServerState });
            return;
        }

        issueStore.reportIssue({ code: IssueCode.InvalidServerState, detail: rejection });
    });

    socket.on('connect', () => {
        // New connection epoch: the server may have restarted, restarting
        // its revision counter, so drop the stale-snapshot baseline.
        projection.resetEpoch();
    });

    socket.on('disconnect', () => {
        element.controls = false;
        isAdmin = false;
        setHidden(true);

        projection.resetEpoch();
        lastSeenPlaying = false;
        lastSeenTime = 0;
    });
}

function setHidden(hidden: boolean): void {
    element.hidden = hidden;
}

function emitCommand(event: ClientEvents.Cinema, position: number): void {
    if (MOVIE_MEDIA_ID === null) {
        // Unusable settings mean no media identity to command with, so the
        // local update is the whole effect; report why nothing syncs.
        issueStore.reportIssue({ code: IssueCode.InvalidConfiguration });
        update();
        return;
    }

    socket.emit(event, { mediaId: MOVIE_MEDIA_ID, position });
}

element.onplay = (): void => {
    if (isAdmin) {
        emitCommand(ClientEvents.Cinema.Play, element.currentTime);
    } else {
        update();
    }
};

element.onpause = (): void => {
    if (isAdmin) {
        emitCommand(ClientEvents.Cinema.Pause, element.currentTime);
    } else {
        update();
    }
};

element.onseeked = (): void => {
    if (isAdmin) {
        emitCommand(ClientEvents.Cinema.Seek, element.currentTime);
    } else {
        update();
    }
};

/** Returns the user's saved volume, or the default if none is saved. */
function getStoredVolume(): number {
    return safeStorage.readStoredNumber(LOCAL_STORAGE_KEY, {
        fallback: DEFAULT_VOLUME,
        minimum: 0,
        maximum: 1,
    });
}

/**
 * Persists the native element volume whenever the user changes it. Native
 * audio only: element.volume is the single volume pathway, and persistence
 * failures are contained by the storage wrapper.
 */
function persistVolume(): void {
    safeStorage.writeStoredString(LOCAL_STORAGE_KEY, String(element.volume));
}

element.onvolumechange = persistVolume;
