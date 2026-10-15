import { Rooms, logger } from './index.js';
import { ServerEvents } from './shared/index.js';
import { ServerSocket } from './types.js';
import { User } from './User.js';

const bannedIps = new Set<string>();

const activeUsernames = new Set<string>();

export function addBannedIp(ip: string): void {
    bannedIps.add(ip);
}

export async function validateConnection(socket: ServerSocket): Promise<void> {
    const ip = socket.handshake.address;

    if (bannedIps.has(ip)) {
        socket.disconnect();
        return;
    }

    if (Rooms.WaitingRoom.hasIp(ip)) {
        socket.emit(
            ServerEvents.Connection.Rejected,
            'Already in waiting room',
        );
        socket.disconnect();
        return;
    }

    const rawUsername: unknown = socket.handshake.auth['username'];

    if (typeof rawUsername !== 'string') {
        socket.emit(ServerEvents.Connection.Rejected, 'Username not supplied');
        socket.disconnect();
        return;
    }

    const username = rawUsername.trim();

    if (!/^(\w|\s){2,24}$/.test(username)) {
        socket.emit(ServerEvents.Connection.Rejected, 'Username invalid');
        socket.disconnect();
        return;
    }

    const usernameLower = username.toLowerCase();

    if (activeUsernames.has(usernameLower)) {
        socket.emit(ServerEvents.Connection.Rejected, 'Username taken');
        socket.disconnect();
        return;
    }

    activeUsernames.add(usernameLower);

    // Connection-scoped cleanup. Rooms remove only their own listeners, so
    // username release must live OUTSIDE room membership: it survives room
    // transitions (approval) and still fires if a user ends up seated in no
    // room at all (e.g. a failed admission rollback).
    socket.on('disconnect', () => {
        activeUsernames.delete(usernameLower);
    });

    const isAdmin = Rooms.Admins.isEmpty();

    const user = new User(socket, username, isAdmin);

    socket.emit(ServerEvents.Connection.Accepted, isAdmin);

    if (isAdmin) {
        await Rooms.Admins.add(user);
        await Rooms.Cinema.add(user);
    } else {
        await Rooms.WaitingRoom.add(user);
    }

    logger.logApplicationState();
}
