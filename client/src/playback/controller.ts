import { IssueStore } from '../diagnostics/issues';
import { IssueCode } from '../diagnostics/snapshot';
import { SubtitleSettings } from '../config';
import { createProjectionClock, ProjectionClock } from './clock';
import {
    ClientEvents,
    isCommandRejection,
    isPlaybackSnapshot,
    PlaybackCommand,
} from '../shared';

/**
 * The playback state machine (Task 6).
 *
 * The controller owns the whole playback lifecycle: admission media setup,
 * snapshot reconciliation through the projection clock, host command
 * emission, media-error classification, disconnect behavior, and recovery
 * actions. It is constructable with fakes in Node: every platform boundary
 * (native element, command channel, storage, timers, clock) is injected.
 * `controllers/movie.ts` is the thin browser wiring that constructs it with
 * the real page's element and socket.
 *
 * Async-safety model: every mutating operation (play/pause/seek attempt,
 * media load, disconnect) increments a single operation token. Continuations
 * capture the token and discard themselves when it has moved on, so a stale
 * play() rejection or metadata callback can never overwrite a newer
 * decision. Deliberate cancellations (a pause interrupting a play) are
 * expected, not errors.
 */

/** Which broadcast a snapshot arrived on; seeked snapshots apply exactly. */
export type SnapshotKind = 'playing' | 'paused' | 'seeked' | 'state';

/** Commands the controller may send on the cinema channel. */
export type PlaybackCommandEvent =
    | ClientEvents.Cinema.Play
    | ClientEvents.Cinema.Pause
    | ClientEvents.Cinema.Seek;

/** Structural stand-in for MediaError ({@link https://developer.mozilla.org/docs/Web/API/MediaError}). */
export interface PlaybackMediaError {
    readonly code: number;
}

/** A <source> child; `type` is the MIME type attribute. */
export interface PlaybackSourceChild {
    src: string;
    type: string;
}

/** A <track> child (subtitles). */
export interface PlaybackTrackChild {
    kind: string;
    label: string;
    srclang: string;
    src: string;
    default: boolean;
}

/** Structural stand-in for the DOM events the element/children fire. */
export interface PlaybackMediaEvent {
    readonly type: string;
    /** The element for element events, or the failing child for source errors. */
    readonly target: unknown;
}

/** The native media element boundary the controller drives. */
export interface PlaybackMediaElement {
    readonly paused: boolean;
    readonly ended: boolean;
    readonly readyState: number;
    readonly duration: number;
    readonly error: PlaybackMediaError | null;
    controls: boolean;
    hidden: boolean;
    volume: number;
    currentTime: number;
    play(): Promise<void>;
    pause(): void;
    load(): void;
    replaceChildren(...children: readonly unknown[]): void;
    addEventListener(
        type: string,
        listener: (event: PlaybackMediaEvent) => void,
        options?: { readonly capture?: boolean },
    ): void;
    removeEventListener(
        type: string,
        listener: (event: PlaybackMediaEvent) => void,
        options?: { readonly capture?: boolean },
    ): void;
}

/** Builds the <source>/<track> children for a media load. */
export interface PlaybackElementFactory {
    createSource(src: string, type: string): PlaybackSourceChild;
    createTrack(label: string, srclang: string, src: string): PlaybackTrackChild;
}

/** Outgoing cinema channel (the socket surface the controller needs). */
export interface PlaybackChannel {
    /** Sends a host playback command (play/pause/seek). */
    sendCommand(event: PlaybackCommandEvent, command: PlaybackCommand): void;
    /** Announces the configured media identity (host admission). */
    announceMedia(mediaId: string): void;
}

/** Cancellable timer scheduling (defaults to the platform timeouts). */
export interface PlaybackTimers {
    schedule(handler: () => void, ms: number): unknown;
    cancel(handle: unknown): void;
}

/** Volume preference source/sink (wired to safeStorage in the browser). */
export interface VolumePreferences {
    initial(): number;
    persist(volume: number): void;
}

/** The validated movie settings the controller loads media from. */
export interface PlaybackMediaConfig {
    /** Resolved source URL, e.g. 'data/film.mp4'. */
    readonly source: string;
    /** MIME type for the <source> child. */
    readonly type: string;
    /** Normalized media identity; null when settings are unusable. */
    readonly mediaId: string | null;
    readonly subtitles: readonly SubtitleSettings[];
}

export interface PlaybackControllerDeps {
    readonly element: PlaybackMediaElement;
    readonly channel: PlaybackChannel;
    readonly store: IssueStore;
    readonly media: PlaybackMediaConfig;
    readonly createElement: PlaybackElementFactory;
    readonly now?: () => number;
    readonly timers?: PlaybackTimers;
    readonly volume?: VolumePreferences;
    readonly reloadPage?: () => void;
}

