import { MOVIE_SOURCE, MOVIE_TYPE, socket, SUBTITLES } from '../main';
import { ClientEvents, ServerEvents } from '../shared';
import { getElement, safeStorage } from '../util';

const element = getElement('#movie', HTMLVideoElement);

const LOCAL_STORAGE_KEY = 'volume';
const DEFAULT_VOLUME = 0.15; // 100% is always crazy loud

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

export function addListeners(): void {
    socket.on(ServerEvents.Connection.Accepted, (admin) => {
        isAdmin = admin;
    });

    socket.on(ServerEvents.Cinema.Users, (_, playing, time) => {
        setHidden(false);

        lastSeenPlaying = playing;
        lastSeenTime = time;

        const source = document.createElement('source');
        source.type = MOVIE_TYPE;
        source.src = MOVIE_SOURCE;

        element.volume = getStoredVolume();
        element.appendChild(source);

        for (const subtitle of SUBTITLES as {
            label: string;
            srclang: string;
            file: string;
        }[]) {
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

        update();
    });

    socket.on(ServerEvents.Cinema.Playing, (_, time) => {
        lastSeenPlaying = true;
        lastSeenTime = time;

        update();
    });

    socket.on(ServerEvents.Cinema.Paused, (_, time) => {
        lastSeenPlaying = false;
        lastSeenTime = time;

        update();
    });

    socket.on(ServerEvents.Cinema.Seeked, (_, time) => {
        lastSeenTime = time;

        update();
    });

    socket.on('disconnect', () => {
        element.controls = false;
        isAdmin = false;
        setHidden(true);

        lastSeenPlaying = false;
        lastSeenTime = 0;
    });
}

function setHidden(hidden: boolean): void {
    element.hidden = hidden;
}

element.onplay = (): void => {
    if (isAdmin) {
        socket.emit(ClientEvents.Cinema.Play, element.currentTime);
    } else {
        update();
    }
};

element.onpause = (): void => {
    if (isAdmin) {
        socket.emit(ClientEvents.Cinema.Pause, element.currentTime);
    } else {
        update();
    }
};

element.onseeked = (): void => {
    if (isAdmin) {
        socket.emit(ClientEvents.Cinema.Seek, element.currentTime);
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
