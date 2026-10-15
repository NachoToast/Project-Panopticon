import { afterEach, describe, expect, it } from 'vitest';
import type { Socket as ClientSocket } from 'socket.io-client';
import { ServerEvents } from '../../src/shared/index.js';
import {
    closeTestApps,
    connect,
    nextEvent,
    startTestApp,
    type StartedApp,
} from '../helpers/testApp.js';

// Cinema playback over REAL sockets against a real createApplication()
// instance: hostile payloads must be REJECTED, never thrown, and the
// authoritative clock must advance for late joiners over the wire.
//
// This file evolved from Task 4's cinema.test.ts, which hand-wired a Cinema
// room and vi.mock'ed src/index.ts. The application factory made both the
// mock and the manual wiring unnecessary: connections now run through the
// real admission flow (first connector = host, others approved from the
// waiting room).

const MEDIA = 'movie.mp4';

afterEach(async (): Promise<void> => {
    await closeTestApps();
});

interface SeatedViewer {
    readonly socket: ClientSocket;
    /** cinema:users payload the viewer joined with. */
    readonly users: unknown[];
}

/**
 * Connects a viewer and walks them through the real admission flow:
 * waiting room -> host approval -> cinema seat.
 *
 * Viewers must be connected one at a time: the waiting-room ip rule rejects
 * a second concurrent waiter, and all test clients share the loopback ip.
 */
async function connectViewer(
    app: StartedApp,
    host: ClientSocket,
    username: string,
): Promise<SeatedViewer> {
    const socket = connect(app.url, username);
    const accepted = nextEvent(socket, ServerEvents.Connection.Accepted);
    const joined = nextEvent(host, ServerEvents.WaitingRoom.Joined);
    socket.connect();
    const [isAdmin] = await accepted;
    expect(isAdmin).toBe(false);
    const [waitingUser] = await joined;

    const seated = nextEvent(socket, ServerEvents.Cinema.Users);
    host.emit('admin:approve', waitingUser);
    const users = await seated;

    return { socket, users };
}

/** Connects the first client: the host, seated in admins + cinema. */
async function connectHost(app: StartedApp): Promise<ClientSocket> {
    const socket = connect(app.url, 'host');
    // Subscribe before connecting: the seat snapshot can arrive in the
    // same packet batch as the acceptance.
    const accepted = nextEvent(socket, ServerEvents.Connection.Accepted);
    const seated = nextEvent(socket, ServerEvents.Cinema.Users);
    socket.connect();
    const [isAdmin] = await accepted;
    expect(isAdmin).toBe(true);
    await seated;
    return socket;
}

/** One hostile payload + the rejection it must produce, sent as `play`. */
async function expectPlayRejection(
    host: ClientSocket,
    payload: unknown,
    rejection: string,
): Promise<void> {
    const received = nextEvent(host, ServerEvents.Cinema.CommandRejected);
    host.emit('cinema:play', payload);
    await expect(received).resolves.toEqual([rejection]);
}

