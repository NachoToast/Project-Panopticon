import type { RoomServices } from '../rooms.js';
import { BaseUser } from '../shared/BaseUser.js';
import { ClientEvents } from '../shared/index.js';
import { User } from '../User.js';

/** Names of client-emitted events a room may listen to. */
type ClientEventName = keyof ClientEvents.All & string;

/** A listener this room registered on a member's socket. */
interface OwnedListener {
    readonly event: string;
    readonly listener: (...args: unknown[]) => void | Promise<void>;
}

/**
 * A set of users plus the socket wiring each member needs. Membership
 * invariants: `add`/`remove` of a current/non-member are no-ops; rooms own
 * exactly the listeners they register and remove exactly those (never
 * `socket.removeAllListeners()`); a failed `socket.join()` rolls back every
 * partial side effect.
 */
export abstract class Room {
    public readonly roomName: string;

    protected readonly services: RoomServices;

    private readonly users = new Map<string, User>();

    private readonly userList = new Array<BaseUser>();

    /** Per-member listeners this room registered, for exact cleanup. */
    private readonly ownedListeners = new Map<string, OwnedListener[]>();

    protected constructor(roomName: string, services: RoomServices) {
        this.roomName = roomName;
        this.services = services;
    }

    public isEmpty(): boolean {
        return this.users.size === 0;
    }

    public toString(): string {
        return `${
            this.constructor.name
        }(${this.users.size.toString()}) { ${this.getUserList()
            .map((e) => e.username)
            .join(', ')} }`;
    }

    /** Current members as wire-safe base users, in join order. */
    public getUserList(): BaseUser[] {
        return this.userList;
    }

    public async add(user: User): Promise<void> {
        // Idempotent membership: a duplicate add must never register a
        // second disconnect hook or user-list entry.
        if (this.users.has(user.id)) return;

        this.listen(user, 'disconnect', () => {
            void this.remove(user);
            this.services.logger.logApplicationState();
        });

        this.users.set(user.id, user);
        this.userList.push(user.toBasic());
        this.onJoin(user);

        try {
            await user.socket.join(this.roomName);
        } catch (error) {
            // Partial membership must never linger: undo the seat, this
            // room's listeners, and the join announcement before failing.
            this.unseat(user);
            try {
                void user.socket.leave(this.roomName);
            } catch {
                // Best effort: the membership state above is what matters.
            }
            throw error;
        }
    }

    public async remove(user: User): Promise<void> {
        if (!this.users.has(user.id)) return;

        this.unseat(user);
        await user.socket.leave(this.roomName);
    }

    public tryGetUser(baseUser: BaseUser): User | undefined {
        return this.users.get(baseUser.id);
    }

    protected getIdenticalUsers(ip: string): User[] {
        return Array.from(this.users.values()).filter((user) => user.ip === ip);
    }

    /**
     * Registers a socket listener on behalf of this room and records it for
     * exact removal when membership ends. Listeners may be async (socket.io
     * event handlers run fire-and-forget).
     */
    protected listen<E extends ClientEventName>(
        user: User,
        event: E,
        listener: (
            ...args: Parameters<ClientEvents.All[E]>
        ) => void | Promise<void>,
    ): void;
    protected listen(
        user: User,
        event: 'disconnect',
        listener: (reason?: string) => void | Promise<void>,
    ): void;
    protected listen(
        user: User,
        event: string,
        listener: (...args: never[]) => void | Promise<void>,
    ): void {
        // socket.io invokes handlers fire-and-forget and ignores the
        // returned promise, so a rejection would kill the process as an
        // unhandledRejection on Node >= 15. Route failures to the logger.
        const guarded = async (...args: unknown[]): Promise<void> => {
            try {
                await listener(...(args as never[]));
            } catch (error) {
                this.services.logger.error(
                    `async "${event}" listener rejected`,
                    error,
                );
            }
        };

        user.socket.on(event as ClientEventName, guarded);

        const owned = this.ownedListeners.get(user.id) ?? [];
        owned.push({ event, listener: guarded });
        this.ownedListeners.set(user.id, owned);
    }

    /**
     * Removes membership state and exactly the listeners THIS room
     * registered on the member's socket. Per-room bookkeeping instead of
     * `socket.removeAllListeners()`: the framework self-subscribes on
     * sockets, and a user seated in several rooms (the host sits in both
     * Admins and Cinema) would lose their other rooms' handlers — leaking
     * ghost members.
     */
    private unseat(user: User): void {
        // A disconnect may have already removed the member while their
        // admission join was pending; the rollback must not strip
        // listeners or broadcast onLeave a second time.
        if (!this.users.has(user.id)) return;

        for (const owned of this.ownedListeners.get(user.id) ?? []) {
            // eslint-disable-next-line @typescript-eslint/no-misused-promises -- only the exact stored reference removes the listener
            user.socket.off(owned.event, owned.listener);
        }
        this.ownedListeners.delete(user.id);

        this.users.delete(user.id);
        const index = this.userList.findIndex((entry) => entry.id === user.id);
        if (index !== -1) {
            this.userList.splice(index, 1);
        }

        this.onLeave(user);
    }

    protected abstract onJoin(user: User): void;

    protected abstract onLeave(user: User): void;
}
