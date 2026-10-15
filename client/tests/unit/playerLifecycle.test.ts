import { describe, expect, it } from 'vitest';
import { IssueCode } from '../../src/diagnostics/snapshot';
import { createPlayerHarness, playRejection } from '../helpers/playerHarness';

/**
 * Playback controller lifecycle (Task 6): the REAL controller driven through
 * the fake native boundary (see playerHarness.ts). One describe block per
 * required behavior; each test names the defect it pins.
 */

describe('playback controller: refused play requests', (): void => {
    it('reports a refused play request without claiming playback started', async (): Promise<void> => {
        const harness = createPlayerHarness({ playError: playRejection('NotAllowedError') });

        await harness.receivePlayingState({ mediaId: 'film-a.mp4', playing: true, position: 0, revision: 1 });

        expect(harness.player.paused).toBe(true);
        expect(harness.activeIssueCodes()).toContain(IssueCode.PlaybackInteractionRequired);
    });

    it('handles the rejection without an unhandled promise rejection (AbortError stays silent)', async (): Promise<void> => {
        const harness = createPlayerHarness({ playError: playRejection('AbortError') });

        await harness.receivePlayingState({ position: 0, revision: 1 });

        // An interrupted play attempt is an expected cancellation, not an
        // error: no issue at all, and vitest fails the run on any unhandled
        // rejection escaping the controller.
        expect(harness.activeIssueCodes()).toEqual([]);
        expect(harness.player.paused).toBe(true);
    });

    it('resolves the interaction issue once a later play succeeds', async (): Promise<void> => {
        const harness = createPlayerHarness({ playError: playRejection('NotAllowedError') });

        await harness.receivePlayingState({ position: 0, revision: 1 });
        expect(harness.activeIssueCodes()).toContain(IssueCode.PlaybackInteractionRequired);

        await harness.controller.startPlayback();

        expect(harness.player.paused).toBe(false);
        expect(harness.activeIssueCodes()).not.toContain(IssueCode.PlaybackInteractionRequired);
    });

    it('startPlayback starts only this viewer (no room command)', async (): Promise<void> => {
        const harness = createPlayerHarness({ playError: playRejection('NotAllowedError') });

        await harness.receivePlayingState({ position: 0, revision: 1 });
        await harness.controller.startPlayback();

        expect(harness.player.paused).toBe(false);
        expect(harness.sent).toEqual([]);
    });

    it('keeps reporting honestly when play keeps being refused', async (): Promise<void> => {
        const harness = createPlayerHarness();
        harness.player.playRejections.push(playRejection('NotAllowedError'));
        harness.player.playRejections.push(playRejection('NotAllowedError'));

        await harness.receivePlayingState({ position: 0, revision: 1 });
        await harness.receivePausedState({ position: 0, revision: 2 });
        await harness.receivePlayingState({ position: 0, revision: 3 });

        const issue = harness.issue(IssueCode.PlaybackInteractionRequired);
        expect(issue).toBeDefined();
        expect(issue?.occurrences).toBeGreaterThanOrEqual(2);
        expect(harness.player.paused).toBe(true);
    });

    it('plays normally when nothing refuses (sanity through the real path)', async (): Promise<void> => {
        const harness = createPlayerHarness();

        await harness.receivePlayingState({ position: 0, revision: 1 });

        expect(harness.player.paused).toBe(false);
        expect(harness.activeIssueCodes()).toEqual([]);
    });

    it('leaves a paused room paused', async (): Promise<void> => {
        const harness = createPlayerHarness();

        await harness.receivePausedState({ position: 0, revision: 1 });

        expect(harness.player.paused).toBe(true);
        expect(harness.player.playCalls).toBe(0);
    });

    it('pauses a locally playing viewer when the room pauses', async (): Promise<void> => {
        const harness = createPlayerHarness();
        await harness.receivePlayingState({ position: 0, revision: 1 });
        expect(harness.player.paused).toBe(false);

        await harness.receivePausedState({ position: 1, revision: 2 });

        expect(harness.player.paused).toBe(true);
        expect(harness.activeIssueCodes()).toEqual([]);
    });
});

describe('playback controller: admission and volume wiring', (): void => {
    it('restores the stored volume and shows the element with controls on admission', (): void => {
        const harness = createPlayerHarness({ initialVolume: 0.4 });

        harness.receiveAccepted(false);
        harness.receiveAdmission();

        expect(harness.player.volume).toBe(0.4);
        expect(harness.player.hidden).toBe(false);
        expect(harness.player.controls).toBe(true);
    });

    it('persists volume changes through the injected preferences', (): void => {
        const harness = createPlayerHarness();
        harness.receiveAdmission();

        harness.player.volume = 0.7;
        harness.player.dispatch('volumechange');

        expect(harness.persistedVolumes).toEqual([0.7]);
    });
});