export interface PlaybackController {
    /** Connection.Accepted payload: whether this client holds the host seat. */
    handleAccepted(isAdmin: boolean): void;
    /** Cinema.Users payload (admission/readmission); snapshot is untrusted. */
    handleAdmission(snapshot: unknown): void;
    /** A playback broadcast (Playing/Paused/Seeked/State); snapshot is untrusted. */
    handleSnapshot(kind: SnapshotKind, snapshot: unknown): void;
    /** Cinema.CommandRejected payload (untrusted). */
    handleCommandRejected(rejection: unknown): void;
    /** The socket connected (initial or reconnect): new revision epoch. */
    handleConnect(): void;
    /** The socket disconnected; `reason` is the socket.io disconnect reason. */
    handleDisconnect(reason: string): void;
    /** Recovery: user-gesture play of THIS viewer only (no room command). */
    startPlayback(): Promise<void>;
    /** Recovery: reload the current media (fresh source children) and play. */
    retry(): Promise<void>;
    /** Recovery: reload the page (media-mismatch resynchronization). */
    reload(): void;
    /** Detaches element listeners and cancels timers (test teardown). */
    dispose(): void;
}

/** The names play() rejections are classified by (see mediaErrors.ts). */
function classifyPlayRejectionName(name: string | undefined): IssueCode | null {
    if (name === 'NotAllowedError') {
        return IssueCode.PlaybackInteractionRequired;
    }
    if (name === 'AbortError') {
        // A newer play/pause/load interrupted this attempt: expected.
        return null;
    }
    if (name === 'NotSupportedError') {
        return IssueCode.MediaUnusable;
    }
    return IssueCode.Unexpected;
}

