import { createIssueStore, IssueStore } from '../../src/diagnostics/issues';
import { Issue, IssueCode } from '../../src/diagnostics/snapshot';
import {
    createPlaybackController,
    PlaybackController,
    PlaybackControllerDeps,
    PlaybackSourceChild,
    PlaybackTrackChild,
} from '../../src/playback/controller';
import { normalizeMediaId, PlaybackSnapshot } from '../../src/shared';

/**
 * Node test vehicle for the playback controller (Task 6).
 *
 * Everything EXCEPT the native media element boundary is real: the REAL
 * controller, the REAL issue store, and the REAL projection clock (driven by
 * an injectable virtual timeline). The fake element reproduces the observable
 * behaviors of an HTMLMediaElement the controller relies on:
 *
 * - play()/pause() flip `paused` and fire the matching native event on
 *   success (a rejected play leaves `paused` untouched and fires nothing);
 * - a currentTime write fires `seeking` + `seeked` synchronously (browsers
 *   fire `seeked` asynchronously; nothing in the controller depends on the
 *   delay — the programmatic-seek marker stays pending until it fires);
 * - load() resets readiness and fires `abort` + `emptied`, which the
 *   controller must ignore;
 * - volume writes fire `volumechange`.
 *
 * The fake socket is only the command CHANNEL (captures emits); server events
 * are delivered through the same handle* methods movie.ts forwards to.
 */

/** One captured outgoing command announce/emit. */
export interface SentCommand {
    readonly kind: 'command' | 'announce';
    readonly event: string;
    readonly payload: unknown;
}

/** Injectable virtual timeline: monotonic clock + cancellable timers. */
class FakeTimeline {
    private nowMs = 0;
    private seq = 0;
    private readonly tasks = new Map<number, { at: number; run: () => void }>();

    public readonly now = (): number => this.nowMs;

    public readonly schedule = (run: () => void, ms: number): unknown => {
        this.seq += 1;
        this.tasks.set(this.seq, { at: this.nowMs + Math.max(0, ms), run });
        return this.seq;
    };

    public readonly cancel = (handle: unknown): void => {
        if (typeof handle === 'number') {
            this.tasks.delete(handle);
        }
    };

    /** Advances virtual time, firing every timer that comes due (in order). */
    public advance(ms: number): void {
        this.nowMs += ms;
        for (;;) {
            let dueHandle: number | undefined;
            let dueAt = Number.POSITIVE_INFINITY;
            for (const [handle, task] of this.tasks) {
                if (task.at <= this.nowMs && task.at < dueAt) {
                    dueHandle = handle;
                    dueAt = task.at;
                }
            }
            if (dueHandle === undefined) {
                return;
            }
            const task = this.tasks.get(dueHandle);
            this.tasks.delete(dueHandle);
            if (task !== undefined) {
                task.run();
            }
        }
    }
}

type ElementListener = (event: FakeMediaEvent) => void;

/** What the fake stores as element children (source or track fakes). */
type PlaybackChildLike = PlaybackSourceChild | PlaybackTrackChild;

/** Structural stand-in for a DOM event aimed at the element or a child. */
export interface FakeMediaEvent {
    readonly type: string;
    readonly target: unknown;
}

/** Structural stand-in for MediaError. */
export interface FakeMediaError {
    readonly code: number;
}

/** The fake native boundary: a controllable HTMLMediaElement stand-in. */
export class FakeMediaElement {
    public paused = true;
    public ended = false;
    public readyState = 0;
    public duration = Number.NaN;
    public error: FakeMediaError | null = null;
    public controls = false;
    public hidden = true;
    public volume = 1;
    public currentTime = 0;

    public playCalls = 0;
    public pauseCalls = 0;
    public loadCalls = 0;

    /** Rejections for upcoming play() calls, consumed oldest-first. */
    public readonly playRejections: unknown[] = [];

    /**
     * When true, play() promises stay pending until the test settles them
     * (real elements resolve only once playback actually starts).
     */
    public deferPlay = false;
    private readonly pendingPlays: {
        resolve: () => void;
        reject: (error: unknown) => void;
    }[] = [];

    private currentTimeInternal = 0;
    private readonly listeners = new Map<string, { listener: ElementListener; capture: boolean }[]>();
    private childrenInternal: PlaybackChildLike[] = [];

    public constructor() {
        Object.defineProperty(this, 'currentTime', {
            get: (): number => this.currentTimeInternal,
            set: (value: number): void => {
                if (!Number.isFinite(value) || value < 0) {
                    return;
                }
                if (value === this.currentTimeInternal) {
                    return;
                }
                this.currentTimeInternal = value;
                // Seeking clears the ended state, as in real elements.
                this.ended = false;
                this.dispatch('seeking');
                this.dispatch('seeked');
            },
        });
    }

    public get children(): readonly PlaybackChildLike[] {
        return this.childrenInternal;
    }

    public get sourceChildren(): readonly PlaybackSourceChild[] {
        return this.children.filter((child): child is PlaybackSourceChild => !('kind' in child));
    }

