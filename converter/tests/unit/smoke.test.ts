import { describe, expect, it } from 'bun:test';
import { doTranscode } from '../../src/doTranscode';

// Harness smoke test: proves the test setup can import and evaluate the
// converter's TypeScript sources.
describe('converter unit harness', (): void => {
    it('loads the transcode module', (): void => {
        expect(typeof doTranscode).toBe('function');
    });
});
