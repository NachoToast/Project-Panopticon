import { afterEach, describe, expect, it } from 'vitest';
import { createApplication } from '../../src/app.js';
import { ServerEvents } from '../../src/shared/index.js';
import { asServerSocket, FakeSocket } from '../helpers/fakeSocket.js';
import {
    closeTestApps,
    connect,
    nextDisconnect,
    nextEvent,
    startTestApp,
} from '../helpers/testApp.js';

// Admission, room membership, and application lifecycle over REAL sockets
// against isolated createApplication() instances. Also proves the preserved
// policy: waiting-room ip rule, username rules, kick, ban.

afterEach(async (): Promise<void> => {
    await closeTestApps();
});

/** Connects and resolves once the server has fully seated the client. */
async function connectSeated(
    url: string,
    username: string,
): Promise<{ isAdmin: boolean }> {
    const socket = connect(url, username);
    const accepted = nextEvent(socket, ServerEvents.Connection.Accepted);
    socket.connect();
    const [isAdmin] = await accepted;
    return { isAdmin: isAdmin === true };
}

describe('application factory lifecycle', (): void => {
    it('creating an application does not start listening', (): void => {
        const app = createApplication();

        expect(app.httpServer.listening).toBe(false);
    });

    it('importing and running two applications shares no state', async (): Promise<void> => {
        const appA = await startTestApp();
        const appB = await startTestApp();

        // Ban the (shared, loopback) ip in app A by banning a waiting user.
        const hostA = connect(appA.url, 'hosta');
        const acceptedA = nextEvent(hostA, ServerEvents.Connection.Accepted);
        hostA.connect();
        await acceptedA;

        const waiterA = connect(appA.url, 'waitera');
        const waiterJoined = nextEvent(hostA, ServerEvents.WaitingRoom.Joined);
        const waiterAccepted = nextEvent(
            waiterA,
            ServerEvents.Connection.Accepted,
        );
        waiterA.connect();
        await waiterAccepted;
        const [waitingUser] = await waiterJoined;

        hostA.emit('admin:ban', waitingUser, 'isolation test');

        // The ban must reject further admissions in app A...
        const rejected = connect(appA.url, 'afterbana');
        rejected.connect();
        await nextDisconnect(rejected);

        // ...but app B never heard of it: same username, same ip, accepted.
        const hostB = await connectSeated(appB.url, 'hostb');
        expect(hostB.isAdmin).toBe(true);

        const waiterB = connect(appB.url, 'waitera');
        const waiterTwoAccepted = nextEvent(
            waiterB,
            ServerEvents.Connection.Accepted,
        );
        waiterB.connect();
        const [waiterTwoIsAdmin] = await waiterTwoAccepted;
        expect(waiterTwoIsAdmin).toBe(false);
    });
});

describe('connection admission', (): void => {
    it('seats the first connection as host and later ones in the waiting room', async (): Promise<void> => {
        const app = await startTestApp();

        const host = await connectSeated(app.url, 'host');
        expect(host.isAdmin).toBe(true);
        expect(app.rooms.Admins.getUserList()).toHaveLength(1);

        const waiter = connect(app.url, 'waiter');
        const accepted = nextEvent(waiter, ServerEvents.Connection.Accepted);
        waiter.connect();
        const [isAdmin] = await accepted;
        expect(isAdmin).toBe(false);
        expect(app.rooms.WaitingRoom.getUserList()).toHaveLength(1);
    });

    it('rejects a second connection from an ip that is already waiting', async (): Promise<void> => {
        const app = await startTestApp();
        await connectSeated(app.url, 'host');
        await connectSeated(app.url, 'waiterone');

        const duplicate = connect(app.url, 'waitertwo');
        const rejected = nextEvent(duplicate, ServerEvents.Connection.Rejected);
        duplicate.connect();
        const [reason] = await rejected;
        expect(reason).toBe('Already in waiting room');
    });

    it('rejects taken usernames', async (): Promise<void> => {
        const app = await startTestApp();
        await connectSeated(app.url, 'host');

        // Duplicate the HOST's name: the host is not in the waiting room,
        // so the waiting-room ip rule cannot fire first.
        const duplicate = connect(app.url, 'HOST'); // case-insensitive
        const rejected = nextEvent(duplicate, ServerEvents.Connection.Rejected);
        duplicate.connect();
        const [reason] = await rejected;
        expect(reason).toBe('Username taken');
    });

    it('rejects invalid and missing usernames', async (): Promise<void> => {
        const app = await startTestApp();
        await connectSeated(app.url, 'host');

        const missing = connect(app.url, 'ok-but-no-auth');
        missing.auth = {};
        const missingRejected = nextEvent(
            missing,
            ServerEvents.Connection.Rejected,
        );
        missing.connect();
        expect(await missingRejected).toEqual(['Username not supplied']);

        const invalid = connect(app.url, 'x'); // too short after trim
        const invalidRejected = nextEvent(
            invalid,
            ServerEvents.Connection.Rejected,
        );
        invalid.connect();
        const [reason] = await invalidRejected;
        expect(reason).toBe('Username invalid');
    });

    it('releases a username when its connection disconnects', async (): Promise<void> => {
        const app = await startTestApp();
        const host = connect(app.url, 'host');
        const hostAccepted = nextEvent(host, ServerEvents.Connection.Accepted);
        host.connect();
        await hostAccepted;

        const waiter = connect(app.url, 'recycled');
        const waiterAccepted = nextEvent(
            waiter,
            ServerEvents.Connection.Accepted,
        );
        waiter.connect();
        await waiterAccepted;

        waiter.disconnect();
        // Event-driven instead of a sleep: the Left broadcast to admins
        // fires during the same server-side disconnect cleanup that
        // releases the username, so once the host sees it the name is
        // free to claim again.
        const waiterLeft = nextEvent(host, ServerEvents.WaitingRoom.Left);
        await waiterLeft;

        const reuse = connect(app.url, 'recycled');
        const reuseAccepted = nextEvent(reuse, ServerEvents.Connection.Accepted);
        reuse.connect();
        await reuseAccepted;
    });
});

