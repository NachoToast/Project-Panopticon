import { io, Socket } from 'socket.io-client';
import settings from '../settings.json';
import { Cinema, EntryCard, Movie, User, WaitingRoom } from './controllers';
import { ClientEvents, ServerEvents } from './shared';
import './styles';
import {
    doCompatibilityChecks,
    getUsername,
    makeBackgroundCanvas,
} from './util';

export const MOVIE_SOURCE = `data/${settings.file}`;

export const MOVIE_TYPE = settings.type;

export const SUBTITLES = settings.subtitles;

export const socket: Socket<ServerEvents.All, ClientEvents.All> = io(
    `ws://${location.host.replace(location.port, '5000')}`,
    { autoConnect: false },
);

async function handleLoad(): Promise<void> {
    makeBackgroundCanvas();

    Cinema.addListeners();
    EntryCard.addListeners();
    Movie.addListeners();
    User.addListeners();
    WaitingRoom.addListeners();

    socket.onAny((eventName: string, ...args: unknown[]) => {
        console.log(`%c${eventName}`, 'color: gray', ...args);
    });

    EntryCard.show({
        title: 'Project Panopticon',
        description: 'Checking browser compatibility...',
    });

    const isCompatible = await doCompatibilityChecks();
    if (!isCompatible) return;

    const username = await getUsername();

    if (typeof socket.auth === 'function') {
        throw new Error('socket.auth is a function (expected a record)');
    }
    socket.auth = { username };

    socket.connect();
}

window.addEventListener('load', () => void handleLoad(), { once: true });