export function createPlaybackController(deps: PlaybackControllerDeps): PlaybackController {
    const { element, channel, store, media } = deps;
    const now = deps.now ?? ((): number => performance.now());
    const projection: ProjectionClock = createProjectionClock(now);
    const volume = deps.volume ?? {
        initial: (): number => 0.15,
        persist: (): void => undefined,
    };

    /**
     * Single mutation counter: play/pause enforcement and (later) loads and
     * disconnects bump it; async continuations capture it first and discard
     * themselves when it has moved on.
     */
    let opToken = 0;

    /**
     * Trusted-emit accounting: native events caused by the controller's own
     * play/pause/seek calls must not be mistaken for genuine user input.
     * Chromium fires UA `play`/`pause` events with isTrusted === true even
     * for script-initiated play() (probed in the browser suite), so trust is
     * decided by origin: each programmatic call leaves one marker, and the
     * matching native event consumes it.
     */
    const programmatic = { plays: 0, pauses: 0, seeks: 0 };

    let isAdmin = false;
    /**
     * Snapshots only arrive over a live socket, so the controller starts
     * optimistic; the first disconnect clears it and reconnection restores.
     */
    let connected = true;
    let playInFlight = false;

    // --- diagnostics helpers --------------------------------------------------

    function report(code: IssueCode, detail?: unknown): void {
        store.reportIssue({
            code,
            ...(media.mediaId !== null ? { mediaId: media.mediaId } : {}),
            ...(detail !== undefined ? { detail } : {}),
        });
    }

    /** Resolves every active issue with one of these codes. */
    function resolveIssues(codes: readonly IssueCode[]): void {
        for (const issue of store.getIssueSnapshot().issues) {
            if (codes.includes(issue.code)) {
                store.resolveIssue(issue.id);
            }
        }
    }

    // --- element enforcement ---------------------------------------------------

    function markProgrammaticPlay(): void {
        programmatic.plays += 1;
    }

    function attemptPlay(): void {
        if (playInFlight) {
            return;
        }
        playInFlight = true;
        const token = ++opToken;
        markProgrammaticPlay();
        element.play().then(
            (): void => {
                playInFlight = false;
                if (token !== opToken) {
                    return;
                }
                resolveIssues([IssueCode.PlaybackInteractionRequired]);
            },
            (failure: unknown): void => {
                playInFlight = false;
                if (token !== opToken) {
                    // A newer operation already decided differently.
                    return;
                }
                const name =
                    typeof failure === 'object' && failure !== null && 'name' in failure
                        ? (failure as { readonly name?: unknown }).name
                        : undefined;
                const code = classifyPlayRejectionName(typeof name === 'string' ? name : undefined);
                if (code !== null) {
                    report(code, failure);
                }
            },
        );
    }

    function pauseLocally(): void {
        opToken += 1;
        programmatic.pauses += 1;
        element.pause();
    }

    // --- reconciliation ----------------------------------------------------------

    /** Enforces the freshest projected snapshot on the element. */
    function reconcile(): void {
        if (!connected) {
            return;
        }
        const projected = projection.project();
        if (projected === null) {
            return;
        }

        if (projected.playing) {
            if (element.paused && !element.ended && media.mediaId !== null) {
                attemptPlay();
            }
        } else if (!element.paused) {
            pauseLocally();
        }
    }

    // --- snapshot ingestion ------------------------------------------------------

    function ingestSnapshot(kind: SnapshotKind, raw: unknown): void {
        if (!isPlaybackSnapshot(raw)) {
            report(IssueCode.InvalidServerState, raw);
            return;
        }

        if (!projection.apply(raw)) {
            return; // stale revision for this connection epoch
        }

        void kind; // seeked-vs-continuous distinction arrives with exact seeks
        reconcile();
    }

    // --- native event handlers ----------------------------------------------------

    function onNativePlay(): void {
        if (programmatic.plays > 0) {
            programmatic.plays -= 1;
            return;
        }
        if (isAdmin) {
            sendCommand(ClientEvents.Cinema.Play);
        } else {
            reconcile();
        }
    }

    function onNativePause(): void {
        if (programmatic.pauses > 0) {
            programmatic.pauses -= 1;
            return;
        }
        if (isAdmin) {
            sendCommand(ClientEvents.Cinema.Pause);
        } else {
            reconcile();
        }
    }

    function onNativeSeeked(): void {
        if (programmatic.seeks > 0) {
            programmatic.seeks -= 1;
            return;
        }
        if (isAdmin) {
            sendCommand(ClientEvents.Cinema.Seek);
        } else {
            reconcile();
        }
    }

    function sendCommand(event: PlaybackCommandEvent): void {
        if (!isAdmin || !connected) {
            return;
        }
        if (media.mediaId === null) {
            // No media identity to command with: report why nothing syncs.
            report(IssueCode.InvalidConfiguration);
            return;
        }
        const command: PlaybackCommand = { mediaId: media.mediaId, position: element.currentTime };
        channel.sendCommand(event, command);
    }

    function onVolumeChange(): void {
        volume.persist(element.volume);
    }

    const elementListeners: readonly (readonly [string, () => void])[] = [
        ['play', onNativePlay],
        ['pause', onNativePause],
        ['seeked', onNativeSeeked],
        ['volumechange', onVolumeChange],
    ];

    for (const [type, listener] of elementListeners) {
        element.addEventListener(type, listener);
    }

    // --- public surface -------------------------------------------------------------

    function handleAdmission(snapshot: unknown): void {
        element.hidden = false;
        element.controls = true;
        element.volume = volume.initial();

        if (isAdmin && media.mediaId !== null) {
            // Announced at admission, not on Connection.Accepted: the server
            // attaches its select listener in the same synchronous join block
            // that emits Cinema.Users. Re-announcing on reconnect is a no-op.
            channel.announceMedia(media.mediaId);
        }

        ingestSnapshot('state', snapshot);
    }

    return {
        handleAccepted: (admin: boolean): void => {
            isAdmin = admin;
        },

        handleAdmission,

        handleSnapshot: (kind: SnapshotKind, snapshot: unknown): void => {
            ingestSnapshot(kind, snapshot);
        },

        handleCommandRejected: (rejection: unknown): void => {
            // Rejections (and garbage where one should be) surface as
            // InvalidServerState; the dedicated UX lands in PR 2.
            if (!isCommandRejection(rejection)) {
                report(IssueCode.InvalidServerState, rejection);
                return;
            }
            report(IssueCode.InvalidServerState, rejection);
        },

        handleConnect: (): void => {
            // New connection epoch: the server may have restarted, so its
            // revision counter cannot be compared against the old baseline.
            projection.resetEpoch();
            connected = true;
        },

        handleDisconnect: (reason: string): void => {
            // Hardened in the disconnect-lifecycle slice; the safety basics
            // (pause, hide, epoch reset) are load-bearing from day one.
            connected = false;
            isAdmin = false;
            opToken += 1;
            element.pause();
            element.controls = false;
            element.hidden = true;
            projection.resetEpoch();
            if (reason === 'transport close' || reason === 'transport error' || reason === 'ping timeout') {
                // Transport-level loss gets the reconnect UX; server- and
                // client-initiated disconnects (kick/ban, deliberate close)
                // have their own flows.
                store.reportIssue({ code: IssueCode.ConnectionLost });
            }
        },

        startPlayback: (): Promise<void> => {
            if (media.mediaId === null) {
                report(IssueCode.InvalidConfiguration);
                return Promise.resolve();
            }
            playInFlight = false;
            attemptPlay();
            return Promise.resolve();
        },

        retry: (): Promise<void> => {
            // Media reload arrives with the slow-load/recovery slice.
            return Promise.resolve();
        },

        reload: (): void => {
            (deps.reloadPage ?? ((): void => undefined))();
        },

        dispose: (): void => {
            opToken += 1;
            for (const [type, listener] of elementListeners) {
                element.removeEventListener(type, listener);
            }
        },
    };
}
