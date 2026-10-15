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

/**
 * Derives a coarse engine family from a user agent. Deliberately
 * conservative: anything unparsable reports 'unknown'.
 */
export function detectEngineFamily(userAgent: string | undefined): string {
    if (typeof userAgent !== 'string') {
        return 'unknown';
    }
    if (userAgent.includes('Firefox/')) {
        return 'gecko';
    }
    if (userAgent.includes('Edg/') || userAgent.includes('Chrome/')) {
        return 'blink';
    }
    if (userAgent.includes('Safari/')) {
        return 'webkit';
    }
    return 'unknown';
}

/** Reads the current engine family without assuming a DOM global exists. */
export function currentEngineFamily(): string {
    const host = globalThis as { readonly navigator?: { readonly userAgent?: unknown } };
    const userAgent = host.navigator?.userAgent;
    return detectEngineFamily(typeof userAgent === 'string' ? userAgent : undefined);
}

/** Describes a value by kind only; the value itself never appears in output. */
export function describeValueKind(value: unknown): string {
    if (value === null) {
        return 'null';
    }
    if (typeof value === 'object') {
        return Array.isArray(value) ? 'array' : 'object';
    }
    return typeof value;
}

/**
 * Summarizes socket event arguments as an allowlisted description:
 * argument count plus per-argument kind strings. Values never appear.
 */
export function summarizeEventArgs(args: readonly unknown[]): string {
    if (args.length === 0) {
        return 'args=0';
    }
    const kinds = args.map((arg: unknown): string => describeValueKind(arg));
    return `args=${String(args.length)} [${kinds.join(', ')}]`;
}

/** Header line for exported diagnostics. */
export const DIAGNOSTICS_HEADER = 'Project Panopticon diagnostics';

const LOCAL_ONLY_NOTE = 'Local-only debug information. Nothing here is collected or uploaded.';
const MAX_READINGS_PER_EVENT = 8;
const SAFE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

function toIso(timestamp: number): string {
    return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : 'unknown-time';
}

function isSafeToken(value: string): boolean {
    return SAFE_TOKEN_PATTERN.test(value);
}

export { isSafeToken };

/** Everything `formatDiagnosticsReport` needs; already allowlisted. */
export interface DiagnosticsReportInput {
    readonly generatedAt: number;
    readonly engineFamily: string;
    readonly activeIssues: readonly Issue[];
    readonly diagnostics: readonly DiagnosticEvent[];
    readonly totalIncidentCount: number;
    readonly retiredIncidentCount: number;
}

/**
 * Renders a human-readable diagnostics report from allowlisted fields only.
 * Issue codes, error names, numeric codes/readings, markers, timestamps, and
 * coarse engine info may appear; usernames, URLs/IPs, tokens, messages, and
 * stacks may not.
 */
export function formatDiagnosticsReport(input: DiagnosticsReportInput): string {
    const lines: string[] = [
        DIAGNOSTICS_HEADER,
        LOCAL_ONLY_NOTE,
        `Generated: ${toIso(input.generatedAt)}`,
        `Engine: ${input.engineFamily}`,
        '',
        `Active issues (${String(input.activeIssues.length)}, ${String(input.retiredIncidentCount)} retired, ${String(input.totalIncidentCount)} total incidents):`,
    ];

    if (input.activeIssues.length === 0) {
        lines.push('  (none)');
    }
    for (const issue of input.activeIssues) {
        const parts = [
            `${issue.id} code=${issue.code}`,
            `severity=${issue.severity}`,
            `blocking=${issue.blocking ? 'yes' : 'no'}`,
            `occurrences=${String(issue.occurrences)}`,
            `first=${toIso(issue.firstSeen)}`,
            `last=${toIso(issue.lastSeen)}`,
        ];
        if (issue.mediaId !== undefined && isSafeToken(issue.mediaId)) {
            parts.push(`media=${issue.mediaId}`);
        }
        if (issue.mediaErrorCode !== undefined) {
            parts.push(`mediaErrorCode=${String(issue.mediaErrorCode)}`);
        }
        lines.push(`  - ${parts.join(' ')}`);
    }

    lines.push('');
    lines.push(`Diagnostic history (${String(input.diagnostics.length)}/${String(DIAGNOSTIC_HISTORY_LIMIT)} entries):`);
    if (input.diagnostics.length === 0) {
        lines.push('  (none)');
    }
    for (const event of input.diagnostics) {
        const parts = [toIso(event.at), event.type];
        if (event.extensionOrigin === true) {
            parts.push('origin=EXTENSION_ORIGIN');
        }
        if (event.errorName !== undefined) {
            parts.push(`name=${event.errorName}`);
        }
        if (event.mediaErrorCode !== undefined) {
            parts.push(`mediaErrorCode=${String(event.mediaErrorCode)}`);
        }
        if (event.readings !== undefined) {
            for (const [key, value] of Object.entries(event.readings).slice(0, MAX_READINGS_PER_EVENT)) {
                if (isSafeToken(key)) {
                    parts.push(`${key}=${String(value)}`);
                }
            }
        }
        lines.push(`  - ${parts.join(' ')}`);
    }

    return lines.join('\n');
}
