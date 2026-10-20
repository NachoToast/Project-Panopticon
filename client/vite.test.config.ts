import { defineConfig } from 'vite';

// Test-only Vite config for browser-test builds (consumed by the Playwright
// webServer). It serves fixture media from a fixture publicDir and redirects
// the settings.json import to a test-only module that reads the page's
// ?media= query parameter (fixture allowlist) and exposes the issue store
// for assertions — the user's client/settings.json and client/public/data/
// are never read or written during tests.
const FIXTURE_SETTINGS_PATH = decodeURIComponent(
    new URL('./tests/fixtures/testSettings.ts', import.meta.url).pathname,
);

export default defineConfig({
    publicDir: 'tests/fixtures/public',
    resolve: {
        alias: [
            {
                find: '../settings.json',
                replacement: FIXTURE_SETTINGS_PATH,
            },
        ],
    },
    server: {
        // 1732 (not the dev server's 1730) so a running dev server can
        // never be silently reused for tests (fixture alias vs. real
        // settings); matches playwright.config.ts.
        port: 1732,
        strictPort: true,
    },
});
