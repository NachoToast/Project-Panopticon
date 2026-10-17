import { createApplication } from './app.js';

/**
 * Startup wiring only: read the port, create the application, listen, and
 * shut down gracefully on SIGINT/SIGTERM. All composition lives in
 * src/app.ts, and importing domain modules never starts a server.
 */

/** Grace period before a stuck connection can wedge shutdown. */
const SHUTDOWN_FORCE_EXIT_MS = 5_000;

const PORT = process.env['PORT'] ?? 5_000;

const app = createApplication();

app.httpServer.listen(PORT, () => {
    app.logger.info(`Running on http://localhost:${PORT.toString()}`);
});

function shutdown(): void {
    // A connection that refuses to drain gets a non-zero exit after the
    // grace period.
    const forceExit = setTimeout((): void => {
        app.logger.error(
            `graceful shutdown exceeded ${SHUTDOWN_FORCE_EXIT_MS.toString()}ms; forcing exit`,
        );
        process.exit(1);
    }, SHUTDOWN_FORCE_EXIT_MS);

    app.close().then(
        (): void => {
            clearTimeout(forceExit);
            process.exit(0);
        },
        (error: unknown): void => {
            clearTimeout(forceExit);
            app.logger.error('graceful shutdown failed', error);
            process.exit(1);
        },
    );
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
