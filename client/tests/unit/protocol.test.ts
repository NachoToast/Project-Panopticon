import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
    ClientEvents,
    CommandRejection,
    isCommandRejection,
    isMediaId,
    isPlaybackCommand,
    isPlaybackSnapshot,
    MAX_MEDIA_ID_LENGTH,
    MAX_POSITION_SECONDS,
    normalizeMediaId,
    PlaybackCommand,
    PlaybackSnapshot,
    ServerEvents,
} from '../../src/shared';

// The playback wire contract: runtime guards, media identity normalization,
// new event pins, and the client/server mirror invariant. Guards validate
// SHAPE, not TypeScript types — Socket.IO delivers whatever a peer sends.

const VALID_COMMAND: PlaybackCommand = { mediaId: 'movie.mp4', position: 42 };

const VALID_SNAPSHOT: PlaybackSnapshot = {
    mediaId: 'movie.mp4',
    playing: true,
    position: 42,
    revision: 3,
};

describe('playback payload guards', (): void => {
    it('accepts a valid snapshot', (): void => {
        expect(isPlaybackSnapshot(VALID_SNAPSHOT)).toBe(true);
    });

    it('accepts a snapshot with a null mediaId (nothing selected)', (): void => {
        expect(
            isPlaybackSnapshot({ mediaId: null, playing: false, position: 0, revision: 0 }),
        ).toBe(true);
    });

    it.each([
        ['null', null],
        ['an array', [VALID_SNAPSHOT]],
        ['a boolean', true],
        ['a string', 'playing'],
        ['missing mediaId', { playing: false, position: 0, revision: 0 }],
        ['missing playing', { mediaId: null, position: 0, revision: 0 }],
        ['missing position', { mediaId: null, playing: false, revision: 0 }],
        ['missing revision', { mediaId: null, playing: false, position: 0 }],
        ['non-string mediaId', { ...VALID_SNAPSHOT, mediaId: 42 }],
        ['non-boolean playing', { ...VALID_SNAPSHOT, playing: 'true' }],
        ['undefined playing', { ...VALID_SNAPSHOT, playing: undefined }],
        ['NaN position', { ...VALID_SNAPSHOT, position: Number.NaN }],
        ['Infinity position', { ...VALID_SNAPSHOT, position: Number.POSITIVE_INFINITY }],
        ['negative position', { ...VALID_SNAPSHOT, position: -0.5 }],
        ['position beyond the cap', { ...VALID_SNAPSHOT, position: MAX_POSITION_SECONDS + 1 }],
        ['non-integer revision', { ...VALID_SNAPSHOT, revision: 1.5 }],
        ['negative revision', { ...VALID_SNAPSHOT, revision: -1 }],
        ['huge revision', { ...VALID_SNAPSHOT, revision: 2 ** 53 }],
        ['string revision', { ...VALID_SNAPSHOT, revision: '3' }],
        ['empty mediaId', { ...VALID_SNAPSHOT, mediaId: '' }],
        ['oversized mediaId', { ...VALID_SNAPSHOT, mediaId: 'a'.repeat(MAX_MEDIA_ID_LENGTH + 1) }],
        ['bad-charset mediaId', { ...VALID_SNAPSHOT, mediaId: 'a b.mp4' }],
        ['unicode mediaId', { ...VALID_SNAPSHOT, mediaId: '电影.mp4' }],
        ['parent-segment mediaId', { ...VALID_SNAPSHOT, mediaId: '../evil.mp4' }],
    ])('rejects %s', (_label: string, value: unknown): void => {
        expect(isPlaybackSnapshot(value)).toBe(false);
    });

    it('allows extra fields (forward compatibility; documented choice)', (): void => {
        expect(isPlaybackSnapshot({ ...VALID_SNAPSHOT, extra: 'ignored' })).toBe(true);
    });

    it('accepts a valid command', (): void => {
        expect(isPlaybackCommand(VALID_COMMAND)).toBe(true);
    });

    it.each([
        ['null', null],
        ['an array', [VALID_COMMAND]],
        ['a string', 'play'],
        ['missing mediaId', { position: 0 }],
        ['missing position', { mediaId: 'movie.mp4' }],
        ['null mediaId', { mediaId: null, position: 0 }],
        ['NaN position', { mediaId: 'movie.mp4', position: Number.NaN }],
        ['negative position', { mediaId: 'movie.mp4', position: -1 }],
        ['empty mediaId', { mediaId: '', position: 0 }],
        ['bad-charset mediaId', { mediaId: 'movie .mp4', position: 0 }],
        ['oversized mediaId', { mediaId: 'a'.repeat(MAX_MEDIA_ID_LENGTH + 1), position: 0 }],
    ])('rejects %s as a command', (_label: string, value: unknown): void => {
        expect(isPlaybackCommand(value)).toBe(false);
    });

    it('allows extra fields on commands too', (): void => {
        expect(isPlaybackCommand({ ...VALID_COMMAND, extra: 1 })).toBe(true);
    });
});

