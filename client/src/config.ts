import settings from '../settings.json';

/**
 * Application configuration: validated movie settings and socket discovery.
 *
 * Validation runs once at module scope so `main.ts` can keep exporting the
 * same stable names it always has. It never throws — an unusable
 * settings.json yields null settings plus a safe problem token.
 */

/** One subtitle track from settings.json. */
export interface SubtitleSettings {
    readonly label: string;
    readonly srclang: string;
    readonly file: string;
}

/** Validated movie settings from settings.json. */
export interface MovieSettings {
    readonly file: string;
    readonly type: string;
    readonly subtitles: readonly SubtitleSettings[];
}

/** Safe problem tokens identifying which part of settings.json is unusable. */
export type SettingsProblem = 'file' | 'type' | 'subtitles';

/** Outcome of validating raw settings; never raw settings values. */
export interface SettingsValidation {
    readonly settings: MovieSettings | null;
    readonly problem: SettingsProblem | null;
}

/** Returns a trimmed non-blank string, or null for anything else. */
function readNonBlankString(value: unknown): string | null {
    if (typeof value !== 'string') {
        return null;
    }
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
}

/** Sentinel marking a property read that threw (hostile getter or proxy). */
const UNREADABLE = Symbol('unreadable');

/**
 * Reads one property defensively: a throwing getter or proxy trap collapses
 * to the UNREADABLE sentinel instead of escaping.
 */
function readField(record: Record<string, unknown>, key: string): unknown {
    try {
        return record[key];
    } catch {
        return UNREADABLE;
    }
}

/** Reads one required non-blank string field; unreadable counts as invalid. */
function readRequiredField(record: Record<string, unknown>, key: string): string | null {
    const raw = readField(record, key);
    return raw === UNREADABLE ? null : readNonBlankString(raw);
}

/** Validates the optional subtitles list; absent means none, invalid means null. */
function validateSubtitles(value: unknown): readonly SubtitleSettings[] | null {
    if (value === UNREADABLE) {
        return null;
    }
    if (value === undefined) {
        return [];
    }
    if (!Array.isArray(value)) {
        return null;
    }
    const subtitles: SubtitleSettings[] = [];
    for (const entry of value) {
        const record = typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>) : null;
        if (record === null) {
            return null;
        }
        const label = readRequiredField(record, 'label');
        const srclang = readRequiredField(record, 'srclang');
        const file = readRequiredField(record, 'file');
        if (label === null || srclang === null || file === null) {
            return null;
        }
        subtitles.push({ label, srclang, file });
    }
    return subtitles;
}

/**
 * Validates raw settings.json content defensively: `file` and `type` must be
 * non-blank strings, `subtitles` (when present) a list of entries with
 * non-blank `label`/`srclang`/`file` strings. Invalid input never throws.
 */
export function validateMovieSettings(raw: unknown): SettingsValidation {
    const record = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};

    const file = readRequiredField(record, 'file');
    if (file === null) {
        return { settings: null, problem: 'file' };
    }

    const type = readRequiredField(record, 'type');
    if (type === null) {
        return { settings: null, problem: 'type' };
    }

    const subtitles = validateSubtitles(readField(record, 'subtitles'));
    if (subtitles === null) {
        return { settings: null, problem: 'subtitles' };
    }

    return { settings: { file, type, subtitles }, problem: null };
}

const validated: SettingsValidation = validateMovieSettings(settings);

/** Validated movie settings; null when settings.json is unusable. */
const movieSettings: MovieSettings | null = validated.settings;

/** Which part of settings.json is unusable; null when settings are valid. */
export const settingsProblem: SettingsProblem | null = validated.problem;

export const MOVIE_SOURCE: string = movieSettings === null ? '' : `data/${movieSettings.file}`;

export const MOVIE_TYPE: string = movieSettings === null ? '' : movieSettings.type;

export const SUBTITLES: readonly SubtitleSettings[] = movieSettings === null ? [] : movieSettings.subtitles;

/** The port the room server always listens on. */
const SERVER_PORT = 5000;

/** The subset of Location that socket discovery looks at. */
export interface SocketLocationLike {
    /** Page protocol, e.g. 'https:'. */
    readonly protocol: string;
    /** Page hostname, without brackets for IPv6 in some engines, with them in others. */
    readonly hostname: string;
    /** Deliberately ignored (optional for honesty): the server port is always 5000 unless overridden. */
    readonly port?: string;
    /** Deliberately ignored (optional for honesty): assembled from hostname instead, so IPv6 stays valid. */
    readonly host?: string;
}

/** Brackets a bare IPv6 literal; leaves already-bracketed or named hosts alone. */
function bracketIpv6Host(hostname: string): string {
    const trimmed = hostname.trim();
    if (trimmed.startsWith('[')) {
        return trimmed;
    }
    if (trimmed.includes(':')) {
        return `[${trimmed}]`;
    }
    return trimmed;
}

/** Accepts only absolute ws/wss URLs with a host; everything else is ignored. */
function sanitizeSocketOverride(override: string): string | undefined {
    if (!/^wss?:\/\//i.test(override)) {
        return undefined;
    }
    try {
        const url = new URL(override);
        if (url.hostname === '') {
            return undefined;
        }
        // Keep scheme + host (+ port) only; paths, queries, and credentials
        // never reach the socket client.
        return `${url.protocol}//${url.host}`;
    } catch {
        return undefined;
    }
}

/**
 * Derives the room server URL: same hostname as the page, always port 5000,
 * `wss` on https pages, IPv6 literals bracketed. A sanitized explicit
 * override wins when present.
 */
export function resolveSocketUrl(locationLike: SocketLocationLike, override?: string): string {
    const sanitized = override === undefined ? undefined : sanitizeSocketOverride(override.trim());
    if (sanitized !== undefined) {
        return sanitized;
    }
    const scheme = locationLike.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${scheme}//${bracketIpv6Host(locationLike.hostname)}:${String(SERVER_PORT)}`;
}

/**
 * Reads the socket URL override from a query string: `?server=ws://host:port`.
 * Opt-in, for deployments where the page and server hosts differ.
 */
export function readSocketOverride(search: string): string | undefined {
    const value = new URLSearchParams(search).get('server');
    if (value === null || value.trim() === '') {
        return undefined;
    }
    return value;
}
