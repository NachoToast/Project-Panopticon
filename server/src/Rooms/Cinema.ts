import { PlaybackClock } from '../playback/PlaybackClock.js';
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
     * Server-authoritative playback state: the position keeps advancing for
     * late joiners (and after the host disconnects) because it is projected
     * from an anchor, not stored frozen.
     */
    private readonly clock = new PlaybackClock((): number => performance.now());

    public constructor() {
        super('cinema');
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
     *
     * 'not-authorized' and 'not-in-cinema' are structurally impossible today:
     * these listeners attach only inside onJoin for admins, and Room.remove /
     * disconnect strip every listener when membership ends. The rejection
     * codes still exist on the wire (and the client maps them) for when
     * listener lifetimes decouple from membership — Task 5's restructuring.
     */
    private listenToCommand(
        user: User,
        event: PlaybackCommandEvent,
        apply: (command: PlaybackCommand) => void,
        broadcast: PlaybackBroadcast,
    ): void {
        const { socket } = user;
        const admin = user.toBasic();

        socket.on(event, (payload: unknown) => {
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
                // Socket.IO delivers whatever peers send; a hostile payload
                // must never crash the server. The guards above should make
                // this unreachable — this backstop converts the impossible
                // into a rejection. It stops at apply: broadcast emits plain
                // snapshots and cannot throw, so a rejection always means
                // nothing was applied.
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

        socket.on(ClientEvents.Cinema.Select, (payload: unknown) => {
            const mediaId =
                typeof payload === 'string' ? normalizeMediaId(payload) : null;

            if (mediaId === null) {
                socket.emit(ServerEvents.Cinema.CommandRejected, 'invalid-command');
                return;
            }

            try {
                this.clock.selectMedia(mediaId);
            } catch {
                // Same backstop as the playback commands, scoped to apply:
                // the emits below carry plain snapshots and cannot throw, so
                // a rejection always means nothing was selected.
                socket.emit(ServerEvents.Cinema.CommandRejected, 'invalid-command');
                return;
            }

            // Broadcast to the whole cinema INCLUDING the host: a
            // select is a media/state change, not an admin playback
            // action, so everyone (host included) learns the
            // authoritative snapshot and its revision together. This
            // is Cinema.State rather than a reused Seeked so clients
            // can distinguish "your media changed" from "the admin
            // seeked" — Task 6 and the PR 2 UI rely on that.
            const snapshot = this.snapshot();
            socket.emit(ServerEvents.Cinema.State, snapshot);
            socket.broadcast
                .to(this.roomName)
                .emit(ServerEvents.Cinema.State, snapshot);
        });
    }
}
