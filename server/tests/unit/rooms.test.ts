import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoomsRegistry } from '../../src/rooms.js';
import { User } from '../../src/User.js';
import { createTestRooms } from '../helpers/testApp.js';

// Room membership semantics: idempotent adds, no-op removes for
// non-members, OWNED listener cleanup (never removeAllListeners), rollback
// when socket.join() fails, and admin approve targeting.

/** A stand-in socket with real EventEmitter listener semantics. */
class FakeSocket extends EventEmitter {
    public readonly id: string;

    public readonly handshake: { address: string; auth: Record<string, unknown> };

    public readonly broadcasts: [room: string, event: string][];

    public readonly emitted: string[];

    public readonly joins: string[];

    public readonly leaves: string[];

    /** Controls what socket.join() does; replace per-test. */
    public readonly joinBehavior: (room: string) => Promise<void>;

    public constructor(
        id: string,
        address = '127.0.0.1',
        joinBehavior: (room: string) => Promise<void> = (): Promise<void> =>
            Promise.resolve(),
    ) {
        super();
        this.id = id;
        this.handshake = { address, auth: {} };
        this.joinBehavior = joinBehavior;
        this.broadcasts = [];
        this.emitted = [];
        this.joins = [];
        this.leaves = [];
    }

    public get broadcast(): {
        to: (room: string) => { emit: (event: string, ...args: unknown[]) => void };
    } {
        return {
            to: (room: string) => ({
                emit: (event: string): void => {
                    this.broadcasts.push([room, event]);
                },
            }),
        };
    }

    public async join(room: string): Promise<void> {
        this.joins.push(room);
        await this.joinBehavior(room);
    }

    public leave(room: string): void {
        this.leaves.push(room);
    }

    public override emit(event: string, ...args: unknown[]): boolean {
        this.emitted.push(event);
        return super.emit(event, ...args);
    }

    public listenersAny(): unknown[] {
        return [];
    }
}

/** Flushes pending microtasks (async event handlers) before asserting. */
function flush(): Promise<void> {
    return new Promise<void>((resolve): void => {
        setImmediate(resolve);
    });
}

interface FakeUser {
    readonly user: User;
    readonly socket: FakeSocket;
}

function makeUser(
    username: string,
    isAdmin = false,
    joinBehavior?: (room: string) => Promise<void>,
    address = '127.0.0.1',
): FakeUser {
    const socket =
        joinBehavior === undefined
            ? new FakeSocket(username, address)
            : new FakeSocket(username, address, joinBehavior);
    return { user: new User(socket as never, username, isAdmin), socket };
}

/** Events a fake socket currently has any listeners for. */
function listenerCount(socket: FakeSocket, event: string): number {
    return socket.listeners(event).length;
}

