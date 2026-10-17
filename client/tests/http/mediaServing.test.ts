import { type ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { request } from 'node:http';
import { type Server, createServer as createNetServer } from 'node:net';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, afterAll, beforeAll, expect, it } from 'vitest';

// HTTP contract for the PRODUCTION static server (the client `start`
// script). The suite is launcher-injected: the contract below is written
// against ANY locally-launched static server over a real socket. The
// default target is serve.mjs, imported directly. HTTP_CONTRACT_TARGET=
// vite-preview replays the contract against the PREVIOUS production
// server (`vite preview`) for regression comparison and is EXPECTED TO
// FAIL: observed against Vite 8.0.16, `bytes=0-0` returned the entire
// file, suffix ranges returned the wrong slice, and missing media fell
// through to the SPA index.html with status 200.
//
// The fixture is a hand-constructed dist directory in a temp location —
// the unit under test is the SERVER, not the bundler. The one real
// artifact is the media file tests/fixtures/public/data/red.mp4
// (bootstrap: node client/tests/scripts/generate-media.mjs).

const CLIENT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURE_MEDIA_PATH = join(CLIENT_DIR, 'tests', 'fixtures', 'public', 'data', 'red.mp4');
const REPO_LOCKFILE_PATH = join(CLIENT_DIR, '..', 'pnpm-lock.yaml');

/** Marker that must only ever appear in responses served from fixture files. */
const INDEX_MARKER = 'panopticon-media-serving-contract';
const ENV_SECRET = 'PANOPTICON_HTTP_CONTRACT_SECRET';
const ASSET_NAME = 'app-DHw3fK9z.js';
const NESTED_ASSET_NAME = 'poster-DHw3fK9z.png';

const READY_TIMEOUT_MS = 30_000;
const EXIT_TIMEOUT_MS = 10_000;

interface ServerHandle {
    readonly origin: string;
    close(): Promise<void>;
}

type StaticServerLauncher = (rootDir: string) => Promise<ServerHandle>;

/** Ask the OS for a currently free port (bind 0, read it, release it). */
function ephemeralPort(): Promise<number> {
    return new Promise<number>((resolve: (port: number) => void, reject: (error: Error) => void): void => {
        const probe: Server = createNetServer();
        probe.once('error', (error: Error): void => {
            reject(error);
        });
        probe.listen(0, '127.0.0.1', (): void => {
            const address = probe.address();
            const port = typeof address === 'object' && address !== null ? address.port : 0;
            probe.close((): void => {
                resolve(port);
            });
        });
    });
}

function sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve: () => void): void => {
        setTimeout(resolve, ms);
    });
}

/** Poll until the origin answers any request; recursion, not a poll loop. */
async function waitForOrigin(origin: string, deadlineMs: number): Promise<void> {
    if (Date.now() > deadlineMs) {
        throw new Error(`server at ${origin} did not become ready within ${String(READY_TIMEOUT_MS)}ms`);
    }
    try {
        await fetch(origin, { redirect: 'manual' });
    } catch {
        await sleep(200);
        await waitForOrigin(origin, deadlineMs);
    }
}

function killTree(child: ChildProcess): Promise<void> {
    return new Promise<void>((resolve: () => void): void => {
        let settled = false;
        /** Idempotent: whichever of exit/already-dead/timeout fires first wins. */
        const settle = (): void => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            resolve();
        };
        // Last resort: force-kill AND settle — a child that died before this
        // point never emits 'exit' again, so the timer must resolve too or
        // afterAll hangs forever. (settle may only run after this line, so
        // the late `const timer` it closes over is safe.)
        const timer = setTimeout((): void => {
            child.kill('SIGKILL');
            settle();
        }, EXIT_TIMEOUT_MS);
        child.once('exit', settle);
        child.kill('SIGTERM');
        // Already-exited children never re-emit 'exit'. exitCode is null when
        // death was by signal, so signalCode must be checked as well.
        if (child.exitCode !== null || child.signalCode !== null) {
            settle();
        }
    });
}

