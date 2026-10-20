import type { Server as HttpServer } from 'node:http';
import type { Socket as ClientSocket } from 'socket.io-client';
import { io } from 'socket.io-client';
import { createApplication } from '../../src/app.js';
import { createLogger, type Logger } from '../../src/logging.js';
import { createRooms, type RoomsRegistry } from '../../src/rooms.js';

/**
 * Server test wiring.
 *
 * Domain modules (Rooms/*) no longer import src/index.ts, so tests can
 * construct real room registries directly, no vi.mock of the entry point,
 * no listening server started by importing domain code. Integration tests
 * build full applications through createApplication (src/app.ts).
 */

export interface RecordingLogger {
    readonly logger: Logger;
    readonly lines: string[];
}

/** A logger writing into an in-memory pipe (exercises the non-TTY path). */
export function createRecordingLogger(
    renderState: () => string,
): RecordingLogger {
    const lines: string[] = [];
    const stream: Record<string, unknown> = {
        write: (chunk: string): boolean => {
            lines.push(chunk);
            return true;
        },
    };
    // Bracket assignment: `isTTY` is the stream API's own (non-camelCase) name.
    stream['isTTY'] = false;

    const logger = createLogger(stream as unknown as NodeJS.WriteStream, {
        renderState,
    });

    return { logger, lines };
}

export interface TestRooms {
    readonly rooms: RoomsRegistry;
    /** Everything the injected logger has written. */
    readonly lines: string[];
}

/** A room registry wired with a recording logger and inert access control. */
export function createTestRooms(): TestRooms {
    // Holder object so the state renderer can see the registry being built
    // (the same composition shape the application factory uses).
    const state: { rooms?: RoomsRegistry } = {};

    const { logger, lines } = createRecordingLogger((): string => {
        const rooms = state.rooms;
        if (rooms === undefined) return '';
        return [rooms.Admins, rooms.Cinema, rooms.WaitingRoom]
            .map((room) => room.toString())
            .join('\n');
    });

    state.rooms = createRooms({
        logger,
        access: { banIp: (): void => undefined },
    });

    return { rooms: state.rooms, lines };
}

// ---------------------------------------------------------------------------
// Integration harness: real Socket.IO clients against createApplication().
// ---------------------------------------------------------------------------

/** Client sockets created via this module, disconnected by closeTestApps(). */
const clients = new Set<ClientSocket>();

/** Started test applications, closed by closeTestApps(). */
const apps = new Set<{ close: () => Promise<void> }>();

export interface StartedApp {
    readonly url: string;
    readonly rooms: RoomsRegistry;
    readonly lines: string[];
    readonly httpServer: HttpServer;
}

/** Creates an in-process application on an ephemeral port. */
export async function startTestApp(): Promise<StartedApp> {
    const lines: string[] = [];
    const stream: Record<string, unknown> = {
        write: (chunk: string): boolean => {
            lines.push(chunk);
            return true;
        },
    };
    stream['isTTY'] = false;

    const app = createApplication({
        output: stream as unknown as NodeJS.WriteStream,
    });
    apps.add(app);

    const port = await new Promise<number>((resolve, reject): void => {
        app.httpServer.once('error', reject);
        app.httpServer.listen(0, (): void => {
            const address = app.httpServer.address();
            if (address === null || typeof address === 'string') {
                reject(new Error('expected a tcp address'));
                return;
            }
            resolve(address.port);
        });
    });

    return {
        url: `http://127.0.0.1:${String(port)}`,
        rooms: app.rooms,
        lines,
        httpServer: app.httpServer,
    };
}

/** Connects a real client with a username, tracked for teardown. */
export function connect(url: string, username: string): ClientSocket {
    const socket = io(url, {
        autoConnect: false,
        auth: { username },
        reconnection: false,
    });
    clients.add(socket);
    return socket;
}

/** Resolves with the next payload(s) for `event`, failing on timeout. */
export function nextEvent(
    socket: ClientSocket,
    event: string,
    timeoutMs = 2_000,
): Promise<unknown[]> {
    return new Promise<unknown[]>((resolve, reject): void => {
        const onEvent = (...args: unknown[]): void => {
            clearTimeout(timer);
            resolve(args);
        };
        const timer = setTimeout((): void => {
            socket.off(event, onEvent);
            reject(new Error(`timed out waiting for "${event}"`));
        }, timeoutMs);
        socket.once(event, onEvent);
    });
}

/** Resolves once the socket's next connect_error fires. */
export function nextConnectError(
    socket: ClientSocket,
    timeoutMs = 2_000,
): Promise<Error> {
    return new Promise<Error>((resolve, reject): void => {
        const timer = setTimeout((): void => {
            reject(new Error('timed out waiting for connect_error'));
        }, timeoutMs);
        socket.once('connect_error', (error: Error): void => {
            clearTimeout(timer);
            resolve(error);
        });
    });
}

/** Resolves once the socket disconnects. */
export function nextDisconnect(
    socket: ClientSocket,
    timeoutMs = 2_000,
): Promise<void> {
    return new Promise<void>((resolve, reject): void => {
        const timer = setTimeout((): void => {
            reject(new Error('timed out waiting for disconnect'));
        }, timeoutMs);
        socket.once('disconnect', (): void => {
            clearTimeout(timer);
            resolve();
        });
    });
}

/** Tears down every tracked client and application (afterEach safety net). */
export async function closeTestApps(): Promise<void> {
    for (const socket of clients) {
        socket.disconnect();
    }
    clients.clear();

    await Promise.all(Array.from(apps, (app): Promise<void> => app.close()));
    apps.clear();
}