    public get trackChildren(): readonly PlaybackTrackChild[] {
        return this.children.filter((child): child is PlaybackTrackChild => 'kind' in child);
    }

    // --- DOM-ish surface -----------------------------------------------------

    public play(): Promise<void> {
        this.playCalls += 1;
        const rejection = this.playRejections.shift();
        if (rejection !== undefined) {
            // The harness plays the browser here; callers seed Errors
            // (DOMException) or deliberate garbage to test robustness.
            const reason: Error = rejection as Error;
            return Promise.reject(reason);
        }
        this.paused = false;
        this.dispatch('play');
        if (this.deferPlay) {
            return new Promise<void>((resolve: () => void, reject: (error: unknown) => void): void => {
                this.pendingPlays.push({ resolve, reject });
            });
        }
        return Promise.resolve();
    }

    /** Settles the oldest deferred play() promise (rejects with `error`). */
    public settleNextPlay(error?: unknown): void {
        const pending = this.pendingPlays.shift();
        if (pending === undefined) {
            return;
        }
        if (error !== undefined) {
            pending.reject(error);
            return;
        }
        pending.resolve();
    }

    public pause(): void {
        this.pauseCalls += 1;
        if (this.paused) {
            return;
        }
        this.paused = true;
        this.dispatch('pause');
    }

    public load(): void {
        this.loadCalls += 1;
        this.readyState = 0;
        this.error = null;
        this.paused = true;
        this.dispatch('abort');
        this.dispatch('emptied');
    }

    public replaceChildren(...children: unknown[]): void {
        this.childrenInternal = children as PlaybackChildLike[];
    }

    public addEventListener(
        type: string,
        listener: ElementListener,
        options?: { readonly capture?: boolean },
    ): void {
        const capture = options?.capture === true;
        const existing = this.listeners.get(type) ?? [];
        existing.push({ listener, capture });
        this.listeners.set(type, existing);
    }

    public removeEventListener(
        type: string,
        listener: ElementListener,
        options?: { readonly capture?: boolean },
    ): void {
        const capture = options?.capture === true;
        const existing = this.listeners.get(type) ?? [];
        this.listeners.set(
            type,
            existing.filter((entry) => entry.listener !== listener || entry.capture !== capture),
        );
    }

    // --- Test controls --------------------------------------------------------

    /** Fires an event at the element (both capture and bubble listeners). */
    public dispatch(type: string): void {
        for (const { listener } of this.listeners.get(type) ?? []) {
            listener({ type, target: this });
        }
    }

    /**
     * Fires a resource-load error at a child <source>, as browsers do when a
     * source child fails: the event targets the CHILD, never the element.
     */
    public dispatchChildError(child: unknown): void {
        for (const { listener, capture } of this.listeners.get('error') ?? []) {
            if (capture) {
                listener({ type: 'error', target: child });
            }
        }
    }

    /** Simulates metadata arriving (with a known duration). */
    public markMetadata(duration: number): void {
        this.readyState = Math.max(this.readyState, 1);
        this.duration = duration;
        this.dispatch('loadedmetadata');
    }

    /** Simulates the first usable frame (HAVE_CURRENT_DATA). */
    public markDataLoaded(): void {
        this.readyState = Math.max(this.readyState, 2);
        this.dispatch('loadeddata');
        this.dispatch('canplay');
    }

    /** Simulates playback reaching the end while playing. */
    public markEnded(): void {
        this.ended = true;
        this.paused = true;
        this.dispatch('pause');
        this.dispatch('ended');
    }

    /** Simulates a fatal element error (MEDIA_ERR_* code). */
    public failWithError(code: number): void {
        this.error = { code };
        this.dispatch('error');
    }
}
export interface PlayerHarnessOptions {
    /** Configured movie file identity; the source URL is `data/<file>`. */
    readonly file?: string;
    /** Subtitles config (tracks appended on load). */
    readonly subtitles?: readonly { label: string; srclang: string; file: string }[];
    /** Rejection thrown by the FIRST play() call (queue more via the player). */
    readonly playError?: unknown;
    /** Volume returned by the injected preference source. */
    readonly initialVolume?: number;
}

export interface PlayerHarness {
    /** The fake native media element (also the assertion surface for it). */
    readonly player: FakeMediaElement;
    /** The real controller under test (recovery API access). */
    readonly controller: PlaybackController;
    /** Real diagnostics store; snapshot() reads active issues. */
    readonly store: IssueStore;
    /** Every outgoing command/announce, in order. */
    readonly sent: readonly SentCommand[];
    /** Volume values persisted via volumechange, in order. */
    readonly persistedVolumes: readonly number[];
    /** How many times the reload recovery action ran. */
    readonly reloads: number;
    /** Advances virtual time (fires due timers). */
    tick(ms: number): void;

    // Socket-side simulation (what movie.ts forwards to the controller).
    // Every receive is async so `await` settles one microtask layer: play()
    // rejections and success continuations from the delivery run first.

