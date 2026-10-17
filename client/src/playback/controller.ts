import { IssueStore } from '../diagnostics/issues';
import { IssueCode } from '../diagnostics/snapshot';
import type { SubtitleSettings } from '../config';
import { createProjectionClock, ProjectionClock } from './clock';
import { classifyMediaErrorCode, classifyPlayRejection } from './mediaErrors';
import {
    ClientEvents,
    isPlaybackSnapshot,
    PlaybackCommand,
} from '../shared';

/**
 * The playback state machine. Every mutation bumps opToken, and stale
 * async work checks it and bails. All platform boundaries are injected.
 */

/** Which broadcast a snapshot arrived on. Seeked applies exactly. */
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

/** A <source> child. */
export interface PlaybackSourceChild {
    src: string;
    type: string;
}

/** A <track> child. */
export interface PlaybackTrackChild {
    kind: string;
    label: string;
    srclang: string;
    src: string;
    default: boolean;
}

/** Structural stand-in for the DOM events the element and its children fire. */
export interface PlaybackMediaEvent {
    readonly type: string;
    /** The element, or the failing child for source errors. */
    readonly target: unknown;
}


export interface PlaybackMediaElement {
    readonly paused: boolean;
    readonly ended: boolean;
    readonly readyState: number;
    readonly duration: number;
    readonly error: PlaybackMediaError | null;
    controls: boolean;
    /** The DOM lib types this loosely, runtime is boolean. */
    hidden: boolean | string;
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


export interface PlaybackElementFactory {
    createSource(src: string, type: string): PlaybackSourceChild;
    createTrack(label: string, srclang: string, src: string): PlaybackTrackChild;
}


export interface PlaybackChannel {

    sendCommand(event: PlaybackCommandEvent, command: PlaybackCommand): void;
    /** Announces the configured media identity at host admission. */
    announceMedia(mediaId: string): void;
}


export interface PlaybackTimers {
    schedule(handler: () => void, ms: number): unknown;
    cancel(handle: unknown): void;
}


export interface VolumePreferences {
    initial(): number;
    persist(volume: number): void;
}


export interface PlaybackMediaConfig {
    /** Resolved source URL, e.g. 'data/film.mp4'. */
    readonly source: string;

