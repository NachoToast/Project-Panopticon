import { defineConfig } from 'vitest/config';

// Node-environment unit tests only; DOM/media/UI behavior is covered by the
// Playwright browser tests. No DOM simulator (jsdom/happy-dom) is used.
export default defineConfig({
    test: {
        environment: 'node',
        include: ['tests/{unit,http}/**/*.test.ts'],
    },
});
