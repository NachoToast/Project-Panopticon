import { defineConfig, devices } from '@playwright/test';
import { ENGINE_LAUNCH_OPTIONS } from './tests/browser/engineLaunch';

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
    reporter: [['list']],
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
    // All three engines run the full suite. Per-engine launch options
    // (chromium's autoplay flag, firefox's autoplay prefs) live in one
    // place: tests/browser/engineLaunch.ts. The playback suite launches
    // its own per-test browsers through that module; the options below
    // cover the default `page` fixture used by the smoke test.
    projects: [
        {
            name: 'chromium',
            use: {
                ...devices['Desktop Chrome'],
                launchOptions: ENGINE_LAUNCH_OPTIONS.chromium,
            },
        },
        {
            name: 'firefox',
            use: {
                ...devices['Desktop Firefox'],
                launchOptions: ENGINE_LAUNCH_OPTIONS.firefox,
            },
        },
        {
            name: 'webkit',
            use: {
                ...devices['Desktop Safari'],
                launchOptions: ENGINE_LAUNCH_OPTIONS.webkit,
            },
        },
    ],
});
