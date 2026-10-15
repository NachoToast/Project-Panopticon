/**
 * Data contract for the diagnostics layer.
 *
 * This module owns the shapes shared between the issue store, the runtime
 * handlers, and (in PR 2) the UI. It must stay presentation-free and must
 * never import from controllers, styles, or other application modules.
 */

/** Maximum retained diagnostic events; oldest entries are evicted first. */
export const DIAGNOSTIC_HISTORY_LIMIT = 50;

/** Maximum simultaneously active issues; the least recently reported is evicted. */
export const ACTIVE_ISSUE_LIMIT = 16;

/** How disruptive an issue is to the core experience. */
export const enum Severity {
    Info = 'info',
    Warning = 'warning',
    Critical = 'critical',
}

/** User-initiated recovery actions an issue permits. */
export const enum RecoveryAction {
    /** Try the failed operation again (e.g. attempt playback once more). */
    Retry = 'retry',
    /** Reload the page. */
    Reload = 'reload',
    /** Ask the socket to reconnect. */
    Reconnect = 'reconnect',
}

/**
 * Canonical issue codes. These are the keys PR 2's message catalog will use;
 * they are also the only error identifiers that ever reach user-facing text.
 */
export const enum IssueCode {
    /** Playback is waiting for a user gesture before it can start. */
    PlaybackInteractionRequired = 'playback-interaction-required',
    /** The media request failed at the network layer (MEDIA_ERR_NETWORK). */
    MediaNetwork = 'media-network',
    /** The media data could not be decoded (MEDIA_ERR_DECODE). */
    MediaDecode = 'media-decode',
    /** The media source cannot be used (MEDIA_ERR_SRC_NOT_SUPPORTED). */
    MediaUnusable = 'media-unusable',
    /** The local media does not match what the room is watching. */
    MediaMismatch = 'media-mismatch',
    /** Loading is progressing slower than the configured threshold. */
    SlowLoading = 'slow-loading',
    /** The connection to the room was lost. */
    ConnectionLost = 'connection-lost',
    /** Browser storage is unavailable. */
    StorageUnavailable = 'storage-unavailable',
    /** The server sent state the client cannot interpret. */
    InvalidServerState = 'invalid-server-state',
    /** Application bootstrap failed (module load or initialization). */
    AppInit = 'app-init',
    /** Any failure that does not map to a known code. */
    Unexpected = 'unexpected',
}

/** Fixed definition for a known issue code. Messages are neutral and actionable. */
export interface IssueDefinition {
    readonly code: IssueCode;
    readonly message: string;
    readonly severity: Severity;
    /** True when the issue prevents the core experience until resolved. */
    readonly blocking: boolean;
    readonly recoveryActions: readonly RecoveryAction[];
}

/** An active (or recently reported) issue incident, as exposed to subscribers. */
export interface Issue {
    /** Stable identifier for this incident (module-local counter). */
    readonly id: string;
    /** Incident identity key; see the store's documented keying scheme. */
    readonly key: string;
    readonly code: IssueCode;
    /** Local media element identifier, when the issue is media-scoped. */
    readonly mediaId?: string;
    readonly message: string;
    readonly severity: Severity;
    readonly blocking: boolean;
    readonly recoveryActions: readonly RecoveryAction[];
    /** How many reports were folded into this incident. */
    readonly occurrences: number;
    /** Last seen numeric media error code (MEDIA_ERR_*), if any. */
    readonly mediaErrorCode?: number;
    readonly firstSeen: number;
    readonly lastSeen: number;
}

/** Immutable view of the active issue set, replayed to every new subscriber. */
export interface IssueSnapshot {
    readonly issues: readonly Issue[];
}

/** Listener notified with a fresh snapshot whenever active issues change. */
export type IssueListener = (snapshot: IssueSnapshot) => void;

/**
 * Input accepted by `IssueStore.reportIssue`. Every field is normalized at
 * runtime: garbage codes collapse to `Unexpected`, and `error`/`detail` are
 * never stringified into user-visible or persisted text.
 */
export interface IssueInput {
    readonly code?: IssueCode | string;
    readonly mediaId?: string;
    readonly error?: unknown;
    readonly detail?: unknown;
}

/**
 * Allowlisted diagnostic event. Fields are deliberately narrow: error *names*
 * (never messages), numeric media codes, boolean markers, and numeric
 * readings (booleans should be recorded as 0/1). Anything else is dropped.
 */
export interface DiagnosticEvent {
    /** Machine-readable event kind, e.g. 'window-error' or 'extension-error'. */
    readonly type: string;
    /** Epoch timestamp in milliseconds. */
    readonly at: number;
    readonly errorName?: string;
    readonly mediaErrorCode?: number;
    /** True when the event's script origin looked like a browser extension. */
    readonly extensionOrigin?: boolean;
    /** Numeric measurements (clock skew, readiness, buffer, frames, flags). */
    readonly readings?: Readonly<Record<string, number>>;
}