    receiveAccepted(isAdmin: boolean): void;
    receiveAdmission(snapshot?: Partial<PlaybackSnapshot>): void;
    receivePlayingState(snapshot: Partial<PlaybackSnapshot> & { position: number; revision: number }): Promise<void>;
    receivePausedState(snapshot: Partial<PlaybackSnapshot> & { position: number; revision: number }): Promise<void>;
    receiveSeekedState(snapshot: Partial<PlaybackSnapshot> & { position: number; revision: number }): Promise<void>;
    receiveState(snapshot: Partial<PlaybackSnapshot> & { position: number; revision: number }): Promise<void>;
    /** Simulates the socket transport going away. */
    disconnect(reason?: string): void;
    /** Simulates the socket (re)connecting; readmission follows via receiveAdmission. */
    reconnect(): void;
    /** Active issue codes (order irrelevant). */
    activeIssueCodes(): string[];
    /** The active issue with this code, or undefined. */
    issue(code: IssueCode): Issue | undefined;
    /** Lets pending promise continuations (play resolves/rejects) run. */
    settle(): Promise<void>;
}

/** Builds a harness around a REAL controller with a fake native boundary. */
export function createPlayerHarness(options: PlayerHarnessOptions = {}): PlayerHarness {
    const file = options.file ?? 'film-a.mp4';
    const player = new FakeMediaElement();
    if (options.playError !== undefined) {
        player.playRejections.push(options.playError);
    }

    const timeline = new FakeTimeline();
    const store = createIssueStore(timeline.now);
    const sent: SentCommand[] = [];
    const persistedVolumes: number[] = [];
    const state = { reloads: 0 };

    const deps: PlaybackControllerDeps = {
        element: player,
        channel: {
            sendCommand: (event, payload): void => {
                sent.push({ kind: 'command', event, payload });
            },
            announceMedia: (mediaId): void => {
                sent.push({ kind: 'announce', event: 'cinema:select', payload: mediaId });
            },
        },
        store,
        media: {
            source: `data/${file}`,
            type: 'video/mp4',
            // Same derivation config.ts applies: unusable files have no
            // media identity at all.
            mediaId: normalizeMediaId(file),
            subtitles: options.subtitles ?? [],
        },
        createElement: {
            createSource: (src, type): PlaybackSourceChild => ({ src, type }),
            createTrack: (label, srclang, src): PlaybackTrackChild => ({
                kind: 'subtitles',
                label,
                srclang,
                src,
                default: false,
            }),
        },
        now: timeline.now,
        timers: { schedule: timeline.schedule, cancel: timeline.cancel },
        volume: {
            initial: (): number => options.initialVolume ?? 0.15,
            persist: (volume): void => {
                persistedVolumes.push(volume);
            },
        },
        reloadPage: (): void => {
            state.reloads += 1;
        },
    };

    const controller = createPlaybackController(deps);

    function baseSnapshot(overrides: Partial<PlaybackSnapshot>): PlaybackSnapshot {
        return {
            mediaId: file,
            playing: false,
            position: 0,
            revision: 0,
            ...overrides,
        };
    }

    function issueFor(code: IssueCode): Issue | undefined {
        return store.getIssueSnapshot().issues.find((current) => current.code === code);
    }

    return {
        player,
        controller,
        store,
        sent,
        persistedVolumes,
        get reloads(): number {
            return state.reloads;
        },
        tick: (ms): void => {
            timeline.advance(ms);
        },

        receiveAccepted: (isAdmin): void => {
            controller.handleAccepted(isAdmin);
        },
        receiveAdmission: (snapshot): void => {
            controller.handleAdmission(baseSnapshot(snapshot ?? {}));
        },
        receivePlayingState: async (snapshot): Promise<void> => {
            controller.handleSnapshot('playing', baseSnapshot({ ...snapshot, playing: true }));
            await Promise.resolve();
        },
        receivePausedState: async (snapshot): Promise<void> => {
            controller.handleSnapshot('paused', baseSnapshot({ ...snapshot, playing: false }));
            await Promise.resolve();
        },
        receiveSeekedState: async (snapshot): Promise<void> => {
            // Unlike pause, a seek keeps the room's playing state as-is.
            controller.handleSnapshot('seeked', baseSnapshot(snapshot));
            await Promise.resolve();
        },
        receiveState: async (snapshot): Promise<void> => {
            controller.handleSnapshot('state', baseSnapshot(snapshot));
            await Promise.resolve();
        },
        disconnect: (reason = 'transport close'): void => {
            controller.handleDisconnect(reason);
        },
        reconnect: (): void => {
            controller.handleConnect();
        },
        activeIssueCodes: (): string[] => store.getIssueSnapshot().issues.map((current) => current.code),
        issue: issueFor,
        settle: async (): Promise<void> => {
            await Promise.resolve();
            await Promise.resolve();
        },
    };
}

/** Convenience for building the DOMException play() rejections produce. */
export function playRejection(name: string): DOMException {
    return new DOMException('harness play failure', name);
}
