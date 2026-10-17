import type { RoomServices } from '../rooms.js';
import { ServerEvents } from '../shared/index.js';
import { User } from '../User.js';
import { Room } from './Room.js';

export class WaitingRoom extends Room {
    /**
     * Refcount per ip: the approve-failure re-seat path can briefly hold
     * two seats for one ip, so counting claimants (not mere presence)
     * keeps hasIp true until the last same-ip member leaves.
     */
    private readonly ips = new Map<string, number>();

    private readonly adminsRoomName: string;

    public constructor(services: RoomServices, adminsRoomName: string) {
        super('waiting-room', services);
        this.adminsRoomName = adminsRoomName;
    }

    public hasIp(ip: string): boolean {
        return (this.ips.get(ip) ?? 0) > 0;
    }

    protected override onJoin(user: User): void {
        this.ips.set(user.ip, (this.ips.get(user.ip) ?? 0) + 1);

        user.socket.broadcast
            .to(this.adminsRoomName)
            .emit(ServerEvents.WaitingRoom.Joined, user.toBasic());
    }

    protected override onLeave(user: User): void {
        const remaining = (this.ips.get(user.ip) ?? 0) - 1;
        if (remaining > 0) {
            this.ips.set(user.ip, remaining);
        } else {
            this.ips.delete(user.ip);
        }

        user.socket.broadcast
            .to(this.adminsRoomName)
            .emit(ServerEvents.WaitingRoom.Left, user.toBasic());
    }
}
