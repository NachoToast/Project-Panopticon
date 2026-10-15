import { createServer } from 'http';
import { Server } from 'socket.io';
import { createLogger } from './logging.js';
import { createRooms, type RoomsRegistry } from './rooms.js';
import { ClientEvents, ServerEvents } from './shared/index.js';
import { addBannedIp, validateConnection } from './validation.js';

// Transitional wiring: the application factory (src/app.ts) replaces this
// composition in a follow-up commit; until then index.ts still owns startup
// AND composition, but through the room factory rather than module-level
// room singletons with imports reaching back into this file.

const PORT = process.env['PORT'] ?? 5_000;

const server = createServer();

const io = new Server<ClientEvents.All, ServerEvents.All>(server, {
    cors: { origin: '*' },
});

function renderRooms(rooms: RoomsRegistry): string {
    return [rooms.Admins, rooms.Cinema, rooms.WaitingRoom]
        .map((room) => room.toString())
        .join('\n');
}

const logger = createLogger(process.stdout, {
    renderState: (): string => renderRooms(Rooms),
});

export const Rooms = createRooms({ logger, access: { banIp: addBannedIp } });

export { logger };

io.on('connection', async (socket) => {
    await validateConnection(socket);
});

server.listen(PORT, () => {
    console.log(`Running on http://localhost:${PORT.toString()}`);
});
