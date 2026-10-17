import type { RoomServices } from '../rooms.js';
import { BaseUser } from '../shared/BaseUser.js';
import { ClientEvents, ServerEvents } from '../shared/index.js';
import { User } from '../User.js';
import type { Cinema } from './Cinema.js';
import { Room } from './Room.js';
import type { WaitingRoom } from './WaitingRoom.js';

export const ADMINS_ROOM_NAME = 'admins';

/** The sibling rooms admin actions target. */
export interface AdminPeers {
    readonly cinema: Cinema;
    readonly waitingRoom: WaitingRoom;
}

export class Admins extends Room {
    private readonly peers: AdminPeers;

    public constructor(services: RoomServices, peers: AdminPeers) {
        super(ADMINS_ROOM_NAME, services);
        this.peers = peers;
    }

    protected override onJoin(user: User): void {
        user.socket.broadcast
            .to(this.roomName)
            .emit(ServerEvents.Admin.Added, user.toBasic());

        user.socket.emit(ServerEvents.Admin.Users, this.getUserList());

        this.listenToKick(user);
        this.listenToBan(user);
        this.listenToApprove(user);
    }

    protected override onLeave(user: User): void {
        user.socket.broadcast
            .to(this.roomName)
            .emit(ServerEvents.Admin.Left, user.toBasic());
    }

    private listenToKick(user: User): void {
        const { socket } = user;
        const admin = user.toBasic();

        this.listen(user, ClientEvents.Admin.Kick, (target, reason) => {
            if (target.isAdmin) return;

            const targetUser = this.getUserFromOtherRooms(target);
            if (targetUser === null) return;

            targetUser.socket.emit(ServerEvents.Connection.Rejected, reason);
            targetUser.socket.disconnect();

            socket.broadcast
                .to(this.roomName)
                .emit(ServerEvents.Admin.Kicked, admin, target, reason);
        });
    }

    private listenToBan(user: User): void {
        const { socket } = user;
        const admin = user.toBasic();

        this.listen(user, ClientEvents.Admin.Ban, (target, reason) => {
            if (target.isAdmin) return;

            const targetUser = this.getUserFromOtherRooms(target);
            if (targetUser === null) return;

            // PRESERVED POLICY QUIRK (see admission.test.ts):
            // getIdenticalUsers scans THIS room only, so on loopback the
            // disconnect loop hits identical-ip admins, not the target;
            // the ip ban itself still lands. Deliberate pending policy
            // review — do not "fix" silently.
            for (const identical of this.getIdenticalUsers(targetUser.ip)) {
                identical.socket.emit(ServerEvents.Connection.Rejected, reason);
                identical.socket.disconnect();
                socket.broadcast
                    .to(this.roomName)
                    .emit(ServerEvents.Admin.Banned, admin, target, reason);
            }

            this.services.access.banIp(targetUser.ip);
        });
    }

    private listenToApprove(user: User): void {
        const { socket } = user;
        const admin = user.toBasic();

        this.listen(user, ClientEvents.Admin.Approve, async (target) => {
            // Approval moves a user OUT of the waiting room — nothing else.
            // A target that is not currently waiting (already admitted,
            // already gone, or an admin) is a no-op: re-admitting an active
            // member would duplicate their entries and used to strip their
            // live handlers via the old removeAllListeners cleanup.
            const targetUser = this.peers.waitingRoom.tryGetUser(target);
            if (targetUser === undefined) return;

            await this.peers.waitingRoom.remove(targetUser);
            try {
                await this.peers.cinema.add(targetUser);
            } catch (error) {
                // Admission into the cinema failed (e.g. join rejected):
                // seat them back in the waiting room instead of leaving them
                // attached to nothing.
                this.services.logger.error(
                    'cinema admission failed; returning to waiting room',
                    target.username,
                    error,
                );
                await this.peers.waitingRoom.add(targetUser);
                return;
            }

            socket.broadcast
                .to(this.roomName)
                .emit(ServerEvents.Admin.Approved, admin, target);
        });
    }

    private getUserFromOtherRooms(baseUser: BaseUser): User | null {
        const user =
            this.peers.cinema.tryGetUser(baseUser) ??
            this.peers.waitingRoom.tryGetUser(baseUser);

        if (user === undefined) {
            this.services.logger.error(
                `User ${baseUser.username} not found`,
                new Error().stack,
            );

            return null;
        }

        return user;
    }
}
