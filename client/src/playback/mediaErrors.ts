import { IssueCode } from '../diagnostics/snapshot';

/**
 * Native media error classification: pure tables, no DOM access, no state.
 * ABORTED (1) is a deliberate stop and maps to null; an unknown or absent
 * code cannot distinguish network from decode, so it stays unknown and
 * reports MediaUnusable. AbortError from play() is an expected cancellation.
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

/** Classifies a MediaError.code; null for aborts, unknown stays MediaUnusable. */
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

/** Classifies a play() rejection's DOMException name; null for AbortError. */
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
