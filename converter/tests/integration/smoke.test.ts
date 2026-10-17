import { describe, expect, it } from 'bun:test';

// The converter shells out to ffmpeg, so integration tests cannot run without
// it on PATH.
describe('converter integration prerequisites', (): void => {
    it('has ffmpeg on PATH', (): void => {
        expect(Bun.which('ffmpeg')).not.toBeNull();
    });
});
