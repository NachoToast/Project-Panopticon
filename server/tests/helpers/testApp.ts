import { createLogger, type Logger } from '../../src/logging.js';
import { createRooms, type RoomsRegistry } from '../../src/rooms.js';

/**
 * Server test wiring.
 *
 * Domain modules (Rooms/*) no longer import src/index.ts, so tests can
 * construct real room registries directly — no vi.mock of the entry point,
 * no listening server started by importing domain code.
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
