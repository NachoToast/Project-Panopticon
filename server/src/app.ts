import { createServer, type Server as HttpServer } from 'node:http';
import { Server as SocketServer } from 'socket.io';
import { createLogger, type Logger } from './logging.js';
import { createRooms, type RoomsRegistry } from './rooms.js';
import type { ClientEvents, ServerEvents } from './shared/index.js';
import type { ServerSocket } from './types.js';
import { AdmissionState, validateConnection } from './validation.js';

/**
 * Application factory: composes the HTTP server, Socket.IO server, room
 * registry, admission state, and logger into one isolated application.
 * Importing has no side effects — src/index.ts decides when to listen, and
 * test instances share no state.
 */

export interface ApplicationOptions {
    /** Output stream for the application logger (defaults to stdout). */
    readonly output?: NodeJS.WriteStream;
}

export interface Application {
    readonly httpServer: HttpServer;
    readonly io: SocketServer<ClientEvents.All, ServerEvents.All>;
    readonly rooms: RoomsRegistry;
    readonly logger: Logger;

    /** Connection admission used by the installed Socket.IO handler. */
    handleConnection(socket: ServerSocket): Promise<void>;

    /** Stops accepting connections and closes the servers. */
    close(): Promise<void>;
}

/** The path prefix engine.io/socket.io serve; left alone by the fallback. */
const SOCKET_IO_PATH = '/socket.io/';

/**
 * Minimal HTTP behavior for non-socket.io requests: readiness on `/`, a
 * bounded 404 otherwise. No room/user state is exposed over HTTP.
 */
function installHttpFallback(server: HttpServer): void {
    server.on('request', (request, response) => {
        const url = request.url ?? '/';

        if (url === '/' || url === '/healthz') {
            response.setHeader('content-type', 'text/plain');
            response.writeHead(200);
            response.end('Project Panopticon');
            return;
        }

        if (url.startsWith(SOCKET_IO_PATH)) {
            // Handled by the Socket.IO server's own request listener.
            return;
        }

        response.setHeader('content-type', 'text/plain');
        response.writeHead(404);
        response.end('Not found');
    });
}

export function createApplication(
    options: ApplicationOptions = {},
): Application {
    const httpServer = createServer();

    // The fallback must be registered before Socket.IO attaches so its own
    // request handling takes over for /socket.io/ paths.
    installHttpFallback(httpServer);

    const io = new SocketServer<ClientEvents.All, ServerEvents.All>(
        httpServer,
        { cors: { origin: '*' } },
    );

    const admission = new AdmissionState();

    // The state renderer closes over the registry built right below it (the
    // same composition shape as the test wiring).
    const state: { rooms?: RoomsRegistry } = {};
    const logger = createLogger(options.output ?? process.stdout, {
        renderState: (): string => {
            const current = state.rooms;
            if (current === undefined) return '';
            return [current.Admins, current.Cinema, current.WaitingRoom]
                .map((room) => room.toString())
                .join('\n');
        },
    });
    const rooms = createRooms({ logger, access: admission });
    state.rooms = rooms;

    async function handleConnection(socket: ServerSocket): Promise<void> {
        await validateConnection(socket, { rooms, admission, logger });
    }

    io.on('connection', (socket) => {
        void handleConnection(socket).catch((error: unknown) => {
            // Admission failures must never become unhandled rejections.
            logger.error('connection admission failed', error);
            socket.disconnect(true);
        });
    });

    return {
        httpServer,
        io,
        rooms,
        logger,
        handleConnection,
        close: async (): Promise<void> => {
            // io.close() already closes the http server it was built with;
            // idle keep-alive connections would stall it, so drop them first.
            if (typeof httpServer.closeIdleConnections === 'function') {
                httpServer.closeIdleConnections();
            }

            await new Promise<void>((resolve, reject): void => {
                // io.close's own promise never rejects and is floating; its
                // errors arrive in this callback instead.
                void io.close((error?: Error): void => {
                    if (error !== undefined) {
                        reject(error);
                        return;
                    }
                    resolve();
                });
            });
        },
    };
}
