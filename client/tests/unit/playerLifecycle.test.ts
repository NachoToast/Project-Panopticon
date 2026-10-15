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

describe('playback controller: admission media idempotency', (): void => {
    const SUBTITLES = [
        { label: 'English', srclang: 'en', file: 'a.vtt' },
        { label: 'Swedish', srclang: 'sv', file: 'b.vtt' },
    ];

    it('loads exactly one source and the configured tracks on first admission', (): void => {
        const harness = createPlayerHarness({ subtitles: SUBTITLES });

        harness.receiveAdmission();

        expect(harness.player.sourceChildren).toHaveLength(1);
        expect(harness.player.sourceChildren[0]?.src).toBe('data/film-a.mp4');
        expect(harness.player.sourceChildren[0]?.type).toBe('video/mp4');
        expect(harness.player.trackChildren).toHaveLength(2);
        expect(harness.player.trackChildren[0]?.default).toBe(true);
        expect(harness.player.trackChildren[1]?.default).toBe(false);
        expect(harness.player.loadCalls).toBe(1);
    });

    it('readmission with the same usable media reuses the element (no reload)', (): void => {
        const harness = createPlayerHarness({ subtitles: SUBTITLES });
        harness.receiveAdmission();
        harness.player.markMetadata(3_600);
        harness.player.markDataLoaded();

        harness.disconnect('transport close');
        harness.reconnect();
        harness.receiveAdmission();

        expect(harness.player.sourceChildren).toHaveLength(1);
        expect(harness.player.trackChildren).toHaveLength(2);
        expect(harness.player.loadCalls).toBe(1);
        expect(harness.player.readyState).toBe(2);
    });

    it('readmission after an unfinished load rebuilds and restarts it', (): void => {
        const harness = createPlayerHarness();
        harness.receiveAdmission();
        expect(harness.player.loadCalls).toBe(1);

        // Load never completed (disconnect mid-load): the element is not
        // usable, so readmission must rebuild the source and load again.
        harness.disconnect('transport close');
        harness.reconnect();
        harness.receiveAdmission();

        expect(harness.player.sourceChildren).toHaveLength(1);
        expect(harness.player.loadCalls).toBe(2);
    });

    it('does not multiply native listeners across admissions (one command per event)', (): void => {
        const harness = createPlayerHarness();
        harness.receiveAccepted(true);
        harness.receiveAdmission();
        harness.player.markMetadata(3_600);

        // A real reconnect re-runs the full admission flow.
        harness.disconnect('transport close');
        harness.reconnect();
        harness.receiveAccepted(true);
        harness.receiveAdmission();

        // A genuine pause (no programmatic marker) emits exactly one command;
        // duplicate listeners would emit duplicates.
        harness.player.dispatch('pause');

        const pauses = harness.sent.filter((entry) => entry.event === 'cinema:pause');
        expect(pauses).toHaveLength(1);
    });

    it('announces the media identity once per host admission', (): void => {
        const harness = createPlayerHarness();
        harness.receiveAccepted(true);

        harness.receiveAdmission();
        harness.receiveAdmission();

        const announces = harness.sent.filter((entry) => entry.kind === 'announce');
        expect(announces).toHaveLength(2);
        expect(announces[0]?.payload).toBe('film-a.mp4');
    });

    it('viewers never announce a media selection', (): void => {
        const harness = createPlayerHarness();
        harness.receiveAccepted(false);
        harness.receiveAdmission();

        expect(harness.sent.filter((entry) => entry.kind === 'announce')).toHaveLength(0);
    });
});

