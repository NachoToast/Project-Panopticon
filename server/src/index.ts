import { createApplication } from './app.js';

/**
 * Startup wiring only: read the port, create the application, listen, and
 * shut down gracefully on SIGINT/SIGTERM. All composition lives in
 * src/app.ts; importing domain modules never starts a server.
 */

const PORT = process.env['PORT'] ?? 5_000;

const app = createApplication();

app.httpServer.listen(PORT, () => {
    app.logger.info(`Running on http://localhost:${PORT.toString()}`);
});

function shutdown(): void {
    void app.close().finally(() => {
        process.exit(0);
    });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
