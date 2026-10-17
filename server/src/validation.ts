import type { Logger } from './logging.js';
import type { AccessControl, RoomsRegistry } from './rooms.js';
import { ServerEvents } from './shared/index.js';
import { ServerSocket } from './types.js';
import { User } from './User.js';

/**
 * Per-application admission state: banned ips and active usernames (owned
 * by a createApplication() instance, never shared across servers/tests).
 */
export class AdmissionState implements AccessControl {
    private readonly bannedIps = new Set<string>();

    private readonly activeUsernames = new Set<string>();

    public isBanned(ip: string): boolean {
        return this.bannedIps.has(ip);
    }

    public banIp(ip: string): void {
        this.bannedIps.add(ip);
    }

    public isUsernameActive(usernameLower: string): boolean {
        return this.activeUsernames.has(usernameLower);
    }

    public reserveUsername(usernameLower: string): void {
        this.activeUsernames.add(usernameLower);
    }

    public releaseUsername(usernameLower: string): void {
        this.activeUsernames.delete(usernameLower);
    }
}

export interface AdmissionServices {
    readonly rooms: RoomsRegistry;
    readonly admission: AdmissionState;
    readonly logger: Logger;
}

export async function validateConnection(
    socket: ServerSocket,
    services: AdmissionServices,
): Promise<void> {
    const { rooms, admission, logger } = services;
    const ip = socket.handshake.address;

    if (admission.isBanned(ip)) {
        socket.disconnect();
        return;
    }

    if (rooms.WaitingRoom.hasIp(ip)) {
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

    if (admission.isUsernameActive(usernameLower)) {
        socket.emit(ServerEvents.Connection.Rejected, 'Username taken');
        socket.disconnect();
        return;
    }

    admission.reserveUsername(usernameLower);

    // Connection-scoped cleanup. Rooms remove only their own listeners, so
    // username release must live OUTSIDE room membership: it survives room
    // transitions (approval) and still fires if a user ends up seated in no
    // room at all (e.g. a failed admission rollback).
    socket.on('disconnect', () => {
        admission.releaseUsername(usernameLower);
    });

    // Host reservation: isEmpty() and the synchronous membership claim in
    // Admins.add() run with no await between them, so two concurrent first
    // connections can never both reserve the host seat (locked by test).
    const isAdmin = rooms.Admins.isEmpty();

    const user = new User(socket, username, isAdmin);

    socket.emit(ServerEvents.Connection.Accepted, isAdmin);

    try {
        if (isAdmin) {
            await rooms.Admins.add(user);
            await rooms.Cinema.add(user);
        } else {
            await rooms.WaitingRoom.add(user);
        }
    } catch (error) {
        // A failed room join already rolled the membership back; refuse the
        // connection. The disconnect listener above releases the username.
        logger.error('room join failed during admission', username, error);
        socket.emit(ServerEvents.Connection.Rejected, 'Admission failed');
        socket.disconnect();
        return;
    }

    logger.logApplicationState();
}
