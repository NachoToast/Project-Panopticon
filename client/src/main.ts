import { io, Socket } from 'socket.io-client';
import settings from '../settings.json';
import { Cinema, EntryCard, Movie, User, WaitingRoom } from './controllers';
import { summarizeEventArgs } from './diagnostics/snapshot';
import { ClientEvents, ServerEvents } from './shared';
import './styles';
import {
    getUsername,
    makeBackgroundCanvas
} from './util';

export const MOVIE_SOURCE = `data/${settings.file}`;

export const MOVIE_TYPE = settings.type;

export const SUBTITLES = settings.subtitles;

export const socket: Socket<ServerEvents.All, ClientEvents.All> = io(
    `ws://${location.host.replace(location.port, '5000')}`,
    { autoConnect: false },
);

/**
 * Initializes the application. Called once by the bootstrap entry after the
 * page has loaded; kept explicit so a dynamic import cannot miss the load
 * event (bootstrap owns that wait).
 */
export async function initApp(): Promise<void> {
    makeBackgroundCanvas();

    Cinema.addListeners();
    EntryCard.addListeners();
    Movie.addListeners();
    User.addListeners();
    WaitingRoom.addListeners();

    socket.onAny((eventName: string, ...args: unknown[]) => {
        // Allowlisted summary only: event name plus argument kinds. Raw
        // payloads (user lists, tokens, URLs) are never logged or persisted.
        console.debug(`%c${eventName}`, 'color: gray', summarizeEventArgs(args));
    });

    EntryCard.show({
        title: 'Project Panopticon',
        description: 'Checking browser compatibility...',
    });

    // Skipped for now since it's kinda unreliable
    // const isCompatible = await doCompatibilityChecks();
    // if (!isCompatible) return;

    const username = await getUsername();

    if (typeof socket.auth === 'function') {
        throw new Error('socket.auth is a function (expected a record)');
    }
    socket.auth = { username };

    socket.connect();
}
