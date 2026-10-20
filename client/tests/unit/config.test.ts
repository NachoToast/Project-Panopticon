import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ISSUE_CATALOG } from '../../src/diagnostics/issues';
import { IssueCode, IssueDefinition } from '../../src/diagnostics/snapshot';
import {
    MovieSettings,
    readSocketOverride,
    resolveSocketUrl,
    SettingsProblem,
    SocketLocationLike,
    validateMovieSettings,
} from '../../src/config';

/** A plain Location stand-in, no DOM involved. */
function locationLike(protocol: string, hostname: string, port: string): SocketLocationLike {
    return { protocol, hostname, port, host: port === '' ? hostname : `${hostname}:${port}` };
}

describe('validateMovieSettings', (): void => {
    it('accepts the documented settings shape and trims padded values', (): void => {
        const result = validateMovieSettings({
            file: '  movie.mp4  ',
            type: 'video/mp4',
            subtitles: [{ label: 'English', srclang: 'en', file: 'english.vtt' }],
        });

        expect(result.problem).toBeNull();
        expect(result.settings).toEqual({
            file: 'movie.mp4',
            type: 'video/mp4',
            subtitles: [{ label: 'English', srclang: 'en', file: 'english.vtt' }],
        } satisfies MovieSettings);
    });

    it('accepts settings without a subtitles key or with an empty list', (): void => {
        expect(validateMovieSettings({ file: 'movie.mp4', type: 'video/mp4' }).settings?.subtitles).toEqual([]);
        expect(
            validateMovieSettings({ file: 'movie.mp4', type: 'video/mp4', subtitles: [] }).settings?.subtitles,
        ).toEqual([]);
    });

    it.each([
        ['missing file', { type: 'video/mp4' }],
        ['blank file', { file: '   ', type: 'video/mp4' }],
        ['non-string file', { file: 42, type: 'video/mp4' }],
        ['non-object settings', null],
    ])('rejects a %s with the file problem token', (_label: string, raw: unknown): void => {
        const result = validateMovieSettings(raw);
        expect(result.settings).toBeNull();
        expect(result.problem).toBe('file');
    });

    it.each([
        ['missing type', { file: 'movie.mp4' }],
        ['blank type', { file: 'movie.mp4', type: '' }],
        ['non-string type', { file: 'movie.mp4', type: ['video/mp4'] }],
    ])('rejects a %s with the type problem token', (_label: string, raw: unknown): void => {
        const result = validateMovieSettings(raw);
        expect(result.settings).toBeNull();
        expect(result.problem).toBe('type');
    });

    it.each([
        ['non-array subtitles', { file: 'movie.mp4', type: 'video/mp4', subtitles: 'english.vtt' }],
        ['non-object entry', { file: 'movie.mp4', type: 'video/mp4', subtitles: ['english.vtt'] }],
        ['missing label', { file: 'movie.mp4', type: 'video/mp4', subtitles: [{ srclang: 'en', file: 'e.vtt' }] }],
        ['blank srclang', { file: 'movie.mp4', type: 'video/mp4', subtitles: [{ label: 'En', srclang: ' ', file: 'e.vtt' }] }],
        ['missing file', { file: 'movie.mp4', type: 'video/mp4', subtitles: [{ label: 'En', srclang: 'en' }] }],
        ['null entry', { file: 'movie.mp4', type: 'video/mp4', subtitles: [null] }],
    ])('rejects %s with the subtitles problem token', (_label: string, raw: unknown): void => {
        const result = validateMovieSettings(raw);
        expect(result.settings).toBeNull();
        expect(result.problem).toBe('subtitles');
    });

    it('reports at most one problem token, never raw settings values', (): void => {
        const result = validateMovieSettings({ file: 'secret-movie.mp4', type: '' });

        const problem: SettingsProblem | null = result.problem;
        expect(problem === null || ['file', 'type', 'subtitles'].includes(problem)).toBe(true);
        expect(JSON.stringify(result)).not.toContain('secret-movie.mp4');
    });

    it('collapses a throwing getter on any field to that field problem token', (): void => {
        // Hostile-property standard (see snapshot.ts): reading a field must
        // let an exception escape. It collapses to the problem token.
        const hostileFile = {
            get file(): never {
                throw new Error('hostile getter');
            },
            type: 'video/mp4',
        };
        const hostileType = {
            file: 'movie.mp4',
            get type(): never {
                throw new Error('hostile getter');
            },
        };
        const hostileSubtitles = {
            file: 'movie.mp4',
            type: 'video/mp4',
            get subtitles(): never {
                throw new Error('hostile getter');
            },
        };

        expect(() => validateMovieSettings(hostileFile)).not.toThrow();
        expect(validateMovieSettings(hostileFile).problem).toBe('file');
        expect(validateMovieSettings(hostileType).problem).toBe('type');
        expect(validateMovieSettings(hostileSubtitles).problem).toBe('subtitles');
    });

    it('collapses a throwing getter on a subtitle entry field to the subtitles token', (): void => {
        const result = validateMovieSettings({
            file: 'movie.mp4',
            type: 'video/mp4',
            subtitles: [
                {
                    get label(): never {
                        throw new Error('hostile getter');
                    },
                    srclang: 'en',
                    file: 'e.vtt',
                },
            ],
        });

        expect(result.settings).toBeNull();
        expect(result.problem).toBe('subtitles');
    });
});