    readonly type: string;
    /** Null when settings are unusable. */
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
    /** Connection.Accepted payload, whether this client holds the host seat. */
    handleAccepted(isAdmin: boolean): void;
    /** Cinema.Users payload (admission or readmission). The snapshot is untrusted. */
    handleAdmission(snapshot: unknown): void;
    /** A playback broadcast. The snapshot is untrusted. */
    handleSnapshot(kind: SnapshotKind, snapshot: unknown): void;
    /** Cinema.CommandRejected payload, untrusted. */
    handleCommandRejected(rejection: unknown): void;
    /** The socket connected, starting a new revision epoch. */
    handleConnect(): void;
    /** The socket disconnected. `reason` is the socket.io reason. */
    handleDisconnect(reason: string): void;
    /** Recovery: play this viewer from a user gesture, with no room command. */
    startPlayback(): Promise<void>;
    /** Recovery: fresh load of the current media, then play. */
    retry(): Promise<void>;
    /** Recovery: reload the page (media mismatch). */
    reload(): void;
    /** Detaches listeners and cancels timers. */
    dispose(): void;
}

/** readyState where duration and currentTime become meaningful. */
const HAVE_METADATA = 1;

/** Drift threshold for continuous snapshots. Host seeks apply exactly. */
const DRIFT_THRESHOLD_SECONDS = 5;

/** Tolerance for an exact seek, absorbs player rounding. */
const SEEK_EPSILON_SECONDS = 0.25;


const HAVE_CURRENT_DATA = 2;

/** Bound on waiting for the first usable frame before a SlowLoading report. */
const SLOW_LOAD_MS = 15_000;

/** Issue codes a successful data load clears. */
const MEDIA_ISSUE_CODES: readonly IssueCode[] = [
    IssueCode.MediaNetwork,
    IssueCode.MediaDecode,
    IssueCode.MediaUnusable,
    IssueCode.SlowLoading,
];

export function createPlaybackController(deps: PlaybackControllerDeps): PlaybackController {
    const { element, channel, store, media, createElement } = deps;
    const now = deps.now ?? ((): number => performance.now());
    const timers: PlaybackTimers =
        deps.timers ??
        {
            schedule: (handler: () => void, ms: number): unknown => {
                return setTimeout(handler, ms);
            },
            cancel: (handle: unknown): void => {
                clearTimeout(handle as ReturnType<typeof setTimeout>);
            },
        };
    const projection: ProjectionClock = createProjectionClock(now);
    const volume = deps.volume ?? {
        initial: (): number => 0.15,
        persist: (): void => undefined,
    };

    /** Stale async work checks this and bails. */
    let opToken = 0;

    /**
     * Chromium fires isTrusted events for script initiated play() too, so
     * each programmatic call leaves a marker that its native event consumes.
     * An unmarked event came from the user. Markers only get reserved when
     * the event will actually fire, and a refused play hands its marker back.
     */
    const programmatic = { plays: 0, pauses: 0, seeks: 0 };

    let isAdmin = false;
    /** Snapshots only arrive over a live socket. */
    let connected = true;
    let playInFlight = false;

    let loadedMediaId: string | null = null;
    /** Bumped on every load restart so deferred load work can bail. */
    let loadGeneration = 0;
    /** A seek deferred until loadedmetadata, and whether it is exact. */
    let deferredSeek: { readonly load: number; readonly exact: boolean } | null = null;

    // --- diagnostics helpers --------------------------------------------------

    function report(code: IssueCode, detail?: unknown): void {
        store.reportIssue({
            code,
            ...(media.mediaId !== null ? { mediaId: media.mediaId } : {}),
            ...(detail !== undefined ? { detail } : {}),
        });
    }


    function resolveIssues(codes: readonly IssueCode[]): void {
        for (const issue of store.getIssueSnapshot().issues) {
            if (codes.includes(issue.code)) {
                store.resolveIssue(issue.id);
            }
        }
    }


    function invalidateCurrentLoad(): void {
        opToken += 1;
        loadGeneration += 1;
        deferredSeek = null;
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
                // A refused play fires no event, so hand the marker back.
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
        if (element.paused) {
            // pause only fires on a playing to paused transition, so no marker.
            return;
        }
        programmatic.pauses += 1;
        element.pause();
    }

    // --- slow-load bound ---------------------------------------------------------

    let slowLoadHandle: unknown;

    /** One-shot slow-load warning. */
    function armSlowLoadTimer(): void {
        if (slowLoadHandle !== undefined) {
            timers.cancel(slowLoadHandle);
            slowLoadHandle = undefined;
        }
        const generation = loadGeneration;
        slowLoadHandle = timers.schedule((): void => {
            slowLoadHandle = undefined;
            if (generation !== loadGeneration || element.readyState >= HAVE_CURRENT_DATA) {
                return;
            }
            report(IssueCode.SlowLoading);
        }, SLOW_LOAD_MS);
    }

    function cancelSlowLoadTimer(): void {
        if (slowLoadHandle !== undefined) {
            timers.cancel(slowLoadHandle);
            slowLoadHandle = undefined;
        }
    }


    function onDataUsable(): void {
        if (element.readyState < HAVE_CURRENT_DATA) {
            return;
        }
        cancelSlowLoadTimer();
        resolveIssues(MEDIA_ISSUE_CODES);
    }

    // --- reconciliation ----------------------------------------------------------


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

    /** Defers until metadata so the latest projection wins. */
    function applyPosition(target: number, exact: boolean): void {
        if (element.readyState < HAVE_METADATA) {
            // Exactness is sticky across re-deferred seeks.
            const pendingExact = deferredSeek?.exact === true || exact;
            deferredSeek = { load: loadGeneration, exact: pendingExact };
            return;
        }
        opToken += 1; // a seek invalidates in-flight play results
        programmatic.seeks += 1;
        element.currentTime = target;
    }


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

    /** A usable same-media load is reused on readmission. */
    function ensureMediaLoaded(force = false): void {
        if (media.mediaId === null) {
            return;
        }
        if (
            !force &&
            loadedMediaId === media.mediaId &&
            element.readyState >= HAVE_METADATA &&
            element.error === null
        ) {
            return;
        }

        loadedMediaId = media.mediaId;

        invalidateCurrentLoad();
        armSlowLoadTimer();

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
            // The room watches different media, so pause locally only.
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

    /** Runs any deferred seek with a fresh projection once metadata lands. */
    function onLoadedMetadata(): void {
        const pending = deferredSeek;
        deferredSeek = null;
        if (pending?.load !== loadGeneration) {
            return;
        }
        reconcile(pending.exact);
    }

    /** Child <source> errors only show up in the capture phase. */
    function onMediaError(event: { readonly target: unknown }): void {
        if (event.target !== (element as unknown)) {
            // A child failed, and there is no code to read, so it stays unknown.
            const unusable = classifyMediaErrorCode(undefined);
            if (unusable !== null) {
                report(unusable);
            }
            return;
        }
        const code = element.error?.code;
        const classified = classifyMediaErrorCode(code);
        if (classified === null) {
            return;
        }
        report(classified, code !== undefined ? { code } : undefined);
    }

    // Buffering is a diagnostic, not an issue.
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
            // Nothing to command with, so report why nothing syncs.
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
        ['loadeddata', onDataUsable],
        ['canplay', onDataUsable],
        // Capture so child <source> errors reach us.
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


    function startPlaybackInternal(): Promise<void> {
        if (media.mediaId === null) {
            report(IssueCode.InvalidConfiguration);
            return Promise.resolve();
        }
        playInFlight = false;
        reconcile(false);
        return Promise.resolve();
    }

    function handleAdmission(snapshot: unknown): void {
        element.hidden = false;
        element.controls = true;
        element.volume = volume.initial();
        // Admission means the connection is alive again.
        resolveIssues([IssueCode.ConnectionLost]);
        ensureMediaLoaded();

        if (isAdmin && media.mediaId !== null) {
            // Announced at admission, when the server's select listener exists.
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
            // Rejections and garbage both surface as InvalidServerState.
            report(IssueCode.InvalidServerState, rejection);
        },

        handleConnect: (): void => {
            // A restarted server may restart its revision counter.
            projection.resetEpoch();
            connected = true;
        },

        handleDisconnect: (reason: string): void => {

            connected = false;
            isAdmin = false;
            invalidateCurrentLoad();
            element.pause();
            element.controls = false;
            element.hidden = true;
            projection.resetEpoch();
            if (reason === 'transport close' || reason === 'transport error' || reason === 'ping timeout') {
                // Transport loss gets the reconnect flow, kicks and bans don't.
                store.reportIssue({ code: IssueCode.ConnectionLost });
            }
        },

        startPlayback: (): Promise<void> => startPlaybackInternal(),

        retry: async (): Promise<void> => {
            if (media.mediaId === null) {
                report(IssueCode.InvalidConfiguration);
                return;
            }
            // A fresh load of the current media, then attempt playback.
            ensureMediaLoaded(true);
            await startPlaybackInternal();
        },

        reload: (): void => {
            (deps.reloadPage ?? ((): void => undefined))();
        },

        dispose: (): void => {
            opToken += 1;
            cancelSlowLoadTimer();
            for (const [type, listener, capture] of elementListeners) {
                element.removeEventListener(type, listener, capture === true ? { capture: true } : undefined);
            }
        },
    };
}
