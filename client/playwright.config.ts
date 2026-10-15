import { defineConfig, devices } from '@playwright/test';

// Browser tests run serially (workers: 1) because they share cinema state on
// the server under test. The webServer wiring is added alongside the browser
// test suite itself.
export default defineConfig({
    testDir: 'tests/browser',
    timeout: 30_000,
    fullyParallel: false,
    workers: 1,
    retries: 0,
    reporter: [['list']],
    use: {
        baseURL: 'http://localhost:1730',
        trace: 'retain-on-failure',
    },
    // firefox/webkit need their browsers installed first:
    //   pnpm --dir client exec playwright install firefox webkit
    // test:browser pins --project=chromium until both are installed.
    projects: [
        {
            name: 'chromium',
            use: { ...devices['Desktop Chrome'] },
        },
        {
            name: 'firefox',
            use: { ...devices['Desktop Firefox'] },
        },
        {
            name: 'webkit',
            use: { ...devices['Desktop Safari'] },
        },
    ],
});