describe('Room membership semantics', (): void => {
    let rooms: RoomsRegistry;

    beforeEach((): void => {
        rooms = createTestRooms().rooms;
    });

    it('adding the same user twice registers one member and one disconnect listener', async (): Promise<void> => {
        const { user, socket } = makeUser('alice');

        await rooms.Cinema.add(user);
        await rooms.Cinema.add(user); // duplicate — must be a no-op

        expect(listenerCount(socket, 'disconnect')).toBe(1);
        expect(rooms.Cinema.tryGetUser(user.toBasic())).toBe(user);
        expect(
            rooms.Cinema.getUserList().filter((entry) => entry.id === socket.id),
        ).toHaveLength(1);
    });

    it('removing a user that never joined is a no-op', async (): Promise<void> => {
        const { user, socket } = makeUser('bob');
        const keeper = vi.fn();
        socket.on('disconnect', keeper);

        await rooms.Cinema.remove(user);

        expect(listenerCount(socket, 'disconnect')).toBe(1); // keeper untouched
        expect(rooms.Cinema.tryGetUser(user.toBasic())).toBeUndefined();
        expect(socket.broadcasts).toEqual([]); // no cinema:left announcement
        expect(socket.leaves).toEqual([]); // no room leave attempted
    });

    it('room cleanup removes only the listeners that room owns', async (): Promise<void> => {
        const { user, socket } = makeUser('host', true);

        await rooms.Admins.add(user);
        await rooms.Cinema.add(user);

        // A stand-in for framework-registered listeners (socket.io reserved
        // events / other subsystems) that no room may ever strip.
        const frameworkListener = vi.fn();
        socket.on('disconnecting', frameworkListener);

        const cinemaPlayBefore = listenerCount(socket, 'cinema:play');
        const cinemaDisconnectBefore = listenerCount(socket, 'disconnect');
        expect(cinemaPlayBefore).toBe(1); // cinema registered exactly one
        expect(cinemaDisconnectBefore).toBe(2); // one per room

        await rooms.Admins.remove(user);

        // Admins' own handlers are gone...
        expect(listenerCount(socket, 'admin:kick')).toBe(0);
        expect(listenerCount(socket, 'admin:ban')).toBe(0);
        expect(listenerCount(socket, 'admin:approve')).toBe(0);
        // ...but cinema's handlers, cinema's disconnect hook, and the
        // framework listener all survive.
        expect(listenerCount(socket, 'cinema:play')).toBe(cinemaPlayBefore);
        expect(listenerCount(socket, 'cinema:select')).toBe(1);
        expect(listenerCount(socket, 'disconnect')).toBe(cinemaDisconnectBefore - 1);
        expect(listenerCount(socket, 'disconnecting')).toBe(1);
    });

    it('a failed socket.join() rolls back partial membership', async (): Promise<void> => {
        const { user, socket } = makeUser(
            'carol',
            false,
            (): Promise<void> => Promise.reject(new Error('adapter unavailable')),
        );

        await expect(rooms.Cinema.add(user)).rejects.toThrow('adapter unavailable');

        expect(rooms.Cinema.tryGetUser(user.toBasic())).toBeUndefined();
        expect(listenerCount(socket, 'disconnect')).toBe(0);
        // The joined announcement is compensated by a left announcement so
        // other members' view stays consistent.
        const events = socket.broadcasts.map(([, event]) => event);
        expect(events).toContain('cinema:left');
    });

    it('releases the seat when the host fails to join, so a host can be re-elected', async (): Promise<void> => {
        const broken = makeUser(
            'broken-host',
            false,
            (): Promise<void> => Promise.reject(new Error('adapter unavailable')),
        );

        await expect(rooms.Admins.add(broken.user)).rejects.toThrow();
        expect(rooms.Admins.isEmpty()).toBe(true);

        const replacement = makeUser('replacement-host', true);
        await rooms.Admins.add(replacement.user);
        expect(rooms.Admins.isEmpty()).toBe(false);
    });
});

describe('Admin approve targeting', (): void => {
    let rooms: RoomsRegistry;
    let host: FakeUser;
    let waiter: FakeUser;

    beforeEach(async (): Promise<void> => {
        rooms = createTestRooms().rooms;
        host = makeUser('host', true);
        waiter = makeUser('waiter');

        await rooms.Admins.add(host.user);
        await rooms.Cinema.add(host.user);
        await rooms.WaitingRoom.add(waiter.user);
    });

    it('admits a waiting user to the cinema exactly once', async (): Promise<void> => {
        host.socket.emit('admin:approve', waiter.user.toBasic());
        host.socket.emit('admin:approve', waiter.user.toBasic()); // double click
        await flush();
        await flush();

        expect(
            rooms.Cinema.getUserList().filter((entry) => entry.id === waiter.socket.id),
        ).toHaveLength(1);
        expect(rooms.Cinema.tryGetUser(waiter.user.toBasic())).toBe(waiter.user);
        expect(
            rooms.WaitingRoom.tryGetUser(waiter.user.toBasic()),
        ).toBeUndefined();
    });

    it('ignores approval of a user who is not in the waiting room', async (): Promise<void> => {
        host.socket.emit('admin:approve', host.user.toBasic()); // host is in the cinema
        await flush();
        await flush();

        // Host membership and active handlers are untouched.
        expect(
            rooms.Cinema.getUserList().filter((entry) => entry.id === host.socket.id),
        ).toHaveLength(1);
        expect(listenerCount(host.socket, 'admin:kick')).toBe(1);
        expect(listenerCount(host.socket, 'admin:approve')).toBe(1);
        expect(listenerCount(host.socket, 'cinema:play')).toBe(1);
        expect(
            rooms.WaitingRoom.tryGetUser(host.user.toBasic()),
        ).toBeUndefined();
    });

    it('broadcasts the approval to the other admins', async (): Promise<void> => {
        host.socket.emit('admin:approve', waiter.user.toBasic());
        await flush();
        await flush();

        expect(host.socket.broadcasts).toContainEqual([
            'admins',
            'admin:approved',
        ]);
    });
});

