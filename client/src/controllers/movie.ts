import { MOVIE_MEDIA_ID, MOVIE_SOURCE, MOVIE_TYPE, SUBTITLES } from '../config';
import { issueStore } from '../diagnostics/issues';
import { socket } from '../main';
import {
    createPlaybackController,
    PlaybackChannel,
    PlaybackController,
    PlaybackElementFactory,
} from '../playback/controller';
import { ClientEvents, ServerEvents } from '../shared';
import { getElement, safeStorage } from '../util';

/**
 * Thin wiring for the movie player: grab the page's element and socket,
 * construct the playback controller with real platform boundaries, and
 * forward the socket events it owns. Every behavior lives in
 * `playback/controller.ts` (constructor-injected, testable in Node).
 */

const element = getElement('#movie', HTMLVideoElement);

const LOCAL_STORAGE_KEY = 'volume';
const DEFAULT_VOLUME = 0.15; // 100% is always crazy loud

/** The cinema command surface, adapted to the typed socket client. */
const channel: PlaybackChannel = {
    sendCommand: (event, command): void => {
        socket.emit(event, command);
    },
    announceMedia: (mediaId): void => {
        socket.emit(ClientEvents.Cinema.Select, mediaId);
    },
};

/** Builds the real <source>/<track> children for a media load. */
const createElement: PlaybackElementFactory = {
    createSource: (src, type): HTMLSourceElement => {
        const source = document.createElement('source');
        source.src = src;
        source.type = type;
        return source;
    },
    createTrack: (label, srclang, src): HTMLTrackElement => {
        const track = document.createElement('track');
        track.kind = 'subtitles';
        track.label = label;
        track.srclang = srclang;
        track.src = src;
        return track;
    },
};

const controller: PlaybackController = createPlaybackController({
    element,
    channel,
    store: issueStore,
    media: {
        source: MOVIE_SOURCE,
        type: MOVIE_TYPE,
        mediaId: MOVIE_MEDIA_ID,
        subtitles: SUBTITLES,
    },
    createElement,
    volume: {
        initial: (): number =>
            safeStorage.readStoredNumber(LOCAL_STORAGE_KEY, {
                fallback: DEFAULT_VOLUME,
                minimum: 0,
                maximum: 1,
            }),
        persist: (volume): void => {
            safeStorage.writeStoredString(LOCAL_STORAGE_KEY, String(volume));
        },
    },
    reloadPage: (): void => {
        location.reload();
    },
});

export function addListeners(): void {
    socket.on(ServerEvents.Connection.Accepted, (admin) => {
        controller.handleAccepted(admin);
    });

    socket.on(ServerEvents.Cinema.Users, (_users, snapshot) => {
        controller.handleAdmission(snapshot);
    });

    socket.on(ServerEvents.Cinema.Playing, (_admin, snapshot) => {
        controller.handleSnapshot('playing', snapshot);
    });

    socket.on(ServerEvents.Cinema.Paused, (_admin, snapshot) => {
        controller.handleSnapshot('paused', snapshot);
    });

    socket.on(ServerEvents.Cinema.Seeked, (_admin, snapshot) => {
        controller.handleSnapshot('seeked', snapshot);
    });

    socket.on(ServerEvents.Cinema.State, (snapshot) => {
        controller.handleSnapshot('state', snapshot);
    });

    socket.on(ServerEvents.Cinema.CommandRejected, (rejection) => {
        controller.handleCommandRejected(rejection);
    });

    socket.on('connect', () => {
        controller.handleConnect();
    });

    socket.on('disconnect', (reason) => {
        controller.handleDisconnect(reason);
    });
}

/** Exposed for the PR 2 UI (issue actions); unused for now. */
export const playback = controller;
