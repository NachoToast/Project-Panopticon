import { defineConfig, devices } from '@playwright/test';

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
    // firefox/webkit projects return in Task 9 with their own launch
    // options (chromium's --autoplay-policy flag is not universal).
    projects: [
        {
            name: 'chromium',
            use: {
                ...devices['Desktop Chrome'],
                launchOptions: {
                    args: [
                        // Media playback must not depend on a user gesture
                        // in the harness; interaction-gated starts are
                        // unit-tested through the controller's refused-play
                        // paths instead. (Headless chromium stalls AUDIBLE
                        // media clocks; specs mute the element instead.)
                        '--autoplay-policy=no-user-gesture-required',
                    ],
                },
            },
        },
    ],
});
