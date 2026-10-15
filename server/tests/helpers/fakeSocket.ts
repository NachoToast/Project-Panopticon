import { EventEmitter } from 'node:events';

/**
 * A stand-in server socket with real EventEmitter listener semantics.
 *
 * Used for admission-level tests that need to control socket timing (slow
 * or failing joins, concurrent first connections) — impossible to force
 * with real sockets.
 */
export class FakeSocket extends EventEmitter {
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
