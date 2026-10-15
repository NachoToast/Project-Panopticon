import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const controllerSource: string = readFileSync(
    fileURLToPath(new URL('../../src/controllers/movie.ts', import.meta.url)),
    'utf8',
);

/**
 * Why source-level pins: movie.ts queries the DOM at module scope (until Task 6
 * restructures the controller), so a Node test cannot import it without a DOM
 * simulator, which this suite forbids. Until then, asserting on the module
 * source is the honest guard: the absence pin below mirrors the task's final
 * grep gate and proves the playback path contains no Web Audio graph, meaning
 * element.volume is the only volume pathway (no hidden loudness multiplier).
 */
const WEB_AUDIO_GRAPH = /\b(?:AudioContext|createMediaElementSource|createGain|GainNode)\b/;

describe('native audio playback', (): void => {
    it('keeps the playback path free of any Web Audio graph', (): void => {
        expect(WEB_AUDIO_GRAPH.test(controllerSource)).toBe(false);
    });

    it('persists volume changes natively through the safe storage wrapper', (): void => {
        // Regression pin (already true since the storage adoption): the native
        // volumechange handler must only persist, never re-route audio.
        expect(controllerSource).toContain('onvolumechange');
        expect(controllerSource).toContain('writeStoredString');
    });
});
