import { createServer, type Server as HttpServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Server, type Socket as ServerSocket } from 'socket.io';
import { io, type Socket as ClientSocket } from 'socket.io-client';
import { Cinema } from '../../src/Rooms/Cinema.js';
import { ServerEvents } from '../../src/shared/index.js';
import { User } from '../../src/User.js';

// Real-socket integration coverage for the cinema playback boundary:
// hostile payloads must be REJECTED, never thrown, and the authoritative
// clock must advance for late joiners over the wire.

// Rooms/User transitively import src/index.ts, which starts a real server on
// a fixed port at module scope; mock that module so importing the room is
// side-effect free in tests.
vi.mock('../../src/index.js', () => ({
    Rooms: { Admins: {}, Cinema: {}, WaitingRoom: {} },
    logApplicationState: (): undefined => undefined,
}));

interface Harness {
    readonly url: string;
    readonly cinema: Cinema;
    close: () => Promise<void>;
}

const MEDIA = 'movie.mp4';

let harness: Harness | null = null;
let hostCounter = 0;

/** Client sockets created for the current harness, disconnected on close. */
const clients = new Set<ClientSocket>();

async function startHarness(): Promise<Harness> {
    const httpServer: HttpServer = createServer();
    const io = new Server(httpServer, { cors: { origin: '*' } });
    const cinema = new Cinema();
    let hostAssigned = false;
    io.on('connection', (socket: ServerSocket): void => {
        // Minimal connection wiring: the FIRST connector is the host (admin,
        // matching production role assignment) and everyone after is a plain
        // viewer; all join the cinema directly. The waiting-room/approval
        // flow belongs to the Task 5 test-app factory.
        hostCounter += 1;
        const isAdmin = !hostAssigned;
        hostAssigned = true;
        const user = new User(socket, `user-${String(hostCounter)}`, isAdmin);
        void cinema.add(user);
    });

    const port = await new Promise<number>((resolve, reject): void => {
        httpServer.once('error', reject);
        httpServer.listen(0, (): void => {
            const address = httpServer.address();
            if (address === null || typeof address === 'string') {
                reject(new Error('expected a tcp address'));
                return;
            }
            resolve(address.port);
        });
    });

    return {
        url: `http://127.0.0.1:${String(port)}`,
        cinema,
        close: async (): Promise<void> => {
            for (const socket of clients) {
                socket.disconnect();
            }
            clients.clear();
            await new Promise<void>((resolve): void => {
                void io.close((): void => {
                    resolve();
                });
            });
        },
    };
}

/** A seated client plus the cinema:users payload it joined with. */
interface SeatedClient {
    readonly socket: ClientSocket;
    readonly users: unknown[];
}

/** Connects a real client and waits until the room has fully seated it. */
async function connectClient(h: Harness): Promise<SeatedClient> {
    const socket = io(h.url, { autoConnect: false });
    clients.add(socket);
    const seated = new Promise<unknown[]>((resolve): void => {
        socket.once(ServerEvents.Cinema.Users, (...args: unknown[]): void => {
            resolve(args);
        });
    });
    socket.connect();
    const users = await seated;
    return { socket, users };
}

/** Resolves with the next payload(s) for `event`, failing on timeout. */
function nextEvent(socket: ClientSocket, event: string, timeoutMs = 2_000): Promise<unknown[]> {
    return new Promise<unknown[]>((resolve, reject): void => {
        const timer = setTimeout((): void => {
            reject(new Error(`timed out waiting for "${event}"`));
        }, timeoutMs);
        socket.once(event, (...args: unknown[]): void => {
            clearTimeout(timer);
            resolve(args);
        });
    });
}

/** One hostile payload + the rejection it must produce, sent as `play`. */
async function expectPlayRejection(
    host: SeatedClient,
    payload: unknown,
    rejection: string,
): Promise<void> {
    const received = nextEvent(host.socket, ServerEvents.Cinema.CommandRejected);
    host.socket.emit('cinema:play', payload);
    await expect(received).resolves.toEqual([rejection]);
}

afterEach(async (): Promise<void> => {
    hostCounter = 0;
    const current = harness;
    harness = null;
    if (current !== null) {
        await current.close();
    }
});

