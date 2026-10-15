import type { RoomServices } from '../rooms.js';
import { BaseUser } from '../shared/BaseUser.js';
import { ClientEvents } from '../shared/index.js';
import { User } from '../User.js';

/** Names of client-emitted events a room may listen to. */
type ClientEventName = keyof ClientEvents.All & string;

/** A listener this room registered on a member's socket. */
interface OwnedListener {
    readonly event: string;
    readonly listener: (...args: unknown[]) => void;
}

/**
 * A set of users plus the socket wiring each member needs.
 *
 * Membership invariants (Task 5):
 * - `add` is idempotent: adding a current member is a no-op.
 * - `remove` of a non-member is a no-op: no broadcasts, no listener changes.
 * - Rooms own exactly the listeners they register and remove exactly those —
 *   `socket.removeAllListeners()` is FORBIDDEN as cleanup (see below).
 * - A failed `socket.join()` rolls back every partial side effect.
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
        // Idempotent membership: a duplicate add (double approval, racing
        // admins) must never register a second disconnect hook or push a
        // second user-list entry.
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
            // Partial membership must never linger: the seat, this room's
            // listeners, and the join announcement (compensated by onLeave)
            // are all undone before the failure propagates to admission.
            this.unseat(user);
            try {
                void user.socket.leave(this.roomName);
            } catch {
                // Best effort: the adapter already failed once for this
                // socket; the membership state above is what matters.
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
        // socket.io invokes event handlers fire-and-forget: it ignores
        // the returned promise, so a rejection (e.g. a failing re-seat
        // join inside the approve handler) would surface as an
        // unhandledRejection and kill the process on Node >= 15. Every
        // listener therefore runs inside a guard that routes failures to
        // the logger instead. Sync throws become rejections here, which
        // is strictly safer: engine.io would otherwise bubble them up as
        // uncaught exceptions.
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

        user.socket.on(
            event as ClientEventName,
            guarded as unknown as ClientEvents.All[ClientEventName],
        );

        const owned = this.ownedListeners.get(user.id) ?? [];
        owned.push({ event, listener: guarded });
        this.ownedListeners.set(user.id, owned);
    }

    /**
     * Removes membership state and exactly the listeners THIS room
     * registered on the member's socket.
     *
     * Why per-room bookkeeping instead of `socket.removeAllListeners()`
     * (investigated against socket.io 4.7): a server Socket extends Node's
     * EventEmitter, and the framework only EMITS reserved events
     * ('disconnecting'/'disconnect') on it — it never self-subscribes there
     * (engine-level listeners live on the Client's `conn` and are managed by
     * `Client.destroy()`). So removeAllListeners() does not corrupt
     * socket.io internals; what it destroys is every ROOM's handlers on that
     * socket at once. A user seated in several rooms (the host sits in both
     * Admins and Cinema) would lose their other rooms' event handlers and
     * disconnect cleanup — leaking ghost members — and approving an
     * already-admitted user stripped their active handlers mid-session.
     * Recording and removing only what add()/onJoin() registered keeps every
     * room's cleanup independent.
     */
    private unseat(user: User): void {
        // A disconnect may have already removed the member while their
        // admission join was still pending; when that join then fails,
        // the rollback must not strip listeners or broadcast onLeave a
        // second time.
        if (!this.users.has(user.id)) return;

        for (const owned of this.ownedListeners.get(user.id) ?? []) {
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
