import { Rooms } from '../index.js';
import { ServerEvents } from '../shared/index.js';
import { User } from '../User.js';
import { Room } from './Room.js';

export class WaitingRoom extends Room {
    private readonly ips = new Set<string>();

    public constructor() {
        super('waiting-room');
    }

    public hasIp(ip: string): boolean {
        return this.ips.has(ip);
    }

    protected override onJoin(user: User): void {
        this.ips.add(user.ip);

        user.socket.broadcast
            .to(Rooms.Admins.roomName)
            .emit(ServerEvents.WaitingRoom.Joined, user.toBasic());
    }

    protected override onLeave(user: User): void {
        this.ips.delete(user.ip);

        user.socket.broadcast
            .to(Rooms.Admins.roomName)
            .emit(ServerEvents.WaitingRoom.Left, user.toBasic());
    }
}