describe('Cinema playback over a real application', (): void => {
    it('rejects hostile play/pause/seek/select payloads instead of throwing', async (): Promise<void> => {
        const app = await startTestApp();
        const host = await connectHost(app);

        // Select a valid media first so wrong-media is distinguishable.
        const state = nextEvent(host, ServerEvents.Cinema.State);
        host.emit('cinema:select', MEDIA);
        await expect(state).resolves.toEqual([
            { mediaId: MEDIA, playing: false, position: 0, revision: 1 },
        ]);

        // Any thrown handler would surface as an uncaught exception and
        // fail this test; capture them to assert none escaped.
        const uncaught: unknown[] = [];
        const onUncaught = (error: unknown): void => {
            uncaught.push(error);
        };
        process.on('uncaughtException', onUncaught);

        try {
            await expectPlayRejection(host, null, 'invalid-command');
            await expectPlayRejection(host, undefined, 'invalid-command');
            await expectPlayRejection(host, 42, 'invalid-command');
            await expectPlayRejection(host, 'play', 'invalid-command');
            await expectPlayRejection(host, [], 'invalid-command');
            await expectPlayRejection(host, {}, 'invalid-command');
            await expectPlayRejection(host, { mediaId: MEDIA }, 'invalid-command');
            await expectPlayRejection(host, { position: 0 }, 'invalid-command');
            await expectPlayRejection(host, { mediaId: null, position: 0 }, 'invalid-command');
            await expectPlayRejection(host, { mediaId: MEDIA, position: Number.NaN }, 'invalid-command');
            await expectPlayRejection(host, { mediaId: MEDIA, position: -1 }, 'invalid-command');
            await expectPlayRejection(host, { mediaId: '../evil.mp4', position: 0 }, 'invalid-command');
            await expectPlayRejection(host, { mediaId: ['x'], position: 0 }, 'invalid-command');

            // Valid shape, but not the selected media.
            await expectPlayRejection(host, { mediaId: 'other.mp4', position: 0 }, 'wrong-media');

            // Pause/seek share the same boundary; spot-check both.
            const pauseRejected = nextEvent(host, ServerEvents.Cinema.CommandRejected);
            host.emit('cinema:pause', 'garbage');
            await expect(pauseRejected).resolves.toEqual(['invalid-command']);

            const seekRejected = nextEvent(host, ServerEvents.Cinema.CommandRejected);
            host.emit('cinema:seek', { mediaId: 'other.mp4', position: 5 });
            await expect(seekRejected).resolves.toEqual(['wrong-media']);

            // Hostile selects: non-strings, blanks, traversal, oversize.
            // Sequential on purpose — each rejection must be observed before
            // the next select, so the ordered emissions are unrolled rather
            // than looped.
            const selectPayloads: readonly unknown[] = [123, {}, '', '   ', '../evil', 'x'.repeat(300)];
            for (const payload of selectPayloads) {
                const selectRejected = nextEvent(host, ServerEvents.Cinema.CommandRejected);
                host.emit('cinema:select', payload);
                // eslint-disable-next-line no-await-in-loop -- ordering is the point
                await expect(selectRejected).resolves.toEqual(['invalid-command']);
            }
        } finally {
            process.off('uncaughtException', onUncaught);
        }

        expect(uncaught).toEqual([]);

        // The clock was never touched by the garbage above.
        expect(app.rooms.Cinema.snapshot()).toEqual({
            mediaId: MEDIA,
            playing: false,
            position: 0,
            revision: 1,
        });
    });

    it('broadcasts fresh snapshots and advances the position for a late joiner', async (): Promise<void> => {
        const app = await startTestApp();
        const host = await connectHost(app);

        const state = nextEvent(host, ServerEvents.Cinema.State);
        host.emit('cinema:select', MEDIA);
        await state;

        // A second real connection is approved mid-film.
        const viewer = await connectViewer(app, host, 'viewer');

        const playing = nextEvent(viewer.socket, ServerEvents.Cinema.Playing);
        host.emit('cinema:play', { mediaId: MEDIA, position: 500 });
        const [playingAdmin, playingSnapshot] = await playing;
        expect(playingAdmin).toEqual(expect.objectContaining({ username: 'host', isAdmin: true }));
        // The broadcast is the freshly PROJECTED snapshot, so the position
        // may already be microseconds past the commanded base.
        expect(playingSnapshot).toMatchObject({ mediaId: MEDIA, playing: true, revision: 2 });
        expect((playingSnapshot as { position: number }).position).toBeGreaterThanOrEqual(500);
        expect((playingSnapshot as { position: number }).position).toBeLessThan(501);

        // Real elapsed time passes; a third joiner must see it advanced.
        await new Promise((resolve): void => {
            setTimeout(resolve, 150);
        });
        const lateJoiner = await connectViewer(app, host, 'latecomer');
        const lateSnapshot = lateJoiner.users[1];
        expect(lateSnapshot).toMatchObject({ mediaId: MEDIA, playing: true });
        expect((lateSnapshot as { position: number }).position).toBeGreaterThanOrEqual(500.1);
    });

    it('freezes on pause and carries exact seek positions to viewers', async (): Promise<void> => {
        const app = await startTestApp();
        const host = await connectHost(app);
        const viewer = await connectViewer(app, host, 'viewer');

        const state = nextEvent(host, ServerEvents.Cinema.State);
        host.emit('cinema:select', MEDIA);
        await state;

        host.emit('cinema:play', { mediaId: MEDIA, position: 10 });
        await nextEvent(viewer.socket, ServerEvents.Cinema.Playing);

        const paused = nextEvent(viewer.socket, ServerEvents.Cinema.Paused);
        host.emit('cinema:pause', { mediaId: MEDIA, position: 31.5 });
        const [, pauseSnapshot] = await paused;
        expect(pauseSnapshot).toMatchObject({ playing: false, position: 31.5 });

        const seeked = nextEvent(viewer.socket, ServerEvents.Cinema.Seeked);
        host.emit('cinema:seek', { mediaId: MEDIA, position: 12 });
        const [, seekSnapshot] = await seeked;
        expect(seekSnapshot).toMatchObject({ playing: false, position: 12 });
        expect((seekSnapshot as { revision: number }).revision).toBeGreaterThan(
            (pauseSnapshot as { revision: number }).revision,
        );
    });

    it('treats a same-media re-select as a no-op, not a reset', async (): Promise<void> => {
        const app = await startTestApp();
        const host = await connectHost(app);

        const state = nextEvent(host, ServerEvents.Cinema.State);
        host.emit('cinema:select', MEDIA);
        await state;

        host.emit('cinema:play', { mediaId: MEDIA, position: 120 });
        await new Promise((resolve): void => {
            setTimeout(resolve, 50);
        });

        const reselect = nextEvent(host, ServerEvents.Cinema.State);
        host.emit('cinema:select', MEDIA); // host re-announces
        const [snapshot] = await reselect;
        expect(snapshot).toMatchObject({ mediaId: MEDIA, playing: true, revision: 2 });
        expect((snapshot as { position: number }).position).toBeGreaterThanOrEqual(120);

        const reset = nextEvent(host, ServerEvents.Cinema.State);
        host.emit('cinema:select', 'other.mp4');
        await expect(reset).resolves.toEqual([
            { mediaId: 'other.mp4', playing: false, position: 0, revision: 3 },
        ]);
    });
});
