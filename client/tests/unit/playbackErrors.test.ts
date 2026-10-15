import { describe, expect, it } from 'vitest';
import { IssueCode } from '../../src/diagnostics/snapshot';
import {
    classifyMediaErrorCode,
    classifyPlayRejection,
} from '../../src/playback/mediaErrors';

/**
 * Native media error classification (Task 6): pure tables from
 * MediaError.code / DOMException names to issue codes. The controller never
 * embeds these decisions — it asks this module.
 */

describe('classifyMediaErrorCode', (): void => {
    it('maps every spec-defined MEDIA_ERR code to its issue', (): void => {
        expect(classifyMediaErrorCode(1)).toBeNull(); // ABORTED: deliberate, not fatal
        expect(classifyMediaErrorCode(2)).toBe(IssueCode.MediaNetwork);
        expect(classifyMediaErrorCode(3)).toBe(IssueCode.MediaDecode);
        expect(classifyMediaErrorCode(4)).toBe(IssueCode.MediaUnusable); // SRC_NOT_SUPPORTED
    });

    it('treats the encrypted-media-absent code 5 as an unusable source', (): void => {
        expect(classifyMediaErrorCode(5)).toBe(IssueCode.MediaUnusable);
    });

    it('classifies an unknown or absent code as unusable (stays unknown)', (): void => {
        // No MediaError.code is available (e.g. a <source> child failure):
        // the classification cannot say network vs decode, so the incident
        // reports "source unusable" and carries no mediaErrorCode.
        expect(classifyMediaErrorCode(undefined)).toBe(IssueCode.MediaUnusable);
        expect(classifyMediaErrorCode(0)).toBe(IssueCode.MediaUnusable);
        expect(classifyMediaErrorCode(6)).toBe(IssueCode.MediaUnusable);
        expect(classifyMediaErrorCode(Number.NaN)).toBe(IssueCode.MediaUnusable);
    });
});

describe('classifyPlayRejection', (): void => {
    it('classifies the documented DOMException names play() rejects with', (): void => {
        expect(classifyPlayRejection('NotAllowedError')).toBe(IssueCode.PlaybackInteractionRequired);
        expect(classifyPlayRejection('NotSupportedError')).toBe(IssueCode.MediaUnusable);
    });

    it('treats AbortError as an expected cancellation, not an error', (): void => {
        expect(classifyPlayRejection('AbortError')).toBeNull();
    });

    it('falls back to Unexpected for unknown names and garbage input', (): void => {
        expect(classifyPlayRejection(' WeirdError ')).toBe(IssueCode.Unexpected);
        expect(classifyPlayRejection(undefined)).toBe(IssueCode.Unexpected);
        expect(classifyPlayRejection('')).toBe(IssueCode.Unexpected);
    });
});
