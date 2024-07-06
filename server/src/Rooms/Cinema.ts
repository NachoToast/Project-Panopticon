import { ClientEvents, ServerEvents } from '../shared/index.js';
import { User } from '../User.js';
import { Room } from './Room.js';

export class Cinema extends Room {
    private playing = false;

    private time = 0;

    public constructor() {
        super('cinema');
    }

    protected override onJoin(user: User): void {
        user.socket.broadcast
            .to(this.roomName)
            .emit(ServerEvents.Cinema.Joined, user.toBasic());

        user.socket.emit(
            ServerEvents.Cinema.Users,
            this.getUserList(),
            this.playing,
            this.time,
        );

        if (user.isAdmin) {
            this.listenToPlay(user);
            this.listenToPause(user);
            this.listenToSeek(user);
        }
    }
    protected override onLeave(user: User): void {
        user.socket.broadcast
            .to(this.roomName)
            .emit(ServerEvents.Cinema.Left, user.toBasic());
    }

    private listenToPlay(user: User): void {
        const { socket } = user;
        const admin = user.toBasic();

        socket.on(ClientEvents.Cinema.Play, (time) => {
            this.playing = true;
            this.time = time;

            socket.broadcast
                .to(this.roomName)
                .emit(ServerEvents.Cinema.Playing, admin, time);
        });
    }

    private listenToPause(user: User): void {
        const { socket } = user;
        const admin = user.toBasic();

        socket.on(ClientEvents.Cinema.Pause, (time) => {
            this.playing = false;
            this.time = time;

            socket.broadcast
                .to(this.roomName)
                .emit(ServerEvents.Cinema.Paused, admin, time);
        });
    }

    private listenToSeek(user: User): void {
        const { socket } = user;
        const admin = user.toBasic();

        socket.on(ClientEvents.Cinema.Seek, (time) => {
            this.time = time;

            socket.broadcast
                .to(this.roomName)
                .emit(ServerEvents.Cinema.Seeked, admin, time);
        });
    }
}