describe('async listener failure containment', (): void => {
    it('routes a rejected re-seat join to the logger, not the process', async (): Promise<void> => {
        const { rooms, lines } = createTestRooms();
        const host = makeUser('host', true);

        // The waiter's joins: the initial waiting-room seating succeeds,
        // the cinema join fails (approve failure), and the re-seat join
        // back into the waiting room fails too.
        let waitingRoomJoins = 0;
        const { user: waiter } = makeUser(
            'waiter',
            false,
            (room: string): Promise<void> => {
                if (room !== 'waiting-room') {
                    return Promise.reject(
                        new Error('cinema adapter unavailable'),
                    );
                }
                waitingRoomJoins += 1;
                return waitingRoomJoins === 1
                    ? Promise.resolve()
                    : Promise.reject(new Error('re-seat adapter unavailable'));
            },
        );

        await rooms.Admins.add(host.user);
        await rooms.WaitingRoom.add(waiter);

        const unhandled: unknown[] = [];
        const onUnhandledRejection = (reason: unknown): void => {
            unhandled.push(reason);
        };
        process.on('unhandledRejection', onUnhandledRejection);
        try {
            host.socket.emit('admin:approve', waiter.toBasic());
            await flush();
            await flush();
            await flush();
        } finally {
            process.off('unhandledRejection', onUnhandledRejection);
        }

        // Both failures land in the logger...
        expect(lines.join('')).toContain('cinema admission failed');
        expect(lines.join('')).toContain('admin:approve');
        // ...and the re-seat rejection never escapes as an
        // unhandledRejection (process death on Node >= 15).
        expect(unhandled).toEqual([]);
    });
});

describe('WaitingRoom', (): void => {
    it('tracks the ips of current members only', async (): Promise<void> => {
        const rooms = createTestRooms().rooms;
        const { user, socket } = makeUser('dave');

        expect(rooms.WaitingRoom.hasIp(socket.handshake.address)).toBe(false);

        await rooms.WaitingRoom.add(user);
        expect(rooms.WaitingRoom.hasIp(socket.handshake.address)).toBe(true);

        await rooms.WaitingRoom.remove(user);
        expect(rooms.WaitingRoom.hasIp(socket.handshake.address)).toBe(false);
    });

    it('keeps an ip claimed while any same-ip member is still seated', async (): Promise<void> => {
        const rooms = createTestRooms().rooms;
        const ip = '10.9.8.7';
        const first = makeUser('first', false, undefined, ip);
        const second = makeUser('second', false, undefined, ip);

        await rooms.WaitingRoom.add(first.user);
        await rooms.WaitingRoom.add(second.user);

        // Approve-failure re-seat window: `first` is removed (about to
        // be re-seated) while `second` — same ip — is still seated. The
        // ip must stay claimed so admission still rejects a third
        // same-ip connection.
        await rooms.WaitingRoom.remove(first.user);
        expect(rooms.WaitingRoom.hasIp(ip)).toBe(true);

        await rooms.WaitingRoom.remove(second.user);
        expect(rooms.WaitingRoom.hasIp(ip)).toBe(false);
    });
});

describe('logging through room operations', (): void => {
    it('renders room state through the injected logger on disconnect', async (): Promise<void> => {
        const { rooms, lines } = createTestRooms();
        const { user, socket } = makeUser('logger-user');

        await rooms.Cinema.add(user);
        socket.emit('disconnect');
        await flush();

        const output = lines.join('');
        expect(output).toContain('Cinema(0)');
    });
});
