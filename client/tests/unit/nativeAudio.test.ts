import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Why source-level pins remain: movie.ts grabs the DOM at module scope, so a
 * Node test cannot import it without a DOM simulator, which this suite
 * forbids. The playback logic itself moved into playback/controller.ts and
 * is behaviorally covered through the player harness (volume persistence,
 * admission restore); what is pinned HERE is only what still cannot be
 * executed in Node — the wiring-level guarantees.
 */

const controllerSources: string = [
    readFileSync(fileURLToPath(new URL('../../src/controllers/movie.ts', import.meta.url)), 'utf8'),
    ...readdirSync(fileURLToPath(new URL('../../src/playback', import.meta.url)))
        .filter((file) => file.endsWith('.ts'))
        .map((file) =>
            readFileSync(fileURLToPath(new URL(`../../src/playback/${file}`, import.meta.url)), 'utf8'),
        ),
].join('\n');

/** The whole playback path: wiring + controller + clock + error tables. */
const WEB_AUDIO_GRAPH = /\b(?:AudioContext|createMediaElementSource|createGain|GainNode)\b/;

const movieWiring: string = readFileSync(
    fileURLToPath(new URL('../../src/controllers/movie.ts', import.meta.url)),
    'utf8',
);

describe('native audio playback', (): void => {
    it('keeps the playback path free of any Web Audio graph', (): void => {
        // element.volume is the only volume pathway (no hidden loudness
        // multiplier) across the wiring AND the playback modules.
        expect(WEB_AUDIO_GRAPH.test(controllerSources)).toBe(false);
    });

    it('persists volume through the safe storage wrapper at the wiring edge', (): void => {
        // The wiring-level guarantee: preferences go through safeStorage
        // (contained failures, StorageUnavailable reporting). The controller
        // behavior (restore on admission, persist on volumechange) is
        // covered behaviorally in playerLifecycle.test.ts.
        expect(movieWiring).toContain('readStoredNumber');
        expect(movieWiring).toContain('writeStoredString');
    });
});