/**
 * The PREVIOUS production server: `vite preview` serving a fixture dist.
 * Expected to FAIL the contract (see the file comment for the observed
 * defects); kept only for regression comparison.
 */
const launchVitePreview: StaticServerLauncher = async (rootDir: string): Promise<ServerHandle> => {
    const port = await ephemeralPort();
    const child = spawn(
        'pnpm',
        [
            'exec',
            'vite',
            'preview',
            '--host',
            '127.0.0.1',
            '--port',
            String(port),
            '--strictPort',
            '--outDir',
            rootDir,
        ],
        { cwd: CLIENT_DIR, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    child.stderr.on('data', (): void => {
        // Drain so a chatty preview server can never block on a full pipe.
    });
    const origin = `http://127.0.0.1:${String(port)}`;
    await waitForOrigin(origin, Date.now() + READY_TIMEOUT_MS);
    return {
        origin,
        close: async (): Promise<void> => {
            await killTree(child);
        },
    };
};

/**
 * The production server: serve.mjs, imported directly so the suite tests the
 * exact code the `start` script runs.
 */
const launchServeMjs: StaticServerLauncher = async (rootDir: string): Promise<ServerHandle> => {
    const { createStaticServer } = await import('../../serve.mjs');
    const server = await createStaticServer({ root: rootDir, host: '127.0.0.1', port: 0 });
    return {
        origin: server.origin,
        close: server.close,
    };
};

const target = process.env['HTTP_CONTRACT_TARGET'] ?? 'serve';
if (target !== 'serve' && target !== 'vite-preview') {
    throw new Error(`unknown HTTP_CONTRACT_TARGET "${target}" (expected "serve" or "vite-preview")`);
}
const launcher: StaticServerLauncher = target === 'vite-preview' ? launchVitePreview : launchServeMjs;

/**
 * Sends a RAW request path (no WHATWG-URL normalization, so `/../` and
 * `%2e%2e` reach the server verbatim as they would from a hostile client).
 */
function rawGet(port: number, rawPath: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve: (value: { status: number; body: string }) => void, reject: (error: Error) => void): void => {
        const outbound = request({ host: '127.0.0.1', port, path: rawPath, method: 'GET' }, (response): void => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', (chunk: string): void => {
                body += chunk;
            });
            response.on('end', (): void => {
                resolve({ status: response.statusCode ?? 0, body });
            });
        });
        outbound.once('error', (error: Error): void => {
            reject(error);
        });
        outbound.end();
    });
}

