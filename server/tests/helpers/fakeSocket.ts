import { EventEmitter } from 'node:events';
import type { ServerSocket } from '../../src/types.js';

/**
 * The socket surface the server actually touches: room membership
 * (join/leave), listener bookkeeping (on/off), announcements
 * (emit/broadcast), admission (handshake), and connection control
 * (disconnect/id).
 *
 * Real socket.io sockets can never structurally satisfy this interface:
 * their on/off/emit are generically constrained to the wire event maps
 * (no plain-string fallback — see component-emitter's Emitter), and the
 * concrete Socket carries framework members (client, request, rooms…)
 * a test double has no reason to reproduce. The interface instead pins
 * down what the FAKE must provide, so `implements SocketSurface` below
 * is compile-checked against everything the server uses.
 */
export interface SocketSurface {
    readonly id: string;
    readonly handshake: { address: string; auth: Record<string, unknown> };
    readonly broadcast: {
        to(room: string): { emit(event: string, ...args: unknown[]): unknown };
    };
    on(event: string, listener: (...args: unknown[]) => void): unknown;
    off(event: string, listener: (...args: unknown[]) => void): unknown;
    join(room: string): Promise<void> | void;
    leave(room: string): void;
    emit(event: string, ...args: unknown[]): unknown;
    disconnect(close?: boolean): void;
}

/**
 * A stand-in server socket with real EventEmitter listener semantics.
 *
 * Used for admission-level tests that need to control socket timing (slow
 * or failing joins, concurrent first connections) — impossible to force
 * with real sockets.
 */
export class FakeSocket extends EventEmitter implements SocketSurface {
    public readonly id: string;

    public readonly handshake: { address: string; auth: Record<string, unknown> };

    public readonly broadcasts: [room: string, event: string][];

    public readonly emitted: string[];

    public readonly joins: string[];

    public readonly leaves: string[];

    /** Controls what socket.join() does; inject per-test. */
    public readonly joinBehavior: (room: string) => Promise<void>;

    private disconnectCount = 0;

    public constructor(
        id: string,
        options: {
            address?: string;
            auth?: Record<string, unknown>;
            joinBehavior?: (room: string) => Promise<void>;
        } = {},
    ) {
        super();
        this.id = id;
        this.handshake = {
            address: options.address ?? '127.0.0.1',
            auth: options.auth ?? {},
        };
        this.joinBehavior =
            options.joinBehavior ??
            ((): Promise<void> => Promise.resolve());
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

    public get disconnects(): number {
        return this.disconnectCount;
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

    public disconnect(): void {
        this.disconnectCount += 1;
        // Mirror socket.io: disconnecting a socket emits 'disconnect'.
        this.emit('disconnect');
    }

    public listenersAny(): unknown[] {
        return [];
    }
}

/**
 * Widens a FakeSocket to the ServerSocket type User/handleConnection
 * expect.
 *
 * This is the ONE documented cast in the test suite (replacing the old
 * scatter of `as never`, which would have silenced passing literally
 * anything). It is unavoidable for the same reason real sockets cannot
 * satisfy SocketSurface: socket.io's generic event-map signatures admit
 * no structural bridge between the two sides. The `implements
 * SocketSurface` clause on FakeSocket keeps the fake honest about every
 * member the server actually calls.
 */
export function asServerSocket(socket: FakeSocket): ServerSocket {
    return socket as unknown as ServerSocket;
}
