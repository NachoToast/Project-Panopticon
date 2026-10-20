import { io, Socket } from 'socket.io-client';
import { readSocketOverride, resolveSocketUrl, settingsProblem } from './config';
import { Cinema, EntryCard, Movie, User, WaitingRoom } from './controllers';
import { issueStore } from './diagnostics/issues';
import { IssueCode, summarizeEventArgs } from './diagnostics/snapshot';
import { ClientEvents, ServerEvents } from './shared';
import './styles';
import {
    getUsername,
    makeBackgroundCanvas
} from './util';

// Re-exported for the controllers that import them from here, the
// derivation lives in config.ts.
export { MOVIE_MEDIA_ID, MOVIE_SOURCE, MOVIE_TYPE, SUBTITLES } from './config';

export const socket: Socket<ServerEvents.All, ClientEvents.All> = io(
    resolveSocketUrl(location, readSocketOverride(location.search)),
    { autoConnect: false },
);

/**
 * Initializes the application, called once by the bootstrap entry after the
 * page has loaded. Kept explicit so a dynamic import cannot miss the load
 * event, bootstrap owns that wait.
 */
export async function initApp(): Promise<void> {
    if (settingsProblem !== null) {
        // Reported here rather than at module scope so issue listeners
        // exist already, and the entry card still works.
        console.debug('[panopticon] invalid settings.json:', settingsProblem);
        issueStore.reportIssue({ code: IssueCode.InvalidConfiguration });
    }

    makeBackgroundCanvas();

    Cinema.addListeners();
    EntryCard.addListeners();
    Movie.addListeners();
    User.addListeners();
    WaitingRoom.addListeners();

    socket.onAny((eventName: string, ...args: unknown[]) => {
        // Allowlisted summary only, raw payloads stay out of the log.
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
