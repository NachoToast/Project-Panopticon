// Production static server for the built client (dist/), wired up by the
// package.json `start` script (start.sh calls `pnpm start`). It replaces
// `vite preview`, whose static handler (Vite 8.0.16) mishandles byte ranges
// (`bytes=0-0` returns the whole file; suffix ranges like `bytes=-128` return
// the wrong slice) and lets missing files fall through to the SPA fallback
// with status 200 — both fatal for media playback against a real build. The
// HTTP contract is pinned by tests/http/mediaServing.test.ts, which imports
// this module directly.

import { createServer } from 'node:http';
import { existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import serveHandler from 'serve-handler';

const DEFAULT_PORT = 1730;
// 0.0.0.0 preserves the old `vite preview --host` LAN behavior: other
// devices on the network can join the cinema.
const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), 'dist');

// Matches when any path segment starts with a dot (.env, .git/HEAD,
// .DS_Store, …). serve-handler hides dotfiles only from directory listings
// (which are disabled below) but serves them on direct request, so they are
// rejected here, before the request reaches the handler.
const HIDDEN_SEGMENT = /(?:^|\/)\./;

// Cache policy (later rules overwrite earlier ones, most specific last):
// - /**: always revalidate, so rebuilt assets/settings are picked up on
//   every load.
// - /assets/**: content-hashed filenames — safe to cache immutably for a
//   year.
// - /data/** (media): revalidate on use. serve-handler's strong-ETag option
//   hashes the ENTIRE file (unacceptable for multi-GB movies), so ETags stay
//   off and revalidation uses Last-Modified — weak semantics, by design.
const CACHE_RULES = [
    { source: '/**', headers: [{ key: 'Cache-Control', value: 'no-cache, must-revalidate' }] },
    {
        source: '/assets/**',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }],
    },
    {
        source: '/data/**',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=0, must-revalidate' }],
    },
];

/**
 * @param {string} root absolute directory to serve
 * @returns {import('serve-handler').ServeHandlerConfig} serve-handler config
 */
function handlerConfig(root) {
    return {
        public: root,
        cleanUrls: true, // `/` resolves to index.html; `/index.html` 301s to `/`
        directoryListing: false, // `/data/` must never enumerate files
        symlinks: false, // a symlink inside dist/ is a 404, not an escape hatch
        etag: false, // strong ETags hash whole files; Last-Modified instead
        headers: CACHE_RULES,
    };
}

/**
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:http').ServerResponse} response
 * @param {string} root absolute directory to serve
 * @returns {Promise<void>}
 */
async function handleRequest(request, response, root) {
    let pathname;
    try {
        pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://panopticon.local').pathname);
    } catch {
        response.statusCode = 400;
        response.end('Bad Request');
        return;
    }

    if (HIDDEN_SEGMENT.test(pathname)) {
        response.statusCode = 404;
        response.end('Not Found');
        return;
    }

    await serveHandler(request, response, handlerConfig(root));
}

/**
 * @typedef {object} StaticServerOptions
 * @property {string} [root] directory to serve (defaults to ./dist next to this script)
 * @property {number} [port] TCP port; 0 picks a free ephemeral port
 * @property {string} [host] listen address
 */

/**
 * @typedef {object} StaticServer
 * @property {string} origin `http://<host>:<port>` base URL
 * @property {number} port the actual port listened on
 * @property {string} host the actual listen address
 * @property {() => Promise<void>} close stop listening; rejects on close errors
 */

/**
 * Creates and STARTS the production static server.
 *
 * @param {StaticServerOptions} options
 * @returns {Promise<StaticServer>} resolves once the server is accepting connections
 */
export async function createStaticServer(options) {
    const root = resolve(options.root ?? DEFAULT_ROOT);
    if (!existsSync(root) || !statSync(root).isDirectory()) {
        throw new Error(
            `no production build found at ${root} — run "pnpm build" in client/ first (start.sh does this automatically)`,
        );
    }

    const port = options.port ?? DEFAULT_PORT;
    const host = options.host ?? DEFAULT_HOST;

    const server = createServer((request, response) => {
        handleRequest(request, response, root).catch(
            /**
             * @param {unknown} error
             * @returns {void}
             */
            (error) => {
                if (!response.headersSent) {
                    response.statusCode = 500;
                }
                response.end('Internal Server Error');
                console.error('request failed:', error);
            },
        );
    });

    // The `Promise<void>` cast lets `resolveListen()` be called with no
    // argument (TS2810 requires the JSDoc hint in checked JavaScript).
    await /** @type {Promise<void>} */ (
        new Promise((resolveListen, rejectListen) => {
            server.once('error', (error) => {
                const errno = /** @type {NodeJS.ErrnoException} */ (error);
                if (errno.code === 'EADDRINUSE') {
                    rejectListen(
                        new Error(
                            `port ${String(port)} is already in use on ${host} — another client instance? Set PORT to override.`,
                        ),
                    );
                    return;
                }
                rejectListen(error);
            });
            server.listen(port, host, () => {
                resolveListen();
            });
        })
    );

    const address = server.address();
    if (address === null || typeof address === 'string') {
        server.close();
        throw new Error(`could not determine the listening port (address: ${String(address)})`);
    }

    return {
        origin: `http://${host}:${String(address.port)}`,
        port: address.port,
        host: address.address,
        close: async () => {
            server.closeIdleConnections();
            await /** @type {Promise<void>} */ (
                new Promise((resolveClose, rejectClose) => {
                    server.close((error) => {
                        if (error === undefined) {
                            resolveClose();
                        } else {
                            rejectClose(error);
                        }
                    });
                })
            );
        },
    };
}

/**
 * CLI entry: PORT/HOST env overrides, readiness log, graceful shutdown.
 *
 * @returns {Promise<void>}
 */
async function main() {
    const portArgument = process.env['PORT'] ?? String(DEFAULT_PORT);
    const port = Number.parseInt(portArgument, 10);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error(`PORT must be an integer between 0 and 65535, got "${portArgument}"`);
    }
    const host = process.env['HOST'] ?? DEFAULT_HOST;

    const server = await createStaticServer({ port, host });
    console.log(
        `client production server listening on http://${server.host}:${String(server.port)} (serving ${DEFAULT_ROOT})`,
    );

    /** @returns {void} */
    const shutdown = () => {
        server
            .close()
            .then(() => {
                process.exit(0);
            })
            .catch(
                /**
                 * @param {unknown} error
                 * @returns {void}
                 */
                (error) => {
                    console.error('error while shutting down:', error);
                    process.exit(1);
                },
            );
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

// Run only when executed directly (`node serve.mjs`); imported uses (the
// vitest HTTP contract suite) must stay side-effect free.
if (process.argv['1'] !== undefined && import.meta.url === pathToFileURL(process.argv['1']).href) {
    main().catch(
        /**
         * @param {unknown} error
         * @returns {void}
         */
        (error) => {
            console.error(error instanceof Error ? error.message : error);
            process.exit(1);
        },
    );
}
