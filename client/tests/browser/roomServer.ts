import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Browser-test room server: spawns the REAL application (createApplication
 * via server/src/test-server.ts, executed with tsx) on an ephemeral port
 * and exposes kill/restart for disconnect-recovery scenarios. One server
 * per test keeps cinema state isolated (the first connector is the host).
 */

const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'server');

const READY_PATTERN = /PANOPTICON TEST SERVER READY port=(\d+)/;

const START_TIMEOUT_MS = 20_000;
const EXIT_TIMEOUT_MS = 10_000;

export interface RoomServer {
    /** The port the server listens on. */
    readonly port: number;
    /** Stops the server (graceful SIGTERM, SIGKILL fallback). */
    kill(): Promise<void>;
    /** Kills and starts a fresh server on the SAME port. */
    restart(): Promise<void>;
}

function waitForExit(child: ChildProcess): Promise<void> {
    return new Promise<void>((resolve: () => void): void => {
        const timer = setTimeout((): void => {
            child.kill('SIGKILL');
        }, EXIT_TIMEOUT_MS);
        child.once('exit', (): void => {
            clearTimeout(timer);
            resolve();
        });
        if (child.exitCode !== null) {
            clearTimeout(timer);
            resolve();
        }
    });
}

/** Spawns one server process; resolves with its actual listen port. */
function spawnServer(port: number): { child: ChildProcess; started: Promise<number> } {
    const child = spawn('node', ['--import', 'tsx', 'src/test-server.ts'], {
        cwd: SERVER_DIR,
        env: { ...process.env, PORT: String(port) },
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    const started = new Promise<number>((resolve: (port: number) => void, reject: (error: Error) => void): void => {
        let buffer = '';
        const timer = setTimeout((): void => {
            // Never leave an orphan behind: the child is still running
            // when readiness times out, so kill it before rejecting.
            child.kill('SIGKILL');
            reject(new Error('test server did not report readiness in time'));
        }, START_TIMEOUT_MS);

        child.stdout.on('data', (chunk: Buffer): void => {
            buffer += chunk.toString('utf8');
            const match = READY_PATTERN.exec(buffer);
            if (match !== null) {
                clearTimeout(timer);
                resolve(Number(match[1]));
            }
        });
        child.once('exit', (code: number | null): void => {
            clearTimeout(timer);
            reject(new Error(`test server exited before readiness (code ${String(code)})`));
        });
        child.once('error', (error: Error): void => {
            clearTimeout(timer);
            reject(error);
        });
    });

    return { child, started };
}

/** Starts an isolated room server on an ephemeral port. */
export async function startRoomServer(): Promise<RoomServer> {
    const first = spawnServer(0);
    const port = await first.started;

    let child = first.child;

    async function kill(): Promise<void> {
        child.kill('SIGTERM');
        await waitForExit(child);
    }

    return {
        port,
        kill,
        restart: async (): Promise<void> => {
            await kill();
            const next = spawnServer(port);
            child = next.child;
            await next.started;
        },
    };
}
