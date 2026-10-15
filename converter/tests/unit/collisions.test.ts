import { describe, expect, it } from 'bun:test';
import { findCaseInsensitiveOutputCollisions } from '../../src/main';

// M7: on a case-insensitive filesystem (default APFS/Darwin, NTFS/Windows),
// A.mp4 and a.mp4 are the SAME file. A batch whose inputs derive
// case-insensitively-equal outputs must be named as a collision UP FRONT,
// before any encoding work — the second file would otherwise clobber the
// first during promotion.

describe('findCaseInsensitiveOutputCollisions', (): void => {
    it('flags A.mkv + a.mkv as one collision naming both inputs and the output', (): void => {
        const collisions = findCaseInsensitiveOutputCollisions(
            ['/media/A.mkv', '/media/a.mkv'],
            '/media/transcoded',
        );

        expect(collisions).toHaveLength(1);
        expect([...collisions[0]!.inputs].sort()).toEqual([
            '/media/A.mkv',
            '/media/a.mkv',
        ]);
        expect(collisions[0]!.output.toLowerCase()).toBe(
            '/media/transcoded/a.mp4',
        );
    });

    it('flags mixed-case drift beyond the first letter', (): void => {
        const collisions = findCaseInsensitiveOutputCollisions(
            ['/media/Movie.mkv', '/media/mOVIE.mkv'],
            '/media/transcoded',
        );

        expect(collisions).toHaveLength(1);
    });

    it('does not flag distinct output names', (): void => {
        const collisions = findCaseInsensitiveOutputCollisions(
            ['/media/a.mkv', '/media/b.mkv', '/media/c.mp4'],
            '/media/transcoded',
        );

        expect(collisions).toEqual([]);
    });

    it('keeps separate collisions separate', (): void => {
        const collisions = findCaseInsensitiveOutputCollisions(
            ['/m/A.mkv', '/m/a.mkv', '/m/B.mkv', '/m/b.mkv'],
            '/m/out',
        );

        expect(collisions).toHaveLength(2);
    });
});