describe('isMediaId and isCommandRejection', (): void => {
    it('accepts plain filenames and slash-separated relative paths', (): void => {
        expect(isMediaId('movie.mp4')).toBe(true);
        expect(isMediaId('films/dir.two/movie_1.mp4')).toBe(true);
    });

    it('rejects blank, oversized, and hostile mediaIds', (): void => {
        expect(isMediaId('')).toBe(false);
        expect(isMediaId('a'.repeat(MAX_MEDIA_ID_LENGTH + 1))).toBe(false);
        expect(isMediaId('movie .mp4')).toBe(false);
        expect(isMediaId('a/../b.mp4')).toBe(false);
    });

    it('accepts every defined rejection and rejects garbage', (): void => {
        const rejections: readonly CommandRejection[] = [
            'invalid-command',
            'wrong-media',
            'not-authorized',
            'not-in-cinema',
        ];
        for (const rejection of rejections) {
            expect(isCommandRejection(rejection)).toBe(true);
        }
        expect(isCommandRejection('nope')).toBe(false);
        expect(isCommandRejection(null)).toBe(false);
    });
});

describe('normalizeMediaId', (): void => {
    it('keeps an already-normal identity', (): void => {
        expect(normalizeMediaId('movie.mp4')).toBe('movie.mp4');
    });

    it('trims surrounding whitespace', (): void => {
        expect(normalizeMediaId('  movie.mp4\n')).toBe('movie.mp4');
    });

    it('strips a leading ./ segment', (): void => {
        expect(normalizeMediaId('./movie.mp4')).toBe('movie.mp4');
    });

    it('strips repeated leading ./ segments', (): void => {
        expect(normalizeMediaId('././movie.mp4')).toBe('movie.mp4');
    });

    it('strips leading slashes exposed after ./ stripping', (): void => {
        expect(normalizeMediaId('.//movie.mp4')).toBe('movie.mp4');
        expect(normalizeMediaId('//movie.mp4')).toBe('movie.mp4');
    });

    it('collapses duplicate slashes', (): void => {
        expect(normalizeMediaId('a//b.mp4')).toBe('a/b.mp4');
        expect(normalizeMediaId('a///b////c.mp4')).toBe('a/b/c.mp4');
    });

    it('rejects parent-directory segments anywhere', (): void => {
        expect(normalizeMediaId('../evil')).toBeNull();
        expect(normalizeMediaId('a/../b.mp4')).toBeNull();
        expect(normalizeMediaId('a/b/../../c.mp4')).toBeNull();
    });

    it('rejects blank input', (): void => {
        expect(normalizeMediaId('')).toBeNull();
        expect(normalizeMediaId('   ')).toBeNull();
    });

    it('rejects identities over the length cap (applied post-normalization)', (): void => {
        expect(normalizeMediaId('a'.repeat(MAX_MEDIA_ID_LENGTH))).toBe('a'.repeat(MAX_MEDIA_ID_LENGTH));
        expect(normalizeMediaId('a'.repeat(MAX_MEDIA_ID_LENGTH + 1))).toBeNull();
        // Collapsing duplicate slashes brings this one back to exactly the cap.
        expect(normalizeMediaId(`a//${'b'.repeat(MAX_MEDIA_ID_LENGTH - 2)}`)).toBe(
            `a/${'b'.repeat(MAX_MEDIA_ID_LENGTH - 2)}`,
        );
    });

    it('rejects non-charset characters surviving normalization', (): void => {
        expect(normalizeMediaId('my movie.mp4')).toBeNull();
        expect(normalizeMediaId('movie.mp4?x=1')).toBeNull();
    });

    it('never throws on hostile runtime input (JS callers bypass types)', (): void => {
        expect(normalizeMediaId(undefined as unknown as string)).toBeNull();
        expect(normalizeMediaId(42 as unknown as string)).toBeNull();
    });
});

describe('playback event pins', (): void => {
    it('pins the new cinema playback event names', (): void => {
        expect(ClientEvents.Cinema.Select).toBe('cinema:select');

        expect(ServerEvents.Cinema.State).toBe('cinema:state');
        expect(ServerEvents.Cinema.CommandRejected).toBe('cinema:command-rejected');
    });
});

describe('client/server mirror invariant', (): void => {
    // The shared/ copies are synced MANUALLY; these byte-for-byte checks fail
    // the moment one side drifts, whichever side runs them.
    const THIS = 'client';
    const OTHER = 'server';
    // OTHER_PATH assumes the fixed monorepo layout (sibling workspaces).
    const OTHER_PATH = '../../../server/src/shared';

    it.each([
        ['PlaybackState.ts'],
        ['ClientEvents.ts'],
        ['ServerEvents.ts'],
        ['index.ts'],
    ])('keeps %s byte-identical in both workspaces', (file: string): void => {
        const ours = readFileSync(new URL(`../../src/shared/${file}`, import.meta.url), 'utf8');
        const theirs = readFileSync(new URL(`${OTHER_PATH}/${file}`, import.meta.url), 'utf8');
        expect(ours, `${THIS} copy of ${file} must equal the ${OTHER} copy`).toBe(theirs);
    });
});
