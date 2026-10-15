import type { RoomServices } from '../rooms.js';
import { ServerEvents } from '../shared/index.js';
import { User } from '../User.js';
import { Room } from './Room.js';

export class WaitingRoom extends Room {
    private readonly ips = new Set<string>();

    private readonly adminsRoomName: string;

    public constructor(services: RoomServices, adminsRoomName: string) {
        super('waiting-room', services);
        this.adminsRoomName = adminsRoomName;
    }

    public hasIp(ip: string): boolean {
        return this.ips.has(ip);
    }

    protected override onJoin(user: User): void {
        this.ips.add(user.ip);

        user.socket.broadcast
            .to(this.adminsRoomName)
            .emit(ServerEvents.WaitingRoom.Joined, user.toBasic());
    }

    protected override onLeave(user: User): void {
        this.ips.delete(user.ip);

        user.socket.broadcast
            .to(this.adminsRoomName)
            .emit(ServerEvents.WaitingRoom.Left, user.toBasic());
    }
}