describe('Cinema playback boundary over a real socket', (): void => {
    it('rejects hostile play/pause/seek/select payloads instead of throwing', async (): Promise<void> => {
        harness = await startHarness();
        const host = await connectClient(harness);

        // Select a valid media first so wrong-media is distinguishable.
        const state = nextEvent(host.socket, ServerEvents.Cinema.State);
        host.socket.emit('cinema:select', MEDIA);
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
            const pauseRejected = nextEvent(host.socket, ServerEvents.Cinema.CommandRejected);
            host.socket.emit('cinema:pause', 'garbage');
            await expect(pauseRejected).resolves.toEqual(['invalid-command']);

            const seekRejected = nextEvent(host.socket, ServerEvents.Cinema.CommandRejected);
            host.socket.emit('cinema:seek', { mediaId: 'other.mp4', position: 5 });
            await expect(seekRejected).resolves.toEqual(['wrong-media']);

            // Hostile selects: non-strings, blanks, traversal, oversize.
            // Sequential on purpose — each rejection must be observed before
            // the next select, so the ordered emissions are unrolled rather
            // than looped.
            const selectPayloads: readonly unknown[] = [123, {}, '', '   ', '../evil', 'x'.repeat(300)];
            for (const payload of selectPayloads) {
                const selectRejected = nextEvent(host.socket, ServerEvents.Cinema.CommandRejected);
                host.socket.emit('cinema:select', payload);
                // eslint-disable-next-line no-await-in-loop -- ordering is the point
                await expect(selectRejected).resolves.toEqual(['invalid-command']);
            }
        } finally {
            process.off('uncaughtException', onUncaught);
        }

        expect(uncaught).toEqual([]);

        // The clock was never touched by the garbage above.
        expect(harness.cinema.snapshot()).toEqual({
            mediaId: MEDIA,
            playing: false,
            position: 0,
            revision: 1,
        });
    });

    it('broadcasts fresh snapshots and advances the position for a late joiner', async (): Promise<void> => {
        harness = await startHarness();
        const host = await connectClient(harness);

        const state = nextEvent(host.socket, ServerEvents.Cinema.State);
        host.socket.emit('cinema:select', MEDIA);
        await state;

        // A second real connection joins mid-film.
        const viewer = await connectClient(harness);

        const playing = nextEvent(viewer.socket, ServerEvents.Cinema.Playing);
        host.socket.emit('cinema:play', { mediaId: MEDIA, position: 500 });
        const [playingAdmin, playingSnapshot] = await playing;
        expect(playingAdmin).toEqual(expect.objectContaining({ username: 'user-1', isAdmin: true }));
        // The broadcast is the freshly PROJECTED snapshot, so the position
        // may already be microseconds past the commanded base.
        expect(playingSnapshot).toMatchObject({ mediaId: MEDIA, playing: true, revision: 2 });
        expect((playingSnapshot as { position: number }).position).toBeGreaterThanOrEqual(500);
        expect((playingSnapshot as { position: number }).position).toBeLessThan(501);

        // Real elapsed time passes; a third joiner must see it advanced.
        await new Promise((resolve): void => {
            setTimeout(resolve, 150);
        });
        const lateJoiner = await connectClient(harness);
        const lateSnapshot = lateJoiner.users[1];
        expect(lateSnapshot).toMatchObject({ mediaId: MEDIA, playing: true });
        expect((lateSnapshot as { position: number }).position).toBeGreaterThanOrEqual(500.1);
    });

    it('freezes on pause and carries exact seek positions to viewers', async (): Promise<void> => {
        harness = await startHarness();
        const host = await connectClient(harness);
        const viewer = await connectClient(harness);

        const state = nextEvent(host.socket, ServerEvents.Cinema.State);
        host.socket.emit('cinema:select', MEDIA);
        await state;

        host.socket.emit('cinema:play', { mediaId: MEDIA, position: 10 });
        await nextEvent(viewer.socket, ServerEvents.Cinema.Playing);

        const paused = nextEvent(viewer.socket, ServerEvents.Cinema.Paused);
        host.socket.emit('cinema:pause', { mediaId: MEDIA, position: 31.5 });
        const [, pauseSnapshot] = await paused;
        expect(pauseSnapshot).toMatchObject({ playing: false, position: 31.5 });

        const seeked = nextEvent(viewer.socket, ServerEvents.Cinema.Seeked);
        host.socket.emit('cinema:seek', { mediaId: MEDIA, position: 12 });
        const [, seekSnapshot] = await seeked;
        expect(seekSnapshot).toMatchObject({ playing: false, position: 12 });
        expect((seekSnapshot as { revision: number }).revision).toBeGreaterThan(
            (pauseSnapshot as { revision: number }).revision,
        );
    });

    it('treats a same-media re-select as a no-op, not a reset', async (): Promise<void> => {
        harness = await startHarness();
        const host = await connectClient(harness);

        const state = nextEvent(host.socket, ServerEvents.Cinema.State);
        host.socket.emit('cinema:select', MEDIA);
        await state;

        host.socket.emit('cinema:play', { mediaId: MEDIA, position: 120 });
        await new Promise((resolve): void => {
            setTimeout(resolve, 50);
        });

        const reselect = nextEvent(host.socket, ServerEvents.Cinema.State);
        host.socket.emit('cinema:select', MEDIA); // host re-announces
        const [snapshot] = await reselect;
        expect(snapshot).toMatchObject({ mediaId: MEDIA, playing: true, revision: 2 });
        expect((snapshot as { position: number }).position).toBeGreaterThanOrEqual(120);

        const reset = nextEvent(host.socket, ServerEvents.Cinema.State);
        host.socket.emit('cinema:select', 'other.mp4');
        await expect(reset).resolves.toEqual([
            { mediaId: 'other.mp4', playing: false, position: 0, revision: 3 },
        ]);
    });
});
