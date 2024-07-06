import { createServer } from 'http';
import { Server } from 'socket.io';
import { Admins, Cinema, WaitingRoom } from './Rooms/index.js';
import { ClientEvents, ServerEvents } from './shared/index.js';
import { validateConnection } from './validation.js';

const PORT = process.env['PORT'] ?? 5_000;

const server = createServer();

const io = new Server<ClientEvents.All, ServerEvents.All>(server, {
    cors: { origin: '*' },
});

export const Rooms = {
    Admins: new Admins(),
    Cinema: new Cinema(),
    WaitingRoom: new WaitingRoom(),
};

let lastApplicationState = '';

export function logApplicationState(): void {
    const newState = [
        Rooms.Admins.toString(),
        Rooms.Cinema.toString(),
        Rooms.WaitingRoom.toString(),
    ].join('\n');

    if (lastApplicationState === newState) return;

    lastApplicationState = newState;

    process.stdout.moveCursor(0, -4);
    process.stdout.clearScreenDown();

    console.log(`=== [${new Date().toLocaleTimeString('en-NZ')}] ===`);
    console.log(lastApplicationState);
}

io.on('connection', async (socket) => {
    await validateConnection(socket);
});

server.listen(PORT, () => {
    console.log(`Running on http://localhost:${PORT.toString()}`);
});
