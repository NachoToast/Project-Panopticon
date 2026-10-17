import { createApplication } from './app.js';

/**
 * Test only server startup for the browser suite. Production startup lives
 * in src/index.ts. This variant listens on an ephemeral port (or PORT from
 * the environment, used when a test restarts a server on the same port) and
 * prints one readiness line the test fixture scans stdout for:
 *
 *     PANOPTICON TEST SERVER READY port=54321
 *
 * Run: node --import tsx src/test-server.ts
 */

const requestedPort = Number(process.env['PORT'] ?? '0');

const app = createApplication();

app.httpServer.listen(requestedPort, () => {
    const address = app.httpServer.address();
    const port = typeof address === 'object' && address !== null ? address.port : requestedPort;
    process.stdout.write(`PANOPTICON TEST SERVER READY port=${String(port)}\n`);
});

function shutdown(): void {
    app.close().then(
        (): void => {
            process.exit(0);
        },
        (): void => {
            process.exit(1);
        },
    );
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
