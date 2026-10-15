import { IssueCode } from '../diagnostics/snapshot';

/**
 * Native media error classification (Task 6).
 *
 * Pure tables only — no DOM access, no state — so the controller (and any
 * future surface) can classify a failure without knowing where the code or
 * name came from. Two entry points:
 *
 * - `classifyMediaErrorCode`: a `MediaError.code` (or its absence) to an
 *   issue code. MEDIA_ERR_ABORTED (1) is a deliberate stop and deliberately
 *   maps to null ("not fatal"); an unknown or absent code cannot distinguish
 *   network from decode, so it stays unknown: the incident reports
 *   MediaUnusable and carries no mediaErrorCode.
 * - `classifyPlayRejection`: the DOMException name a refused play() promise
 *   rejects with. AbortError is an expected cancellation (a newer
 *   play/pause/load interrupted the attempt) and is not an error at all.
 */

/** Issue codes a native media failure can classify into. */
export type MediaIssueCode =
    | IssueCode.MediaNetwork
    | IssueCode.MediaDecode
    | IssueCode.MediaUnusable;

/** Spec-defined MediaError codes (1-4) plus engine-reported 5 (no EME). */
const MEDIA_ERR = {
    ABORTED: 1,
    NETWORK: 2,
    DECODE: 3,
    SRC_NOT_SUPPORTED: 4,
    NO_ENCRYPTED_MEDIA: 5,
} as const;

/**
 * Classifies a `MediaError.code`: null for deliberate aborts, a network/
 * decode issue when the code says so, MediaUnusable when the code says the
 * source cannot be used or is unknown/absent.
 */
export function classifyMediaErrorCode(code: number | undefined): MediaIssueCode | null {
    switch (code) {
        case MEDIA_ERR.ABORTED:
            return null;
        case MEDIA_ERR.NETWORK:
            return IssueCode.MediaNetwork;
        case MEDIA_ERR.DECODE:
            return IssueCode.MediaDecode;
        case MEDIA_ERR.SRC_NOT_SUPPORTED:
        case MEDIA_ERR.NO_ENCRYPTED_MEDIA:
            return IssueCode.MediaUnusable;
        case undefined:
        default:
            // Unknown or absent: cannot refine network vs decode.
            return IssueCode.MediaUnusable;
    }
}

/**
 * Classifies the DOMException name a play() promise rejected with: null for
 * expected cancellations, an issue code for genuine refusals.
 */
export function classifyPlayRejection(name: string | undefined): IssueCode | null {
    switch (name) {
        case 'NotAllowedError':
            return IssueCode.PlaybackInteractionRequired;
        case 'NotSupportedError':
            return IssueCode.MediaUnusable;
        case 'AbortError':
            return null;
        case undefined:
        default:
            return IssueCode.Unexpected;
    }
}
