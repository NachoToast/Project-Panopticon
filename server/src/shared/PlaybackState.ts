/**
 * Playback wire contract shared by client and server.
 *
 * This file is MIRRORED byte-for-byte between `client/src/shared/` and
 * `server/src/shared/` (kept in sync manually; both sides' protocol tests
 * assert the copies are identical). It owns:
 *
 * - the shapes every playback broadcast carries (`PlaybackSnapshot`) and
 *   every playback command carries (`PlaybackCommand`);
 * - runtime guards that validate UNTRUSTED wire payloads by shape, not just
 *   TypeScript types (Socket.IO delivers whatever a peer sends);
 * - `normalizeMediaId`, which derives the media identity from the
 *   configured file path on BOTH sides, so a host on `localhost` and a
 *   viewer on a LAN IP agree without ever comparing URLs/origins.
 *
 * Design decisions, so both sides stay consistent:
 *
 * - mediaId charset is ASCII filename-safe (`[A-Za-z0-9_.\-/]`, no spaces or
 *   unicode), 1..MAX_MEDIA_ID_LENGTH characters, with no `..` path segment.
 *   Slashes are allowed because normalized identities are relative paths
 *   (e.g. `films/a.mp4`).
 * - positions are finite, non-negative, and capped at 2^32 seconds (~136
 *   years) so absurd hostile values cannot smear into clock arithmetic.
 * - revisions are non-negative safe integers (< 2^53); they are comparable
 *   with `>=`/`<` without floating-point surprises.
 * - guards ALLOW unknown extra fields: the client and server ship together
 *   but viewers may lag a deploy, and ignoring undiscovered fields (the
 *   same policy `config.ts` applies to settings.json) keeps old clients
 *   working while the protocol grows. Required fields are still strictly
 *   typed; there is simply no allowlist enforcement on extras.
 * - guards read plain properties without try/catch: Socket.IO payloads are
 *   network-decoded plain values, never live proxies. Server handlers still
 *   wrap clock operations in a backstop catch (see Rooms/Cinema.ts).
 */

/** Maximum accepted mediaId length, applied to the NORMALIZED identity. */
export const MAX_MEDIA_ID_LENGTH = 255;

/** Upper bound for accepted playback positions, in seconds (2^32). */
export const MAX_POSITION_SECONDS = 2 ** 32;

/**
 * Server-authoritative playback state, broadcast on every change and to
 * every joiner. `position` is the position AT SNAPSHOT TIME; while
 * `playing` is true it keeps advancing (see the projection formula in
 * `playback/PlaybackClock.ts` and `playback/clock.ts`).
 */
export interface PlaybackSnapshot {
    /** Normalized identity of the selected media; null when nothing is selected. */
    readonly mediaId: string | null;

    readonly playing: boolean;

    readonly position: number;

    /** Monotonic per-server-lifetime state counter; see PlaybackClock. */
    readonly revision: number;
}

/** Admin-originated playback command; `mediaId` must match the selected media. */
export interface PlaybackCommand {
    readonly mediaId: string;

    readonly position: number;
}

/** Why a playback command (play/pause/seek/select) was refused. */
export type CommandRejection =
    | 'invalid-command'
    | 'wrong-media'
    | 'not-authorized'
    | 'not-in-cinema';

/** Charset for a normalized identity: ASCII filename-safe plus `/`. */
const MEDIA_ID_PATTERN = /^[\w.\-/]+$/;

/** Charset + length check for a mediaId in its final (normalized) form. */
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

function isFinitePosition(value: unknown): value is number {
    return (
        typeof value === 'number' &&
        Number.isFinite(value) &&
        value >= 0 &&
        value <= MAX_POSITION_SECONDS
    );
}

function isSafeRevision(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 && Number.isSafeInteger(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Shape-validates an untrusted snapshot payload. */
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
    if (!isFinitePosition(position) || !isSafeRevision(revision)) {
        return false;
    }
    return true;
}

/** Shape-validates an untrusted playback command payload. */
export function isPlaybackCommand(value: unknown): value is PlaybackCommand {
    if (!isRecord(value)) {
        return false;
    }
    const { mediaId, position } = value;
    return isMediaId(mediaId) && isFinitePosition(position);
}

const COMMAND_REJECTIONS: readonly CommandRejection[] = [
    'invalid-command',
    'wrong-media',
    'not-authorized',
    'not-in-cinema',
];

/** Shape-validates an untrusted command-rejection payload. */
export function isCommandRejection(value: unknown): value is CommandRejection {
    return typeof value === 'string' && (COMMAND_REJECTIONS as readonly string[]).includes(value);
}

/**
 * Derives the media identity from the configured movie FILE PATH.
 *
 * Normalization (identical on client and server): trim, strip leading `./`
 * segments, collapse duplicate slashes, then reject the result unless it is
 * a valid mediaId — which also rejects any `..` segment and anything over
 * MAX_MEDIA_ID_LENGTH (the cap applies post-normalization, so a padded
 * `a//b` path that collapses under the cap stays usable). Returns null for
 * blank, non-string, hostile, or oversized input; never throws.
 */
export function normalizeMediaId(configuredFile: string): string | null {
    if (typeof configuredFile !== 'string') {
        return null;
    }

    let normalized = configuredFile.trim();
    while (normalized.startsWith('./')) {
        normalized = normalized.slice(2);
    }
    normalized = normalized.replace(/\/{2,}/g, '/');

    if (normalized === '') {
        return null;
    }

    return isMediaId(normalized) ? normalized : null;
}
