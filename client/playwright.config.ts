import { defineConfig, devices } from '@playwright/test';
import { ENGINE_LAUNCH_OPTIONS, ENGINE_NAMES, type EngineName } from './tests/browser/engineLaunch';

/** Device descriptor per engine for the default `page` fixture. */
const ENGINE_DEVICES: Readonly<Record<EngineName, keyof typeof devices>> = {
    chromium: 'Desktop Chrome',
    firefox: 'Desktop Firefox',
    webkit: 'Desktop Safari',
};

// Browser tests run serially (workers: 1) and each test spawns its OWN room
// server on an ephemeral port (see tests/browser/roomServer.ts), so cinema
// state never bleeds between tests. The one shared process is the client
// dev server below, serving fixture media through vite.test.config.ts.
export default defineConfig({
    testDir: 'tests/browser',
    timeout: 45_000,
    fullyParallel: false,
    workers: 1,
    retries: 0,
    // list: every skip is visible in plain stdout, including the
    // [capability-probe] summary lines the playback suite logs per
    // engine — the only skip evidence a CI log shows. html: writes
    // playwright-report/ for local debugging and the CI artifact
    // upload (never auto-opens a browser window).
    reporter: [['list'], ['html', { open: 'never' }]],
    use: {
        baseURL: 'http://localhost:1732',
        trace: 'retain-on-failure',
    },
    webServer: {
        command: 'pnpm exec vite --config vite.test.config.ts',
        url: 'http://localhost:1732',
        // 1732 (not the dev server's 1730): reuseExistingServer must never
        // silently adopt a running DEV server, which serves real settings
        // and real media instead of the fixture alias.
        reuseExistingServer: !process.env['CI'],
        timeout: 30_000,
    },
    // All three engines run the full suite. The engine set, per-engine
    // launch options (chromium's autoplay flag, firefox's autoplay
    // prefs), and device descriptors live in one place:
    // tests/browser/engineLaunch.ts drives the projects table, and the
    // playback suite launches its own per-test browsers through that
    // module; the options below cover the default `page` fixture used
    // by the smoke test.
    projects: ENGINE_NAMES.map((engine: EngineName) => ({
        name: engine,
        use: {
            ...devices[ENGINE_DEVICES[engine]],
            launchOptions: ENGINE_LAUNCH_OPTIONS[engine],
        },
    })),
});
