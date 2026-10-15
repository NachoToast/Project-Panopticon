import { IssueStore } from '../diagnostics/issues';
import { IssueCode } from '../diagnostics/snapshot';
import type { SubtitleSettings } from '../config';
import { createProjectionClock, ProjectionClock } from './clock';
import { classifyMediaErrorCode, classifyPlayRejection } from './mediaErrors';
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

/** readyState value at which duration/currentTime become meaningful. */
const HAVE_METADATA = 1;

/**
 * Correction threshold for CONTINUOUS snapshots (Playing/Paused/State):
 * below it the element's own position is trusted; above it the room's
 * projected position is enforced. Deliberately NOT applied to seeked
 * snapshots — an explicit host seek is exact at any distance.
 */
const DRIFT_THRESHOLD_SECONDS = 5;

/** Tolerance for applying an EXACT seek (absorbs player rounding). */
const SEEK_EPSILON_SECONDS = 0.25;

export function createPlaybackController(deps: PlaybackControllerDeps): PlaybackController {
    const { element, channel, store, media, createElement } = deps;
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
    /** Media identity currently loaded into the element, if any. */
    let loadedMediaId: string | null = null;
    /**
     * Media-load generation: bumped by every load restart and disconnect.
     * Deferred work that belongs to a specific load (the metadata wait, the
     * slow-load timer) captures it and dies when the load is superseded.
     */
    let loadGeneration = 0;
    /**
     * A seek deferred until loadedmetadata, with the load generation it
     * belongs to and whether it must apply exactly (a host seek).
     */
    let deferredSeek: { readonly load: number; readonly exact: boolean } | null = null;

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
                // A refused play never fires a native play event, so the
                // suppression marker it reserved must be handed back —
                // otherwise the NEXT genuine play would be swallowed.
                programmatic.plays = Math.max(0, programmatic.plays - 1);
                if (token !== opToken) {
                    // A newer operation already decided differently.
                    return;
                }
                const name =
                    typeof failure === 'object' && failure !== null && 'name' in failure
                        ? (failure as { readonly name?: unknown }).name
                        : undefined;
                const code = classifyPlayRejection(typeof name === 'string' ? name : undefined);
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

    /** Clamps a position into [0, duration] when the duration is known. */
    function clampToDuration(position: number): number {
        const duration = element.duration;
        if (!Number.isFinite(duration) || duration <= 0) {
            return Math.max(0, position);
        }
        return Math.min(Math.max(0, position), duration);
    }

    function shouldSeek(target: number, exact: boolean): boolean {
        const tolerance = exact ? SEEK_EPSILON_SECONDS : DRIFT_THRESHOLD_SECONDS;
        return Math.abs(element.currentTime - target) > tolerance;
    }

    /**
     * Applies the projected position. Before metadata exists the element
     * cannot seek meaningfully (and the duration needed for clamping is
     * unknown), so the seek is deferred: it re-runs reconcile() when
     * loadedmetadata arrives, which re-projects — the LATEST target wins,
     * not the value first computed.
     */
    function applyPosition(target: number, exact: boolean): void {
        if (element.readyState < HAVE_METADATA) {
            const pendingExact = deferredSeek?.exact === true || exact;
            deferredSeek = { load: loadGeneration, exact: pendingExact };
            return;
        }        opToken += 1; // a seek invalidates in-flight play results
        programmatic.seeks += 1;
        element.currentTime = target;
    }

    /** Enforces the freshest projected snapshot on the element. */
    function reconcile(exact: boolean): void {
        if (!connected || mismatchActive) {
            return;
        }
        const projected = projection.project();
        if (projected === null) {
            return;
        }

        if (media.mediaId !== null) {
            const target = clampToDuration(projected.position);
            if (shouldSeek(target, exact)) {
                applyPosition(target, exact);
            }
        }

        if (projected.playing) {
            if (element.paused && !element.ended && media.mediaId !== null) {
                attemptPlay();
            }
        } else if (!element.paused) {
            pauseLocally();
        }
    }

    // --- media loading --------------------------------------------------------

    /**
     * Ensures the element holds the configured media. Idempotent: while the
     * element still carries a USABLE load of the same media (metadata known,
     * no fatal error), readmission reuses it — no re-append, no reload. Any
     * other state rebuilds the source children and restarts the load.
     */
    function ensureMediaLoaded(): void {
        if (media.mediaId === null) {
            return;
        }
        if (
            loadedMediaId === media.mediaId &&
            element.readyState >= HAVE_METADATA &&
            element.error === null
        ) {
            return;
        }

        loadedMediaId = media.mediaId;
        // A new load invalidates operations against the previous one.
        opToken += 1;
        loadGeneration += 1;
        deferredSeek = null;

        const children: (PlaybackSourceChild | PlaybackTrackChild)[] = [
            createElement.createSource(media.source, media.type),
        ];
        let sawFirstTrack = false;
        for (const subtitle of media.subtitles) {
            const track = createElement.createTrack(
                subtitle.label,
                subtitle.srclang,
                `data/${subtitle.file}`,
            );
            if (!sawFirstTrack) {
                // The first configured subtitle becomes the default track.
                track.default = true;
                sawFirstTrack = true;
            }
            children.push(track);
        }
        element.replaceChildren(...children);
        element.load();
    }

    // --- snapshot ingestion ------------------------------------------------------

    let mismatchActive = false;

    function ingestSnapshot(kind: SnapshotKind, raw: unknown): void {
        if (!isPlaybackSnapshot(raw)) {
            report(IssueCode.InvalidServerState, raw);
            return;
        }

        if (!projection.apply(raw)) {
            return; // stale revision for this connection epoch
        }

        if (
            media.mediaId !== null &&
            raw.mediaId !== null &&
            raw.mediaId !== media.mediaId
        ) {
            // The room watches different media: pause locally and surface
            // the mismatch, but never command the room back — the server
            // state stays authoritative and untouched.
            mismatchActive = true;
            pauseLocally();
            report(IssueCode.MediaMismatch);
            return;
        }

        if (mismatchActive) {
            mismatchActive = false;
            resolveIssues([IssueCode.MediaMismatch]);
        }

        reconcile(kind === 'seeked');
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
            reconcile(false);
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
            reconcile(false);
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
            reconcile(false);
        }
    }

    /** loadedmetadata: duration is known; run any deferred seek with a FRESH projection. */
    function onLoadedMetadata(): void {
        const pending = deferredSeek;
        deferredSeek = null;
        if (pending?.load !== loadGeneration) {
            return;
        }
        reconcile(pending.exact);
    }

    /**
     * One handler for element AND child-source error events (the listener is
     * registered in the capture phase, where child-target errors are visible
     * — they never bubble). Element errors carry element.error; a failing
     * <source> child carries no code, so it stays unknown and reports the
     * source as unusable. Deliberate aborts classify to null.
     */
    function onMediaError(event: { readonly target: unknown }): void {
        if (event.target !== (element as unknown)) {
            // A <source> child failed: no code available (stays unknown).
            const unusable = classifyMediaErrorCode(undefined);
            if (unusable !== null) {
                store.reportIssue({
                    code: unusable,
                    ...(media.mediaId !== null ? { mediaId: media.mediaId } : {}),
                });
            }
            return;
        }
        const code = element.error?.code;
        const classified = classifyMediaErrorCode(code);
        if (classified === null) {
            return;
        }
        store.reportIssue({
            code: classified,
            ...(media.mediaId !== null ? { mediaId: media.mediaId } : {}),
            ...(code !== undefined ? { error: { code } } : {}),
        });
    }

    /** Buffering signals are diagnostics only — never issues. */
    function onBuffering(type: string): void {
        store.recordDiagnostic({
            type: `media-${type}`,
            readings: { readyState: element.readyState },
        });
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

    const elementListeners: readonly (readonly [
        string,
        (event: PlaybackMediaEvent) => void,
        boolean?,
    ])[] = [
        ['play', onNativePlay],
        ['pause', onNativePause],
        ['seeked', onNativeSeeked],
        ['loadedmetadata', onLoadedMetadata],
        ['volumechange', onVolumeChange],
        // Capture phase: child <source> errors never bubble to the element.
        ['error', (event): void => {
            onMediaError(event);
        }, true],
        ['waiting', (event): void => {
            onBuffering(event.type);
        }],
        ['stalled', (event): void => {
            onBuffering(event.type);
        }],
    ];

    for (const [type, listener, capture] of elementListeners) {
        element.addEventListener(type, listener, capture === true ? { capture: true } : undefined);
    }

    // --- public surface -------------------------------------------------------------

    function handleAdmission(snapshot: unknown): void {
        element.hidden = false;
        element.controls = true;
        element.volume = volume.initial();
        ensureMediaLoaded();

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
            loadGeneration += 1;
            deferredSeek = null;
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
            for (const [type, listener, capture] of elementListeners) {
                element.removeEventListener(type, listener, capture === true ? { capture: true } : undefined);
            }
        },
    };
}
