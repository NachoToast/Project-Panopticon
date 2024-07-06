import { MOVIE_SOURCE, MOVIE_TYPE, socket } from '../main';
import { ClientEvents, ServerEvents } from '../shared';
import { getElement } from '../util';

const element = getElement<HTMLVideoElement>('#movie');

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

        element.setAttribute('type', MOVIE_TYPE);
        element.src = MOVIE_SOURCE;

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