describe('approval', (): void => {
    it('admits a waiting user to the cinema exactly once', async (): Promise<void> => {
        const app = await startTestApp();
        const host = connect(app.url, 'host');
        const hostAccepted = nextEvent(host, ServerEvents.Connection.Accepted);
        host.connect();
        await hostAccepted;

        const viewer = connect(app.url, 'viewer');
        const viewerJoined = nextEvent(host, ServerEvents.WaitingRoom.Joined);
        const viewerAccepted = nextEvent(
            viewer,
            ServerEvents.Connection.Accepted,
        );
        viewer.connect();
        await viewerAccepted;
        const [waitingUser] = await viewerJoined;

        const cinemaJoined = nextEvent(host, ServerEvents.Cinema.Joined);
        host.emit('admin:approve', waitingUser);
        await cinemaJoined;

        // Double click / stale second approve: no further admission.
        // Events on one socket are handled in order, so instead of a
        // fixed sleep, follow the duplicate with a state round-trip,
        // once its result arrives, the duplicate has been fully handled.
        const stateAfterDuplicate = nextEvent(host, ServerEvents.Cinema.State);
        host.emit('admin:approve', waitingUser);
        host.emit('cinema:select', 'movie.mp4');
        await stateAfterDuplicate;

        const seated = app.rooms.Cinema.getUserList();
        expect(seated.filter((entry) => entry.username === 'viewer')).toHaveLength(
            1,
        );
    });

    it('keeps an admitted host fully functional when they are approved again', async (): Promise<void> => {
        const app = await startTestApp();
        const host = connect(app.url, 'host');
        const hostAccepted = nextEvent(host, ServerEvents.Connection.Accepted);
        const hostUsers = nextEvent(host, ServerEvents.Admin.Users);
        host.connect();
        await hostAccepted;
        const [adminUsers] = await hostUsers;
        const hostUser = (adminUsers as { username: string }[]).find(
            (entry): boolean => entry.username === 'host',
        );
        expect(hostUser).toBeDefined();

        const viewer = connect(app.url, 'viewer');
        const viewerJoined = nextEvent(host, ServerEvents.WaitingRoom.Joined);
        const viewerAccepted = nextEvent(
            viewer,
            ServerEvents.Connection.Accepted,
        );
        viewer.connect();
        await viewerAccepted;
        const [waitingUser] = await viewerJoined;

        const cinemaJoined = nextEvent(host, ServerEvents.Cinema.Joined);
        host.emit('admin:approve', waitingUser);
        await cinemaJoined;

        // A stale/duplicate approve targeting the HOST (a cinema member).
        host.emit('admin:approve', hostUser);

        const state = nextEvent(host, ServerEvents.Cinema.State);
        host.emit('cinema:select', 'movie.mp4');
        await state;

        // The host's playback handlers survived: the viewer still receives
        // the play broadcast.
        const playing = nextEvent(viewer, ServerEvents.Cinema.Playing);
        host.emit('cinema:play', { mediaId: 'movie.mp4', position: 0 });
        await playing;

        expect(
            app.rooms.Cinema.getUserList().filter(
                (entry) => entry.username === 'host',
            ),
        ).toHaveLength(1);
    });
});

