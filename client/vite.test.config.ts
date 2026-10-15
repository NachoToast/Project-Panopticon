import { defineConfig } from 'vite';

// Test-only Vite config for browser-test builds (consumed by the Playwright
// webServer). It serves fixture media from a fixture publicDir and redirects
// the settings.json import to a fixture so the user's client/settings.json
// and client/public/data/ are never read or written during tests.
const FIXTURE_SETTINGS_PATH = decodeURIComponent(
    new URL('./tests/fixtures/player-settings.json', import.meta.url).pathname,
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
        port: 1730,
        strictPort: true,
    },
});
