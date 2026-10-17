import { PlaybackClock } from '../playback/PlaybackClock.js';
import type { RoomServices } from '../rooms.js';
import { BaseUser } from '../shared/BaseUser.js';
import {
    ClientEvents,
    isPlaybackCommand,
    normalizeMediaId,
    PlaybackCommand,
    PlaybackSnapshot,
    ServerEvents,
} from '../shared/index.js';
import { User } from '../User.js';
import { Room } from './Room.js';

/** Performs the admin-broadcast that follows a successful playback command. */
type PlaybackBroadcast = (admin: BaseUser, snapshot: PlaybackSnapshot) => void;

/** The admin playback commands that carry a validated PlaybackCommand. */
type PlaybackCommandEvent =
    | ClientEvents.Cinema.Play
    | ClientEvents.Cinema.Pause
    | ClientEvents.Cinema.Seek;

export class Cinema extends Room {
    /**
     * Server-authoritative playback state, projected from an anchor so the
     * position keeps advancing for late joiners and after host disconnect.
     */
    private readonly clock: PlaybackClock;

    public constructor(
        services: RoomServices,
        now: () => number = (): number => performance.now(),
    ) {
        super('cinema', services);
        this.clock = new PlaybackClock(now);
    }

    /** Current authoritative playback state (also the join snapshot source). */
    public snapshot(): PlaybackSnapshot {
        return this.clock.snapshot();
    }

    protected override onJoin(user: User): void {
        user.socket.broadcast
            .to(this.roomName)
            .emit(ServerEvents.Cinema.Joined, user.toBasic());

        user.socket.emit(
            ServerEvents.Cinema.Users,
            this.getUserList(),
            this.snapshot(),
        );

        if (user.isAdmin) {
            this.listenToSelect(user);
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

    /**
     * Attaches one playback command listener for an admin user.
     * 'not-authorized' and 'not-in-cinema' cannot happen today since these
     * listeners live and die with membership. The codes stay on the wire
     * for when listener lifetimes decouple from membership.
     */
    private listenToCommand(
        user: User,
        event: PlaybackCommandEvent,
        apply: (command: PlaybackCommand) => void,
        broadcast: PlaybackBroadcast,
    ): void {
        const { socket } = user;
        const admin = user.toBasic();

        this.listen(user, event, (payload: unknown) => {
            if (!isPlaybackCommand(payload)) {
                socket.emit(ServerEvents.Cinema.CommandRejected, 'invalid-command');
                return;
            }

            if (payload.mediaId !== this.clock.currentMediaId()) {
                socket.emit(ServerEvents.Cinema.CommandRejected, 'wrong-media');
                return;
            }

            try {
                apply(payload);
            } catch {
                // Backstop: a hostile payload should never reach apply, and
                // a crash here would take the server down.
                socket.emit(ServerEvents.Cinema.CommandRejected, 'invalid-command');
                return;
            }

            broadcast(admin, this.snapshot());
        });
    }

    private listenToPlay(user: User): void {
        this.listenToCommand(
            user,
            ClientEvents.Cinema.Play,
            (command): void => {
                this.clock.play(command);
            },
            (admin, snapshot): void => {
                user.socket.broadcast
                    .to(this.roomName)
                    .emit(ServerEvents.Cinema.Playing, admin, snapshot);
            },
        );
    }

    private listenToPause(user: User): void {
        this.listenToCommand(
            user,
            ClientEvents.Cinema.Pause,
            (command): void => {
                this.clock.pause(command);
            },
            (admin, snapshot): void => {
                user.socket.broadcast
                    .to(this.roomName)
                    .emit(ServerEvents.Cinema.Paused, admin, snapshot);
            },
        );
    }

    private listenToSeek(user: User): void {
        this.listenToCommand(
            user,
            ClientEvents.Cinema.Seek,
            (command): void => {
                this.clock.seek(command);
            },
            (admin, snapshot): void => {
                user.socket.broadcast
                    .to(this.roomName)
                    .emit(ServerEvents.Cinema.Seeked, admin, snapshot);
            },
        );
    }

    private listenToSelect(user: User): void {
        const { socket } = user;

        this.listen(user, ClientEvents.Cinema.Select, (payload: unknown) => {
            const mediaId =
                typeof payload === 'string' ? normalizeMediaId(payload) : null;

            if (mediaId === null) {
                socket.emit(ServerEvents.Cinema.CommandRejected, 'invalid-command');
                return;
            }

            try {
                this.clock.selectMedia(mediaId);
            } catch {
                // Same backstop as the playback commands, scoped to apply.
                socket.emit(ServerEvents.Cinema.CommandRejected, 'invalid-command');
                return;
            }

            // Broadcast to the whole cinema INCLUDING the host: a select is
            // a media/state change, and Cinema.State (not a reused Seeked)
            // lets clients distinguish "your media changed" from "the admin
            // seeked".
            const snapshot = this.snapshot();
            socket.emit(ServerEvents.Cinema.State, snapshot);
            socket.broadcast
                .to(this.roomName)
                .emit(ServerEvents.Cinema.State, snapshot);
        });
    }
}
