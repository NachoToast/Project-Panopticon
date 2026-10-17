import { describe, expect, it } from 'vitest';
import { IssueCode } from '../../src/diagnostics/snapshot';
import { createPlayerHarness, playRejection } from '../helpers/playerHarness';

/**
 * Playback controller lifecycle: the REAL controller driven through
 * the fake native boundary (see playerHarness.ts). One describe block per
 * required behavior, each test names the defect it pins.
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

describe('playback controller: delayed metadata seeks', (): void => {
    it('applies a snapshot position immediately when metadata is already known', async (): Promise<void> => {
        const harness = createPlayerHarness();
        harness.receiveAdmission();
        harness.player.markMetadata(3_600);

        await harness.receivePlayingState({ position: 100, revision: 1 });

        expect(harness.player.currentTime).toBe(100);
    });

    it('waits for loadedmetadata, then seeks to the LATEST projected target', async (): Promise<void> => {
        const harness = createPlayerHarness();
        harness.receiveAdmission();

        await harness.receivePlayingState({ position: 100, revision: 1 });
        expect(harness.player.currentTime).toBe(0); // nothing before metadata

        await harness.receivePlayingState({ position: 200, revision: 2 });
        expect(harness.player.currentTime).toBe(0);

        harness.player.markMetadata(3_600);

        // The freshest projection (200), not the stale 100 computed first.
        expect(harness.player.currentTime).toBe(200);
    });

    it('clamps the deferred target against the now-known finite duration', async (): Promise<void> => {
        const harness = createPlayerHarness();
        harness.receiveAdmission();

        await harness.receivePlayingState({ position: 300, revision: 1 });
        harness.player.markMetadata(250);

        expect(harness.player.currentTime).toBe(250);
    });

    it('does not seek past the duration when metadata is already known', async (): Promise<void> => {
        const harness = createPlayerHarness();
        harness.receiveAdmission();
        harness.player.markMetadata(90);

        await harness.receivePlayingState({ position: 600, revision: 1 });

        expect(harness.player.currentTime).toBe(90);
    });
});

describe('playback controller: stale async work cannot win', (): void => {
    it('drops a late play() rejection after a newer pause decided otherwise', async (): Promise<void> => {
        const harness = createPlayerHarness();
        harness.player.deferPlay = true;

        await harness.receivePlayingState({ position: 0, revision: 1 });
        harness.player.pauseCalls = 0;

        await harness.receivePausedState({ position: 1, revision: 2 });
        expect(harness.player.paused).toBe(true);

        // The interrupted play finally reports its refusal, far too late.
        harness.player.settleNextPlay(playRejection('NotAllowedError'));
        await harness.settle();

        expect(harness.activeIssueCodes()).toEqual([]);
        expect(harness.player.paused).toBe(true);
    });

    it('drops a metadata callback from before a disconnect (no zombie seek)', async (): Promise<void> => {
        const harness = createPlayerHarness();
        harness.receiveAdmission();

        await harness.receivePlayingState({ position: 100, revision: 1 });
        harness.disconnect('transport close');

        harness.player.markMetadata(3_600);

        expect(harness.player.currentTime).toBe(0);
    });

    it('treats an interrupted play (AbortError) as an expected cancellation', async (): Promise<void> => {
        const harness = createPlayerHarness();
        harness.player.deferPlay = true;

        await harness.receivePlayingState({ position: 0, revision: 1 });
        await harness.receivePausedState({ position: 1, revision: 2 });

        harness.player.settleNextPlay(playRejection('AbortError'));
        await harness.settle();

        expect(harness.activeIssueCodes()).toEqual([]);
    });
});

describe('playback controller: projection-driven reconciliation', (): void => {
    it('does not rewind a viewer to a frozen timestamp after long playback', async (): Promise<void> => {
        const harness = createPlayerHarness();
        harness.receiveAdmission();
        harness.player.markMetadata(3_600);

        await harness.receivePlayingState({ position: 0, revision: 1 });
        expect(harness.player.paused).toBe(false);

        // Ten minutes of wall time pass and the element plays along.
        harness.tick(600_000);
        harness.player.currentTime = 600;

        // The viewer pauses locally (a genuine event, no programmatic marker).
        harness.player.dispatch('pause');

        // The projection clock supplies the advancing target: the viewer is
        // brought back to ~600 (and playing again), never to the frozen 0.
        expect(harness.player.currentTime).toBeGreaterThan(599);
        expect(harness.player.paused).toBe(false);
    });

    it('keeps a paused viewer paused at their real position when the room pauses', async (): Promise<void> => {
        const harness = createPlayerHarness();
        harness.receiveAdmission();
        harness.player.markMetadata(3_600);

        await harness.receivePlayingState({ position: 0, revision: 1 });
        harness.tick(600_000);
        harness.player.currentTime = 600;

        await harness.receivePausedState({ position: 600.5, revision: 2 });

        expect(harness.player.paused).toBe(true);
        // Small drift (0.5s) is tolerated: no snap-seek to the snapshot.
        expect(harness.player.currentTime).toBe(600);
    });

    it('applies a genuine host seek exactly even when drift is under the threshold', async (): Promise<void> => {
        const harness = createPlayerHarness();
        harness.receiveAdmission();
        harness.player.markMetadata(3_600);

        await harness.receivePlayingState({ position: 10, revision: 1 });
        harness.tick(200);
        harness.player.currentTime = 10;

        await harness.receiveSeekedState({ position: 12, revision: 2 });

        expect(harness.player.currentTime).toBe(12);
    });

    it('re-seeks a lagging viewer once drift exceeds the threshold', async (): Promise<void> => {
        const harness = createPlayerHarness();
        harness.receiveAdmission();
        harness.player.markMetadata(3_600);

        await harness.receivePlayingState({ position: 100, revision: 1 });
        harness.player.currentTime = 100;

        // The viewer stalls (buffering) while the room advances 30s.
        await harness.receivePausedState({ position: 130, revision: 2 });

        expect(harness.player.currentTime).toBe(130);
    });

    it('does not thrash: playback within tolerance triggers no seek events', async (): Promise<void> => {
        const harness = createPlayerHarness();
        harness.receiveAdmission();
        harness.player.markMetadata(3_600);

        await harness.receivePlayingState({ position: 100, revision: 1 });
        harness.player.currentTime = 100;

        const seeksBefore = harness.sent.filter((entry) => entry.event === 'cinema:seek').length;
        harness.player.dispatch('seeked'); // viewer scrub within tolerance

        expect(harness.player.currentTime).toBe(100);
        expect(
            harness.sent.filter((entry) => entry.event === 'cinema:seek').length,
        ).toBe(seeksBefore);
    });
});

describe('playback controller: media error handling', (): void => {
    it('coalesces element errors into one incident that tracks the latest code', (): Promise<void> => {
        const harness = createPlayerHarness();
        harness.receiveAdmission();

        harness.player.failWithError(2); // network
        harness.player.failWithError(2);
        harness.player.failWithError(3); // decode

        const issues = harness.store.getIssueSnapshot().issues.filter(
            (issue) => issue.key === 'media-playback:film-a.mp4',
        );
        expect(issues).toHaveLength(1);
        expect(issues[0]?.code).toBe(IssueCode.MediaDecode);
        expect(issues[0]?.occurrences).toBe(3);
        expect(issues[0]?.mediaErrorCode).toBe(3);
        expect(issues[0]?.mediaId).toBe('film-a.mp4');
        return Promise.resolve();
    });

    it('classifies an unusable source (code 4) as MediaUnusable', (): void => {
        const harness = createPlayerHarness();
        harness.receiveAdmission();

        harness.player.failWithError(4);

        expect(harness.activeIssueCodes()).toContain(IssueCode.MediaUnusable);
    });

    it('ignores a deliberate abort (code 1) entirely', (): void => {
        const harness = createPlayerHarness();
        harness.receiveAdmission();

        harness.player.failWithError(1);

        expect(harness.activeIssueCodes()).toEqual([]);
    });

    it('reports a failing source child as unusable with no mediaErrorCode', (): void => {
        const harness = createPlayerHarness();
        harness.receiveAdmission();

        const source = harness.player.sourceChildren[0];
        harness.player.dispatchChildError(source);

        const issue = harness.issue(IssueCode.MediaUnusable);
        expect(issue).toBeDefined();
        expect(issue?.mediaErrorCode).toBeUndefined();
    });

    it('never treats abort/emptied (deliberate loads) as fatal', (): void => {
        const harness = createPlayerHarness();
        harness.receiveAdmission();

        harness.player.dispatch('abort');
        harness.player.dispatch('emptied');

        expect(harness.activeIssueCodes()).toEqual([]);
    });

    it('never treats suspend/waiting/stalled (buffering) as fatal', (): void => {
        const harness = createPlayerHarness();
        harness.receiveAdmission();

        harness.player.dispatch('suspend');
        harness.player.dispatch('waiting');
        harness.player.dispatch('stalled');

        expect(harness.activeIssueCodes()).toEqual([]);
    });

    it('does not restart ended playback in a reconciliation loop', async (): Promise<void> => {
        const harness = createPlayerHarness();
        harness.receiveAdmission();
        harness.player.markMetadata(3_600);
        await harness.receivePlayingState({ position: 0, revision: 1 });
        const playCalls = harness.player.playCalls;

        harness.player.markEnded();
        const playCallsAfterEnded = harness.player.playCalls;

        // Any later nudge (a fresh snapshot) still must not restart ended
        // playback: the room is playing but the media is over.
        await harness.receivePlayingState({ position: 0, revision: 2 });

        expect(harness.activeIssueCodes()).toEqual([]);
        expect(playCallsAfterEnded).toBe(playCalls);
        expect(harness.player.playCalls).toBe(playCalls);
    });

    it('resumes when a later snapshot rewinds past the end', async (): Promise<void> => {
        const harness = createPlayerHarness();
        harness.receiveAdmission();
        harness.player.markMetadata(3_600);
        await harness.receivePlayingState({ position: 3_599, revision: 1 });
        harness.player.markEnded();

        // The host rewinds and the viewer must follow out of the ended state.
        await harness.receiveSeekedState({ position: 10, revision: 2, playing: true });

        expect(harness.player.ended).toBe(false);
        expect(harness.player.currentTime).toBe(10);
        expect(harness.player.paused).toBe(false);
    });
});

describe('playback controller: media mismatch', (): void => {
    it('pauses locally and reports MediaMismatch when the room watches other media', async (): Promise<void> => {
        const harness = createPlayerHarness();
        harness.receiveAdmission();
        harness.player.markMetadata(3_600);
        await harness.receivePlayingState({ position: 5, revision: 1 });
        expect(harness.player.paused).toBe(false);

        await harness.receivePlayingState({ mediaId: 'film-b.mp4', position: 5, revision: 2 });

        expect(harness.player.paused).toBe(true);
        expect(harness.activeIssueCodes()).toContain(IssueCode.MediaMismatch);
        // Viewers never command, the host state (the server clock) is
        // authoritative and untouched from here.
        expect(harness.sent).toEqual([]);
    });

    it('keeps the room projection instead of resetting it, and recovers when the media matches again', async (): Promise<void> => {
        const harness = createPlayerHarness();
        harness.receiveAdmission();
        harness.player.markMetadata(3_600);

        await harness.receivePlayingState({ mediaId: 'film-b.mp4', position: 40, revision: 1 });

        // The room re-selects OUR media mid-stream: mismatch clears, the
        // projected position applies, playback resumes.
        await harness.receiveState({ mediaId: 'film-a.mp4', position: 42, revision: 2, playing: true });

        expect(harness.activeIssueCodes()).not.toContain(IssueCode.MediaMismatch);
        expect(harness.player.currentTime).toBe(42);
        expect(harness.player.paused).toBe(false);
    });

    it('emits the next genuine pause after a mismatch paused an already-paused host', async (): Promise<void> => {
        const harness = createPlayerHarness();
        harness.receiveAccepted(true);
        harness.receiveAdmission();
        harness.player.markMetadata(3_600);
        expect(harness.player.paused).toBe(true); // host never started

        // The room watches other media while the host element is paused:
        // the local pause is a no-op on the element, and a real element
        // fires NO native pause event for it, so no marker may remain.
        await harness.receivePlayingState({ mediaId: 'film-b.mp4', position: 5, revision: 1 });
        expect(harness.activeIssueCodes()).toContain(IssueCode.MediaMismatch);

        // The host genuinely plays, then genuinely pauses: exactly one
        // pause command must reach the room (a leaked marker would
        // swallow it and the room would never learn about the pause).
        harness.player.paused = false;
        harness.player.dispatch('play');
        harness.player.paused = true;
        harness.player.dispatch('pause');

        expect(harness.sent.filter((entry) => entry.event === 'cinema:play')).toHaveLength(1);
        expect(harness.sent.filter((entry) => entry.event === 'cinema:pause')).toHaveLength(1);
    });

    it('still reconciles a genuine viewer pause after a mismatch paused an already-paused viewer', async (): Promise<void> => {
        const harness = createPlayerHarness();
        harness.receiveAdmission();
        harness.player.markMetadata(3_600);

        await harness.receivePlayingState({ position: 0, revision: 1 });
        await harness.receivePausedState({ position: 1, revision: 2 });
        expect(harness.player.paused).toBe(true);

        // Mismatch arrives while the viewer is paused: no native pause
        // fires, so no suppression marker may be reserved.
        await harness.receivePlayingState({ mediaId: 'film-b.mp4', position: 5, revision: 3 });
        expect(harness.activeIssueCodes()).toContain(IssueCode.MediaMismatch);

        // The room returns to our media and plays: the viewer resumes.
        await harness.receivePlayingState({ position: 6, revision: 4 });
        expect(harness.player.paused).toBe(false);

        // A genuine local pause must still reconcile back to the room
        // (a leaked marker would skip reconciliation and strand the
        // viewer off-room).
        harness.player.paused = true;
        harness.player.dispatch('pause');

        expect(harness.player.paused).toBe(false);
        expect(harness.sent).toEqual([]); // viewers never command
    });

    it('exposes reload as the mismatch recovery, wired to the injected page reload', (): void => {
        const harness = createPlayerHarness();

        harness.controller.reload();

        expect(harness.reloads).toBe(1);
    });
});

describe('playback controller: command rejections', (): void => {
    it('surfaces a wrong-media rejection as InvalidServerState carrying the rejection detail', (): void => {
        const harness = createPlayerHarness();
        harness.receiveAccepted(true);
        harness.receiveAdmission();

        harness.receiveCommandRejected('wrong-media');

        expect(harness.activeIssueCodes()).toContain(IssueCode.InvalidServerState);
        const reported = harness
            .reportedIssues()
            .find((input) => input.code === IssueCode.InvalidServerState);
        // The rejection UX keys off this detail.
        expect(reported?.detail).toBe('wrong-media');
    });

    it('surfaces an invalid-command rejection as InvalidServerState carrying the rejection detail', (): void => {
        const harness = createPlayerHarness();
        harness.receiveAccepted(true);
        harness.receiveAdmission();

        harness.receiveCommandRejected('invalid-command');

        expect(harness.activeIssueCodes()).toContain(IssueCode.InvalidServerState);
        const reported = harness
            .reportedIssues()
            .find((input) => input.code === IssueCode.InvalidServerState);
        expect(reported?.detail).toBe('invalid-command');
    });

    it('folds garbage where a rejection should be into the same InvalidServerState surface', (): void => {
        const harness = createPlayerHarness();

        harness.receiveCommandRejected({ nope: true });

        expect(harness.activeIssueCodes()).toContain(IssueCode.InvalidServerState);
    });
});

describe('playback controller: disconnect lifecycle', (): void => {
    it('pauses, hides, and strips controls the moment the transport drops', async (): Promise<void> => {
        const harness = createPlayerHarness();
        harness.receiveAdmission();
        harness.player.markMetadata(3_600);
        await harness.receivePlayingState({ position: 0, revision: 1 });
        expect(harness.player.paused).toBe(false);

        harness.disconnect('transport close');

        expect(harness.player.paused).toBe(true); // no hidden audio
        expect(harness.player.hidden).toBe(true);
        expect(harness.player.controls).toBe(false);
        expect(harness.activeIssueCodes()).toContain(IssueCode.ConnectionLost);
    });

    it('reports ConnectionLost only for transport-level disconnects', (): void => {
        const harness = createPlayerHarness();

        harness.disconnect('io server disconnect'); // kick/ban flow
        expect(harness.activeIssueCodes()).not.toContain(IssueCode.ConnectionLost);

        harness.disconnect('io client disconnect'); // deliberate close
        expect(harness.activeIssueCodes()).not.toContain(IssueCode.ConnectionLost);

        harness.disconnect('ping timeout');
        expect(harness.activeIssueCodes()).toContain(IssueCode.ConnectionLost);
    });

    it('invalidates in-flight work: a late play rejection after disconnect stays silent', async (): Promise<void> => {
        const harness = createPlayerHarness();
        harness.player.deferPlay = true;
        await harness.receivePlayingState({ position: 0, revision: 1 });

        harness.disconnect('transport close');
        harness.player.settleNextPlay(playRejection('NotAllowedError'));
        await harness.settle();

        expect(harness.activeIssueCodes()).toEqual([IssueCode.ConnectionLost]);
        expect(harness.player.paused).toBe(true);
    });

    it('readmission restores visibility and controls without reloading the media', async (): Promise<void> => {
        const harness = createPlayerHarness();
        harness.receiveAccepted(false);
        harness.receiveAdmission();
        harness.player.markMetadata(3_600);
        harness.player.markDataLoaded();
        await harness.receivePlayingState({ position: 0, revision: 1 });

        harness.disconnect('transport close');
        expect(harness.player.hidden).toBe(true);

        harness.reconnect();
        harness.receiveAccepted(false);
        harness.receiveAdmission();

        expect(harness.player.hidden).toBe(false);
        expect(harness.player.controls).toBe(true);
        expect(harness.player.loadCalls).toBe(1); // same usable media reused
    });

    it('drops the stale revision baseline across a server restart epoch', async (): Promise<void> => {
        const harness = createPlayerHarness();
        harness.receiveAdmission();
        harness.player.markMetadata(3_600);
        await harness.receivePlayingState({ position: 10, revision: 7, playing: false });

        harness.disconnect('transport close');
        harness.reconnect();
        harness.receiveAccepted(false);
        harness.receiveAdmission();

        // A restarted server counts revisions from 0 again, so the new epoch
        // must accept them instead of dropping them as stale.
        await harness.receivePausedState({ position: 0, revision: 1 });

        expect(harness.player.currentTime).toBe(0);
    });

    it('resolves ConnectionLost once readmitted after a reconnect', async (): Promise<void> => {
        const harness = createPlayerHarness();
        harness.receiveAdmission();
        await harness.receivePlayingState({ position: 0, revision: 1 });

        harness.disconnect('transport close');
        expect(harness.activeIssueCodes()).toContain(IssueCode.ConnectionLost);

        harness.reconnect();
        harness.receiveAccepted(false);
        harness.receiveAdmission();

        expect(harness.activeIssueCodes()).not.toContain(IssueCode.ConnectionLost);
    });
});

describe('playback controller: trusted command emission', (): void => {
    function adminHarness(): ReturnType<typeof createPlayerHarness> {
        const harness = createPlayerHarness();
        harness.receiveAccepted(true);
        harness.receiveAdmission();
        harness.player.markMetadata(3_600);
        return harness;
    }

    it('never commands as a viewer, however the element moves', async (): Promise<void> => {
        const harness = createPlayerHarness();
        harness.receiveAccepted(false);
        harness.receiveAdmission();
        harness.player.markMetadata(3_600);

        await harness.receivePlayingState({ position: 0, revision: 1 });
        harness.player.currentTime = 5;
        harness.player.dispatch('pause');

        expect(harness.sent.filter((entry) => entry.kind === 'command')).toHaveLength(0);
    });

    it('suppresses the programmatic play its own reconciliation started (no echo loop)', async (): Promise<void> => {
        const harness = adminHarness();

        // A same-media State broadcast says playing while the host element
        // is paused and reconciliation plays it, and that play must NOT become a
        // cinema:play command, or the host would command its own echo.
        await harness.receiveState({ position: 0, revision: 2, playing: true });

        expect(harness.player.paused).toBe(false);
        expect(harness.sent.filter((entry) => entry.event === 'cinema:play')).toHaveLength(0);
    });

    it('suppresses the programmatic pause from a room pause broadcast', async (): Promise<void> => {
        const harness = adminHarness();
        await harness.receivePlayingState({ position: 0, revision: 2 });

        await harness.receivePausedState({ position: 3, revision: 3 });

        expect(harness.player.paused).toBe(true);
        expect(harness.sent.filter((entry) => entry.event === 'cinema:pause')).toHaveLength(0);
    });

    it('emits exactly one command per genuine native control event', (): void => {
        const harness = adminHarness();

        harness.player.paused = false;
        harness.player.dispatch('play');
        harness.player.dispatch('pause');
        harness.player.currentTime = 12; // genuine scrub fires a real seeked

        const commands = harness.sent.filter((entry) => entry.kind === 'command');
        expect(commands.map((entry) => entry.event)).toEqual([
            'cinema:play',
            'cinema:pause',
            'cinema:seek',
        ]);
        expect(commands[2]?.payload).toEqual({ mediaId: 'film-a.mp4', position: 12 });
    });

    it('emits no host commands while disconnected', (): void => {
        const harness = adminHarness();

        harness.disconnect('transport close');
        harness.player.dispatch('play');

        expect(harness.sent.filter((entry) => entry.kind === 'command')).toHaveLength(0);
    });

    it('reclaims the play marker when play() is refused, so genuine input still commands', async (): Promise<void> => {
        const harness = adminHarness();
        harness.player.playRejections.push(playRejection('NotAllowedError'));

        await harness.receiveState({ position: 0, revision: 2, playing: true });

        // The refused attempt must not leave a suppression marker behind.
        harness.player.paused = false;
        harness.player.dispatch('play');

        const plays = harness.sent.filter((entry) => entry.event === 'cinema:play');
        expect(plays).toHaveLength(1);
    });

    it('refuses to command without a media identity and reports why', (): void => {
        const harness = createPlayerHarness({ file: 'bad name.mp4' });
        // An unnormalizable file leaves the media identity null.
        harness.receiveAccepted(true);
        harness.receiveAdmission();
        harness.player.markMetadata(3_600);

        harness.player.dispatch('pause');

        expect(harness.sent.filter((entry) => entry.kind === 'command')).toHaveLength(0);
        expect(harness.activeIssueCodes()).toContain(IssueCode.InvalidConfiguration);
    });
});

describe('playback controller: slow loading', (): void => {
    it('reports SlowLoading once when no usable data arrives in time', (): void => {
        const harness = createPlayerHarness();
        harness.receiveAdmission();

        harness.tick(14_999);
        expect(harness.activeIssueCodes()).not.toContain(IssueCode.SlowLoading);

        harness.tick(1);
        expect(harness.issue(IssueCode.SlowLoading)).toBeDefined();

        // Fires once per load: no repeating timer.
        harness.tick(30_000);
        expect(harness.issue(IssueCode.SlowLoading)?.occurrences).toBe(1);
    });

    it('does not report when data arrives within the bound', (): void => {
        const harness = createPlayerHarness();
        harness.receiveAdmission();

        harness.tick(5_000);
        harness.player.markDataLoaded();
        harness.tick(20_000);

        expect(harness.activeIssueCodes()).not.toContain(IssueCode.SlowLoading);
    });

    it('a superseded load cancels the old timer and arms a new one', (): void => {
        const harness = createPlayerHarness();
        harness.receiveAdmission();

        harness.tick(10_000);
        void harness.controller.retry(); // a fresh load supersedes
        harness.tick(10_000); // 20s total, 10s into the new load
        expect(harness.activeIssueCodes()).not.toContain(IssueCode.SlowLoading);

        harness.player.markDataLoaded();
        harness.player.readyState = 0; // another slow load begins
        void harness.controller.retry();
        harness.tick(15_000);

        expect(harness.issue(IssueCode.SlowLoading)).toBeDefined();
    });

    it('never auto-reloads after reporting slow loading', (): void => {
        const harness = createPlayerHarness();
        harness.receiveAdmission();
        expect(harness.player.loadCalls).toBe(1);

        harness.tick(45_000);

        expect(harness.activeIssueCodes()).toContain(IssueCode.SlowLoading);
        expect(harness.player.loadCalls).toBe(1); // recovery stays manual
    });
});

describe('playback controller: recovery API', (): void => {
    it('retry rebuilds the media, resolves the incident, and plays', async (): Promise<void> => {
        const harness = createPlayerHarness();
        harness.receiveAdmission();
        harness.player.markMetadata(3_600);
        await harness.receivePlayingState({ position: 10, revision: 1 });

        harness.player.failWithError(2); // network incident
        expect(harness.activeIssueCodes()).toContain(IssueCode.MediaNetwork);

        await harness.controller.retry();
        harness.player.markMetadata(3_600);
        harness.player.markDataLoaded();
        await harness.settle();

        expect(harness.player.loadCalls).toBe(2);
        expect(harness.activeIssueCodes()).not.toContain(IssueCode.MediaNetwork);
        expect(harness.player.paused).toBe(false);
    });

    it('a retry outcome cannot overwrite a newer pause (stale token)', async (): Promise<void> => {
        const harness = createPlayerHarness();
        harness.receiveAdmission();
        harness.player.markMetadata(3_600);
        harness.player.deferPlay = true;

        void harness.controller.retry();
        await harness.receivePausedState({ position: 1, revision: 1 });
        expect(harness.player.paused).toBe(true);

        harness.player.settleNextPlay(); // the retry's play finally succeeds
        await harness.settle();

        expect(harness.player.paused).toBe(true);
    });

    it('startPlayback seeks the viewer back to the projected position', async (): Promise<void> => {
        const harness = createPlayerHarness({ playError: playRejection('NotAllowedError') });
        harness.receiveAdmission();
        harness.player.markMetadata(3_600);

        await harness.receivePlayingState({ position: 100, revision: 1 });
        expect(harness.player.currentTime).toBe(100);

        await harness.controller.startPlayback();

        expect(harness.player.paused).toBe(false);
        expect(harness.sent).toEqual([]); // viewer-local only
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

        // A genuine pause (no programmatic marker) emits exactly one command,
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