describe('kick and ban', (): void => {
    it('kicks a waiting user with a rejection', async (): Promise<void> => {
        const app = await startTestApp();
        const host = connect(app.url, 'host');
        const hostAccepted = nextEvent(host, ServerEvents.Connection.Accepted);
        host.connect();
        await hostAccepted;

        const target = connect(app.url, 'target');
        const targetJoined = nextEvent(host, ServerEvents.WaitingRoom.Joined);
        const targetAccepted = nextEvent(
            target,
            ServerEvents.Connection.Accepted,
        );
        target.connect();
        await targetAccepted;
        const [waitingUser] = await targetJoined;

        const rejected = nextEvent(target, ServerEvents.Connection.Rejected);
        const gone = nextDisconnect(target);
        host.emit('admin:kick', waitingUser, 'kick test');

        expect(await rejected).toEqual(['kick test']);
        await gone;
    });

    it('bans the target ip: further connections are refused', async (): Promise<void> => {
        const app = await startTestApp();
        const host = connect(app.url, 'host');
        const hostAccepted = nextEvent(host, ServerEvents.Connection.Accepted);
        host.connect();
        await hostAccepted;

        const target = connect(app.url, 'bantarget');
        const targetJoined = nextEvent(host, ServerEvents.WaitingRoom.Joined);
        const targetAccepted = nextEvent(
            target,
            ServerEvents.Connection.Accepted,
        );
        target.connect();
        await targetAccepted;
        const [waitingUser] = await targetJoined;

        host.emit('admin:ban', waitingUser, 'ban test');

        // PRESERVED POLICY QUIRK: getIdenticalUsers scans the ADMINS room
        // only, so the disconnect loop hits identical-ip ADMIN members (on
        // loopback that is the host), the waiting-room target itself is not
        // disconnected, but the ip is banned either way. Do not "fix" here,
        // flagged for policy review.
        await nextDisconnect(host);

        // Same loopback ip: no admission anymore.
        const newcomer = connect(app.url, 'newcomer');
        newcomer.connect();
        await nextDisconnect(newcomer);
    });
});

describe('HTTP fallback', (): void => {
    it('answers readiness on / and 404s other paths', async (): Promise<void> => {
        const app = await startTestApp();

        const ready = await fetch(app.url);
        expect(ready.status).toBe(200);
        expect(await ready.text()).toBe('Project Panopticon');

        const missing = await fetch(`${app.url}/nope`);
        expect(missing.status).toBe(404);
    });
});

describe('admission edge cases with fake sockets', (): void => {
    it('cannot reserve host status twice across concurrent first connections', async (): Promise<void> => {
        const lines: string[] = [];
        const stream: Record<string, unknown> = {
            write: (chunk: string): boolean => {
                lines.push(chunk);
                return true;
            },
        };
        stream['isTTY'] = false;
        const app = createApplication({
            output: stream as unknown as NodeJS.WriteStream,
        });

        // Joins resolve slowly, both admissions run concurrently before
        // either finishes joining.
        const slowJoin = (): Promise<void> =>
            new Promise<void>((resolve): void => {
                setTimeout(resolve, 20);
            });

        const socketA = new FakeSocket('race-a', {
            auth: { username: 'alice' },
            joinBehavior: slowJoin,
        });
        const socketB = new FakeSocket('race-b', {
            auth: { username: 'bob' },
            joinBehavior: slowJoin,
        });

        const first = app.handleConnection(asServerSocket(socketA));
        const second = app.handleConnection(asServerSocket(socketB));
        await Promise.all([first, second]);

        const admins = app.rooms.Admins.getUserList();
        expect(admins).toHaveLength(1);
        expect(
            app.rooms.Cinema.getUserList().filter((entry) => entry.isAdmin),
        ).toHaveLength(1);
    });

    it('releases the username when the first admission cannot join', async (): Promise<void> => {
        const lines: string[] = [];
        const stream: Record<string, unknown> = {
            write: (chunk: string): boolean => {
                lines.push(chunk);
                return true;
            },
        };
        stream['isTTY'] = false;
        const app = createApplication({
            output: stream as unknown as NodeJS.WriteStream,
        });

        const joinFails = (): Promise<void> =>
            Promise.reject(new Error('adapter unavailable'));
        const broken = new FakeSocket('broken', {
            auth: { username: 'ghost' },
            joinBehavior: joinFails,
        });

        await app.handleConnection(asServerSocket(broken));

        expect(app.rooms.Admins.isEmpty()).toBe(true);
        expect(app.rooms.WaitingRoom.isEmpty()).toBe(true);

        // The username is not stuck: a healthy connection can claim it.
        const healthy = new FakeSocket('healthy', {
            auth: { username: 'ghost' },
        });
        await app.handleConnection(asServerSocket(healthy));
        expect(healthy.emitted).toContain(ServerEvents.Connection.Accepted);
    });
});
