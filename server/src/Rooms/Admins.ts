import { Rooms } from '../index.js';
import { BaseUser } from '../shared/BaseUser.js';
import { ClientEvents, ServerEvents } from '../shared/index.js';
import { User } from '../User.js';
import { addBannedIp } from '../validation.js';
import { Room } from './Room.js';

export class Admins extends Room {
    public constructor() {
        super('admins');
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

        socket.on(ClientEvents.Admin.Kick, (target, reason) => {
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

        socket.on(ClientEvents.Admin.Ban, (target, reason) => {
            if (target.isAdmin) return;

            const targetUser = this.getUserFromOtherRooms(target);
            if (targetUser === null) return;

            for (const user of this.getIdenticalUsers(targetUser.ip)) {
                user.socket.emit(ServerEvents.Connection.Rejected, reason);
                user.socket.disconnect();
                socket.broadcast
                    .to(this.roomName)
                    .emit(ServerEvents.Admin.Banned, admin, target, reason);
            }

            addBannedIp(targetUser.ip);
        });
    }

    private listenToApprove(user: User): void {
        const { socket } = user;
        const admin = user.toBasic();

        socket.on(ClientEvents.Admin.Approve, async (target) => {
            const targetUser = this.getUserFromOtherRooms(target);
            if (targetUser === null) return;

            await Rooms.WaitingRoom.remove(targetUser);
            await Rooms.Cinema.add(targetUser);

            socket.broadcast
                .to(this.roomName)
                .emit(ServerEvents.Admin.Approved, admin, target);
        });
    }

    private getUserFromOtherRooms(baseUser: BaseUser): User | null {
        const user =
            Rooms.Cinema.tryGetUser(baseUser) ??
            Rooms.WaitingRoom.tryGetUser(baseUser);

        if (user === undefined) {
            console.error(
                `User ${baseUser.username} not found`,
                new Error().stack,
            );

            return null;
        }

        return user;
    }
}
