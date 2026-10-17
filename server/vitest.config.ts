import { defineConfig } from 'vitest/config';

// Node-environment tests only; integration tests spin up in-process servers
// (see tests/helpers/testApp.ts).
export default defineConfig({
    test: {
        environment: 'node',
        include: ['tests/{unit,integration}/**/*.test.ts'],
    },
});