describe('resolveSocketUrl', (): void => {
    it('keeps any hostname and targets the server port 5000 when the page has no port', (): void => {
        expect(resolveSocketUrl(locationLike('http:', '192.168.1.50', ''))).toBe('ws://192.168.1.50:5000');
    });

    it('replaces an explicit non-default page port with the server port', (): void => {
        expect(resolveSocketUrl(locationLike('http:', 'localhost', '1730'))).toBe('ws://localhost:5000');
    });

    it('upgrades to wss on https pages', (): void => {
        expect(resolveSocketUrl(locationLike('https:', 'movie.example', '443'))).toBe('wss://movie.example:5000');
        expect(resolveSocketUrl(locationLike('https:', 'movie.example', ''))).toBe('wss://movie.example:5000');
    });

    it('brackets IPv6 literal hostnames', (): void => {
        expect(resolveSocketUrl(locationLike('http:', '::1', '1730'))).toBe('ws://[::1]:5000');
        expect(resolveSocketUrl(locationLike('http:', '[::1]', '1730'))).toBe('ws://[::1]:5000');
    });
});

describe('socket URL override (?server=)', (): void => {
    it('uses a valid ws/wss override instead of the derived URL', (): void => {
        const page = locationLike('https:', 'movie.example', '');
        expect(resolveSocketUrl(page, 'ws://10.0.0.5:6000')).toBe('ws://10.0.0.5:6000');
        expect(resolveSocketUrl(page, 'wss://example.com:8443')).toBe('wss://example.com:8443');
    });

    it('normalizes scheme and host casing and keeps IPv6 hosts', (): void => {
        expect(resolveSocketUrl(locationLike('http:', 'localhost', '1730'), 'WS://Host:5000')).toBe('ws://host:5000');
        expect(resolveSocketUrl(locationLike('http:', 'localhost', '1730'), 'ws://[::1]:6000')).toBe('ws://[::1]:6000');
    });

    it('drops any path or query from the override', (): void => {
        expect(resolveSocketUrl(locationLike('http:', 'localhost', '1730'), 'wss://example.com:8443/socket.io?q=1')).toBe(
            'wss://example.com:8443',
        );
    });

    it('drops credentials from the override URL', (): void => {
        const page = locationLike('https:', 'movie.example', '');
        expect(resolveSocketUrl(page, 'ws://user:secret@10.0.0.5:6000')).toBe('ws://10.0.0.5:6000');
    });

    it.each([
        ['non-socket scheme', 'javascript:alert(1)'],
        ['http scheme', 'http://10.0.0.5:6000'],
        ['not a URL', 'just some words'],
        ['missing host', 'ws://'],
    ])('ignores a %s override and keeps the derived URL', (_label: string, override: string): void => {
        expect(resolveSocketUrl(locationLike('http:', 'localhost', '1730'), override)).toBe('ws://localhost:5000');
    });
});

describe('readSocketOverride', (): void => {
    it('reads and decodes the server query parameter', (): void => {
        expect(readSocketOverride('?server=ws%3A%2F%2F10.0.0.5%3A6000')).toBe('ws://10.0.0.5:6000');
        expect(readSocketOverride('?other=1&server=ws://a:1')).toBe('ws://a:1');
    });

    it('returns undefined when the parameter is absent or blank', (): void => {
        expect(readSocketOverride('')).toBeUndefined();
        expect(readSocketOverride('?other=1')).toBeUndefined();
        expect(readSocketOverride('?server=')).toBeUndefined();
        expect(readSocketOverride('?server=%20%20')).toBeUndefined();
    });
});

describe('invalid configuration reporting', (): void => {
    it('defines a non-blocking InvalidConfiguration issue in the catalog', (): void => {
        const catalog: Readonly<Record<string, IssueDefinition>> = ISSUE_CATALOG;
        const definition = catalog[IssueCode.InvalidConfiguration];

        expect(definition).toBeDefined();
        if (definition === undefined) {
            return;
        }
        expect(definition.blocking).toBe(false);
        expect(definition.message.length).toBeGreaterThan(0);
    });
});

describe('main socket wiring', (): void => {
    const mainSource: string = readFileSync(fileURLToPath(new URL('../../src/main.ts', import.meta.url)), 'utf8');

    it('builds the socket URL through resolveSocketUrl with the ?server= override', (): void => {
        // Source-level pin: main.ts cannot be imported in Node (it pulls in
        // DOM-grabbing controllers), so the wiring is asserted on source.
        // Positive pins only: the config behavior tests above cover URL
        // derivation, so banning unrelated string operations here would just
        // false-positive on future main.ts edits.
        expect(mainSource).toContain('resolveSocketUrl(');
        expect(mainSource).toContain('readSocketOverride(');
    });
});