describe(
    'production static server HTTP contract',
    { timeout: READY_TIMEOUT_MS + 5_000 },
    (): void => {
        let origin = '';
        let port = 0;
        let server: ServerHandle | null = null;
        let distRoot = '';
        let mediaBytes = new Uint8Array(0);

        beforeAll(async (): Promise<void> => {
            // Hand-built fixture dist: real media file, marker HTML, a fake
            // hashed asset, hidden files, and an escaping symlink.
            const tempRoot = mkdtempSync(join(tmpdir(), 'panopticon-http-contract-'));
            distRoot = join(tempRoot, 'dist');
            mkdirSync(join(distRoot, 'assets'), { recursive: true });
            mkdirSync(join(distRoot, 'data'), { recursive: true });
            mkdirSync(join(distRoot, '.git'), { recursive: true });
            writeFileSync(
                join(distRoot, 'index.html'),
                `<!doctype html><html><head><title>${INDEX_MARKER}</title></head><body><p>fixture index</p></body></html>`,
            );
            writeFileSync(join(distRoot, 'assets', ASSET_NAME), `console.log('${INDEX_MARKER}');\n`);
            // Nested hashed asset (assets/<dir>/<file>): real builds put
            // posters/fonts in subdirectories, so the immutable rule must
            // reach nested paths, not just flat ones.
            mkdirSync(join(distRoot, 'assets', 'media'), { recursive: true });
            writeFileSync(join(distRoot, 'assets', 'media', NESTED_ASSET_NAME), 'nested fixture asset\n');
            writeFileSync(join(distRoot, '.env'), `${ENV_SECRET}=1\n`);
            writeFileSync(join(distRoot, '.git', 'HEAD'), 'ref: refs/heads/main\n');
            copyFileSync(FIXTURE_MEDIA_PATH, join(distRoot, 'data', 'red.mp4'));
            // Absolute symlink to a REAL file outside the served root: a
            // server that follows symlinks would happily serve the lockfile.
            symlinkSync(REPO_LOCKFILE_PATH, join(distRoot, 'data', 'escape.mp4'));

            mediaBytes = new Uint8Array(readFileSync(join(distRoot, 'data', 'red.mp4')));

            server = await launcher(distRoot);
            origin = server.origin;
            const parsedOrigin = new URL(origin);
            port = Number(parsedOrigin.port);
        });

        afterAll(async (): Promise<void> => {
            await server?.close();
            if (distRoot !== '') {
                rmSync(distRoot, { recursive: true, force: true });
            }
        });

        /** GET with raw semantics (no redirect following). */
        async function get(path: string, headers?: Record<string, string>): Promise<Response> {
            const requestHeaders = headers === undefined ? {} : { headers };
            return fetch(`${origin}${path}`, { ...requestHeaders, redirect: 'manual' });
        }

        async function getBody(response: Response): Promise<Uint8Array> {
            return new Uint8Array(await response.arrayBuffer());
        }

        it('serves index.html at / with 200 text/html', async (): Promise<void> => {
            const response = await get('/');
            expect(response.status).toBe(200);
            expect(response.headers.get('content-type')).toContain('text/html');
            expect(await response.text()).toContain(INDEX_MARKER);

            // cleanUrls 301s the raw filename away — probe-verified chain is
            // TWO hops (/index.html -> /index -> /) before the document;
            // only the first hop is pinned here.
            const raw = await get('/index.html');
            expect(raw.status).toBe(301);
            expect(raw.headers.get('location')).toBe('/index');
        });

        it('answers bytes=0-0 with exactly the first byte', async (): Promise<void> => {
            const response = await get('/data/red.mp4', { Range: 'bytes=0-0' });
            expect(response.status).toBe(206);
            const body = await getBody(response);
            expect(body.length).toBe(1);
            expect(body[0]).toBe(mediaBytes[0]);
            expect(response.headers.get('content-range')).toBe(`bytes 0-0/${String(mediaBytes.length)}`);
        });

        it('answers a suffix range (bytes=-128) with exactly the FINAL 128 bytes', async (): Promise<void> => {
            const response = await get('/data/red.mp4', { Range: 'bytes=-128' });
            expect(response.status).toBe(206);
            const body = await getBody(response);
            expect(body.length).toBe(128);
            expect(body).toEqual(mediaBytes.subarray(mediaBytes.length - 128));
            expect(response.headers.get('content-range')).toBe(
                `bytes ${String(mediaBytes.length - 128)}-${String(mediaBytes.length - 1)}/${String(mediaBytes.length)}`,
            );
        });

        it('answers small and open-ended ranges correctly', async (): Promise<void> => {
            const probe = await get('/data/red.mp4', { Range: 'bytes=0-1' });
            expect(probe.status).toBe(206);
            expect(await getBody(probe)).toEqual(mediaBytes.subarray(0, 2));
            expect(probe.headers.get('content-length')).toBe('2');

            const openEnded = await get('/data/red.mp4', { Range: 'bytes=500-' });
            expect(openEnded.status).toBe(206);
            expect(await getBody(openEnded)).toEqual(mediaBytes.subarray(500));
            expect(openEnded.headers.get('content-range')).toBe(
                `bytes 500-${String(mediaBytes.length - 1)}/${String(mediaBytes.length)}`,
            );
            expect(openEnded.headers.get('accept-ranges')).toBe('bytes');
        });

        it('rejects an unsatisfiable range with 416 and bytes */total metadata', async (): Promise<void> => {
            const response = await get('/data/red.mp4', { Range: 'bytes=999999999-' });
            expect(response.status).toBe(416);
            expect(response.headers.get('content-range')).toBe(`bytes */${String(mediaBytes.length)}`);
        });

        it('answers HEAD with media headers and NO body', async (): Promise<void> => {
            const response = await fetch(`${origin}/data/red.mp4`, { method: 'HEAD', redirect: 'manual' });
            expect(response.status).toBe(200);
            expect(response.headers.get('content-type')).toBe('video/mp4');
            expect(response.headers.get('content-length')).toBe(String(mediaBytes.length));
            expect(response.body).toBeNull();
        });

        it('serves fixture media whole with the right type and length', async (): Promise<void> => {
            const response = await get('/data/red.mp4');
            expect(response.status).toBe(200);
            expect(response.headers.get('content-type')).toBe('video/mp4');
            expect(response.headers.get('content-length')).toBe(String(mediaBytes.length));
            const body = await getBody(response);
            expect(createHash('sha1').update(body).digest('hex')).toBe(
                createHash('sha1').update(mediaBytes).digest('hex'),
            );
        });

        it('returns a REAL 404 for missing media, never the SPA fallback', async (): Promise<void> => {
            const response = await get('/data/nope.mp4');
            expect(response.status).toBe(404);
            expect(await response.text()).not.toContain(INDEX_MARKER);
        });

        it('never enumerates the /data/ directory', async (): Promise<void> => {
            const response = await get('/data/');
            expect(response.status).toBe(404);
            expect(await response.text()).not.toContain('red.mp4');
        });

        it('does not serve raw or encoded path traversal', async (): Promise<void> => {
            const raw = await rawGet(port, '/../package.json');
            expect(raw.status).toBeGreaterThanOrEqual(400);
            expect(raw.body).not.toContain(INDEX_MARKER);

            const encoded = await rawGet(port, '/%2e%2e/package.json');
            expect(encoded.status).toBeGreaterThanOrEqual(400);

            const nested = await rawGet(port, '/data/%2e%2e/%2e%2e/pnpm-lock.yaml');
            expect(nested.status).toBeGreaterThanOrEqual(400);
            expect(nested.body).not.toContain('lockfileVersion');
        });

        it('does not serve hidden files', async (): Promise<void> => {
            const envResponse = await get('/.env');
            expect(envResponse.status).toBe(404);
            expect(await envResponse.text()).not.toContain(ENV_SECRET);

            const gitResponse = await get('/.git/HEAD');
            expect(gitResponse.status).toBe(404);
        });

        it('does not serve symlinks escaping the root', async (): Promise<void> => {
            const response = await get('/data/escape.mp4');
            expect(response.status).toBe(404);
            expect(await response.text()).not.toContain('lockfileVersion');
        });

        it('applies the production cache policy', async (): Promise<void> => {
            // HTML must always revalidate so rebuilt settings/assets are picked up.
            const html = await get('/');
            expect(html.headers.get('cache-control')).toContain('no-cache');
            expect(html.headers.get('cache-control')).toContain('must-revalidate');

            // Hashed build output is immutable and cacheable for a year.
            const asset = await get(`/assets/${ASSET_NAME}`);
            expect(asset.headers.get('cache-control')).toContain('max-age=31536000');
            expect(asset.headers.get('cache-control')).toContain('immutable');

            // The immutable rule reaches NESTED hashed assets
            // (assets/<dir>/<file>) too, not just flat ones.
            const nestedAsset = await get(`/assets/media/${NESTED_ASSET_NAME}`);
            expect(nestedAsset.status).toBe(200);
            expect(nestedAsset.headers.get('cache-control')).toContain('immutable');

            // Media revalidates on reuse (no whole-movie strong ETags by
            // design). Last-Modified is present for future/manual
            // revalidation — the handler ignores If-Modified-Since, so
            // conditional 304s remain a deferred gap (see serve.mjs).
            const media = await get('/data/red.mp4');
            expect(media.headers.get('cache-control')).toContain('must-revalidate');
            expect(media.headers.get('last-modified')).toBeTruthy();

            // Query strings (players append ?t=1 style offsets) still match
            // the media cache rule and serve the file.
            const seek = await get('/data/red.mp4?t=1');
            expect(seek.status).toBe(200);
            expect(seek.headers.get('cache-control')).toContain('must-revalidate');
        });
    },
);
