import type { Logger } from './logging.js';
import { ADMINS_ROOM_NAME, Admins } from './Rooms/Admins.js';
import { Cinema } from './Rooms/Cinema.js';
import { WaitingRoom } from './Rooms/WaitingRoom.js';

/**
 * Room registry construction.
 *
 * Domain modules used to import a module-level `Rooms` singleton from
 * src/index.ts — which meant importing ANY room class started a listening
 * server, and all tests had to mock index.ts. Rooms are now created by a
 * factory and receive their collaborators explicitly.
 */

/** Admission/access state a room may touch, implemented by the application. */
export interface AccessControl {
    /** Records an ip as banned (admin ban action). */
    banIp(ip: string): void;
}

/** Everything a room needs beyond its own state. */
export interface RoomServices {
    readonly logger: Logger;
    readonly access: AccessControl;
}

export interface RoomsRegistry {
    readonly Admins: Admins;
    readonly Cinema: Cinema;
    readonly WaitingRoom: WaitingRoom;
}

export interface RoomsOptions {
    /** Time source for the cinema playback clock (tests may fake it). */
    readonly now?: () => number;
}

export function createRooms(
    services: RoomServices,
    options: RoomsOptions = {},
): RoomsRegistry {
    const cinema = new Cinema(services, options.now);
    const waitingRoom = new WaitingRoom(services, ADMINS_ROOM_NAME);
    const admins = new Admins(services, { cinema, waitingRoom });

    return Object.freeze({
        Admins: admins,
        Cinema: cinema,
        WaitingRoom: waitingRoom,
    });
}
