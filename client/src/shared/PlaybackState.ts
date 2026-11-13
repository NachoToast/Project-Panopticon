/**
 * Playback wire contract shared by client and server.
 *
 * Mirrored byte for byte between client/src/shared/ and server/src/shared/
 * (both sides' protocol tests assert the copies are identical). Owns the
 * snapshot and command shapes, runtime guards that validate untrusted wire
 * payloads by shape, and normalizeMediaId, which derives the media identity
 * from the configured file path on both sides so a host on localhost and a
 * viewer on a LAN ip agree without comparing origins. Guards allow unknown
 * extra fields so lagging viewers keep working as the protocol grows.
 */

/** Maximum accepted mediaId length, applied to the normalised identity. */
export const MAX_MEDIA_ID_LENGTH = 255;

/** Upper bound for accepted playback positions, in seconds (2^32). */
export const MAX_POSITION_SECONDS = 2 ** 32;

/**
 * Authoritative server playback state, broadcast on every change and to
 * every joiner. position is the position at snapshot time, and it keeps
 * advancing while playing is true (see PlaybackClock and clock.ts).
 */
export interface PlaybackSnapshot {
    /** Normalised identity of the selected media, null when nothing is selected. */
    readonly mediaId: string | null;

    readonly playing: boolean;

    readonly position: number;

    /** Monotonic per server lifetime counter, see PlaybackClock. */
    readonly revision: number;
}

/** Host originated playback command. mediaId must match the selected media. */
export interface PlaybackCommand {
    readonly mediaId: string;

    readonly position: number;
}

/** Why a playback command was refused. */
export type CommandRejection =
    | 'invalid-command'
    | 'wrong-media'
    | 'not-authorized'
    | 'not-in-cinema';

/** Charset for a normalised identity, ASCII filename safe plus /. */
const MEDIA_ID_PATTERN = /^[\w.\-/]+$/;


export function isMediaId(value: unknown): value is string {
    if (typeof value !== 'string') {
        return false;
    }
    if (value.length === 0 || value.length > MAX_MEDIA_ID_LENGTH) {
        return false;
    }
    if (!MEDIA_ID_PATTERN.test(value)) {
        return false;
    }
    return !value.split('/').includes('..');
}

function isPositionSeconds(value: unknown): value is number {
    return (
        typeof value === 'number' &&
        Number.isFinite(value) &&
        value >= 0 &&
        value <= MAX_POSITION_SECONDS
    );
}

function isSafeRevision(value: unknown): value is number {
    return typeof value === 'number' && value >= 0 && Number.isSafeInteger(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Shape validates an untrusted snapshot payload. */
export function isPlaybackSnapshot(value: unknown): value is PlaybackSnapshot {
    if (!isRecord(value)) {
        return false;
    }
    const { mediaId, playing, position, revision } = value;
    if (mediaId !== null && !isMediaId(mediaId)) {
        return false;
    }
    if (typeof playing !== 'boolean') {
        return false;
    }
    if (!isPositionSeconds(position) || !isSafeRevision(revision)) {
        return false;
    }
    return true;
}

/** Shape validates an untrusted playback command payload. */
export function isPlaybackCommand(value: unknown): value is PlaybackCommand {
    if (!isRecord(value)) {
        return false;
    }
    const { mediaId, position } = value;
    return isMediaId(mediaId) && isPositionSeconds(position);
}

const COMMAND_REJECTIONS: readonly CommandRejection[] = [
    'invalid-command',
    'wrong-media',
    'not-authorized',
    'not-in-cinema',
];


export function isCommandRejection(value: unknown): value is CommandRejection {
    return typeof value === 'string' && (COMMAND_REJECTIONS as readonly string[]).includes(value);
}

/**
 * Derives the media identity from the configured movie file path. Trims,
 * strips leading ./ segments and slashes, collapses duplicate slashes, then
 * requires a valid mediaId. Returns null for anything else.
 */
export function normalizeMediaId(configuredFile: string): string | null {
    if (typeof configuredFile !== 'string') {
        return null;
    }

    let normalized = configuredFile.trim();
    while (normalized.startsWith('./')) {
        normalized = normalized.slice(2);
    }
    normalized = normalized.replace(/^\/+/, '');
    normalized = normalized.replace(/\/{2,}/g, '/');

    if (normalized === '') {
        return null;
    }

    return isMediaId(normalized) ? normalized : null;
}
