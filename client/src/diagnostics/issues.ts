import {
    ACTIVE_ISSUE_LIMIT,
    DiagnosticEvent,
    Issue,
    IssueCode,
    IssueDefinition,
    IssueInput,
    IssueListener,
    IssueSnapshot,
    RecoveryAction,
    Severity,
} from './snapshot';

/**
 * Fixed definitions for every known issue code. Messages are neutral and
 * actionable: they never speculate about causes (a failed request does not
 * prove an extension blocked it; an unusable source does not prove a bad
 * codec) and never embed raw error text.
 */
export const ISSUE_CATALOG: Readonly<Record<IssueCode, IssueDefinition>> = {
    [IssueCode.PlaybackInteractionRequired]: {
        code: IssueCode.PlaybackInteractionRequired,
        message: 'Playback is ready, but the browser needs you to press play to start it.',
        severity: Severity.Warning,
        blocking: true,
        recoveryActions: [RecoveryAction.Retry],
    },
    [IssueCode.MediaNetwork]: {
        code: IssueCode.MediaNetwork,
        message: 'The video could not load just now. Check your connection, then try again.',
        severity: Severity.Critical,
        blocking: true,
        recoveryActions: [RecoveryAction.Retry],
    },
    [IssueCode.MediaDecode]: {
        code: IssueCode.MediaDecode,
        message: 'The video stopped because this browser could not decode it. Trying again, or switching browsers, may help.',
        severity: Severity.Critical,
        blocking: true,
        recoveryActions: [RecoveryAction.Retry],
    },
    [IssueCode.MediaUnusable]: {
        code: IssueCode.MediaUnusable,
        message: 'The current video source cannot be used. Ask the host to check the shared video, then try again.',
        severity: Severity.Critical,
        blocking: true,
        recoveryActions: [RecoveryAction.Retry],
    },
    [IssueCode.MediaMismatch]: {
        code: IssueCode.MediaMismatch,
        message: 'Your video does not match the one the room is watching. Reloading will resynchronize playback.',
        severity: Severity.Warning,
        blocking: true,
        recoveryActions: [RecoveryAction.Reload],
    },
    [IssueCode.SlowLoading]: {
        code: IssueCode.SlowLoading,
        message: 'The video is taking longer than usual to load, so playback may stall.',
        severity: Severity.Info,
        blocking: false,
        recoveryActions: [],
    },
    [IssueCode.ConnectionLost]: {
        code: IssueCode.ConnectionLost,
        message: 'The connection to the room was lost. Reconnect or reload to rejoin.',
        severity: Severity.Critical,
        blocking: true,
        recoveryActions: [RecoveryAction.Reconnect, RecoveryAction.Reload],
    },
    [IssueCode.StorageUnavailable]: {
        code: IssueCode.StorageUnavailable,
        message: 'Browser storage is unavailable, so preferences like your name cannot be saved.',
        severity: Severity.Info,
        blocking: false,
        recoveryActions: [],
    },
    [IssueCode.InvalidServerState]: {
        code: IssueCode.InvalidServerState,
        message: 'The server sent room state that cannot be used. Reloading will resynchronize the room.',
        severity: Severity.Warning,
        blocking: true,
        recoveryActions: [RecoveryAction.Reload],
    },
    [IssueCode.AppInit]: {
        code: IssueCode.AppInit,
        message: 'The app failed to start. Reload the page to try again.',
        severity: Severity.Critical,
        blocking: true,
        recoveryActions: [RecoveryAction.Reload],
    },
    [IssueCode.Unexpected]: {
        code: IssueCode.Unexpected,
        message: 'Something unexpected went wrong. Reload the page if anything looks off.',
        severity: Severity.Warning,
        blocking: false,
        recoveryActions: [RecoveryAction.Reload],
    },
};

const GLOBAL_SCOPE = 'global';

/** Incident family shared by related media source errors (network + decode). */
const MEDIA_PLAYBACK_INCIDENT = 'media-playback';

const MAX_MEDIA_ID_LENGTH = 64;
const MAX_NAME_LENGTH = 64;

/** Module-local incident counter; ids must not depend on a secure context. */
let incidentCounter = 0;

function nextIncidentId(): string {
    incidentCounter += 1;
    return `issue-${String(incidentCounter)}`;
}

/** Internal mutable incident record; snapshots expose defensive copies. */
interface MutableIssue {
    readonly id: string;
    readonly key: string;
    code: IssueCode;
    mediaId?: string;
    occurrences: number;
    mediaErrorCode?: number;
    readonly firstSeen: number;
    lastSeen: number;
}

interface NormalizedIssueInput {
    readonly code: IssueCode;
    readonly mediaId: string | undefined;
    readonly error: unknown;
    readonly mediaErrorCode: number | undefined;
}

/**
 * Incident keying scheme: `${canonicalCode}:${scope}`.
 *
 * - The scope is the media id for media-scoped reports and `global` otherwise.
 * - `MediaNetwork` and `MediaDecode` both key to `media-playback:${mediaId}`
 *   so related source failures refine one per-media incident instead of
 *   creating two; the incident's code tracks the most recent report.
 * - All other codes key directly, e.g. `connection-lost:global`.
 */
function issueKeyFor(code: IssueCode, mediaId: string | undefined): string {
    const scope = mediaId ?? GLOBAL_SCOPE;
    if (code === IssueCode.MediaNetwork || code === IssueCode.MediaDecode) {
        return `${MEDIA_PLAYBACK_INCIDENT}:${scope}`;
    }
    return `${code}:${scope}`;
}

function toRecord(value: unknown): Record<string, unknown> {
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function isIssueCode(value: unknown): value is IssueCode {
    return typeof value === 'string' && Object.prototype.hasOwnProperty.call(ISSUE_CATALOG, value);
}

/** Reads a finite numeric `code`/`mediaErrorCode` property from any value. */
function extractMediaErrorCode(value: unknown): number | undefined {
    const record = toRecord(value);
    const candidate = record['code'] ?? record['mediaErrorCode'];
    return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : undefined;
}

/** Tolerates garbage, primitives, circular references, and hostile proxies. */
function normalizeIssueInput(input: unknown): NormalizedIssueInput {
    const record = toRecord(input);
    const rawCode = record['code'];
    const rawMediaId = record['mediaId'];
    const error = record['error'];
    const mediaErrorCode = extractMediaErrorCode(error) ?? extractMediaErrorCode(record['detail']);
    return {
        code: isIssueCode(rawCode) ? rawCode : IssueCode.Unexpected,
        mediaId:
            typeof rawMediaId === 'string' && rawMediaId.length > 0 && rawMediaId.length <= MAX_MEDIA_ID_LENGTH
                ? rawMediaId
                : undefined,
        error,
        mediaErrorCode,
    };
}

/** Extracts a safe error identifier (the constructor name) from any value. */
export function normalizeErrorName(error: unknown): string | undefined {
    if (typeof error !== 'object' || error === null) {
        return undefined;
    }
    try {
        const name = (error as { readonly name?: unknown }).name;
        if (typeof name === 'string' && name.length > 0 && name.length <= MAX_NAME_LENGTH) {
            return name;
        }
        const constructor = (error as { readonly constructor?: unknown }).constructor;
        if (typeof constructor === 'function') {
            const constructorName = (constructor as { readonly name?: unknown }).name;
            if (typeof constructorName === 'string' && constructorName.length > 0 && constructorName.length <= MAX_NAME_LENGTH) {
                return constructorName;
            }
        }
        return 'Object';
    } catch {
        // Reading properties from a hostile proxy can throw; never propagate.
        return 'Object';
    }
}

function toPublicIssue(incident: MutableIssue): Issue {
    const definition: IssueDefinition = ISSUE_CATALOG[incident.code];
    const issue: Issue = {
        id: incident.id,
        key: incident.key,
        code: incident.code,
        message: definition.message,
        severity: definition.severity,
        blocking: definition.blocking,
        recoveryActions: definition.recoveryActions,
        occurrences: incident.occurrences,
        firstSeen: incident.firstSeen,
        lastSeen: incident.lastSeen,
        ...(incident.mediaId !== undefined ? { mediaId: incident.mediaId } : {}),
        ...(incident.mediaErrorCode !== undefined ? { mediaErrorCode: incident.mediaErrorCode } : {}),
    };
    return Object.freeze(issue);
}

export interface IssueStore {
    reportIssue(input: IssueInput): void;
    resolveIssue(id: string): void;
    subscribeIssues(listener: IssueListener): () => void;
    getIssueSnapshot(): IssueSnapshot;
    recordDiagnostic(event: DiagnosticEvent): void;
    exportDiagnostics(): string;
}

/**
 * Creates an issue store. `now` is injectable for deterministic timestamps.
 * All mutating entry points tolerate arbitrary garbage and never throw.
 */
export function createIssueStore(now: () => number = Date.now): IssueStore {
    /** Active incidents by incident key. */
    const active = new Map<string, MutableIssue>();
    /** Allowlisted diagnostic events (bounded ring). */
    const history: DiagnosticEvent[] = [];
    const listeners = new Set<IssueListener>();

    function snapshot(): IssueSnapshot {
        return { issues: Object.freeze([...active.values()].map(toPublicIssue)) };
    }

    function notify(): void {
        const current = snapshot();
        for (const listener of [...listeners]) {
            try {
                listener(current);
            } catch (error) {
                console.warn('[panopticon] issue listener threw', error);
            }
        }
    }

    function evictIfNeeded(): void {
        while (active.size > ACTIVE_ISSUE_LIMIT) {
            let oldestKey: string | undefined;
            let oldestSeen = Number.POSITIVE_INFINITY;
            for (const [key, incident] of active) {
                if (incident.lastSeen < oldestSeen) {
                    oldestSeen = incident.lastSeen;
                    oldestKey = key;
                }
            }
            if (oldestKey === undefined) {
                break;
            }
            active.delete(oldestKey);
        }
    }

    function reportIssue(input: IssueInput): void {
        try {
            const at = now();
            const normalized = normalizeIssueInput(input);
            const key = issueKeyFor(normalized.code, normalized.mediaId);
            const incident = active.get(key);

            if (incident === undefined) {
                const fresh: MutableIssue = {
                    id: nextIncidentId(),
                    key,
                    code: normalized.code,
                    occurrences: 1,
                    firstSeen: at,
                    lastSeen: at,
                };
                if (normalized.mediaId !== undefined) {
                    fresh.mediaId = normalized.mediaId;
                }
                if (normalized.mediaErrorCode !== undefined) {
                    fresh.mediaErrorCode = normalized.mediaErrorCode;
                }
                active.set(key, fresh);
                evictIfNeeded();
            } else {
                incident.code = normalized.code;
                incident.occurrences += 1;
                incident.lastSeen = at;
                if (normalized.mediaErrorCode !== undefined) {
                    incident.mediaErrorCode = normalized.mediaErrorCode;
                }
            }

            notify();
        } catch (failure) {
            console.warn('[panopticon] failed to record issue', failure);
        }
    }

    function resolveIssue(id: string): void {
        try {
            for (const [key, incident] of active) {
                if (incident.id === id) {
                    active.delete(key);
                    notify();
                    return;
                }
            }
        } catch (failure) {
            console.warn('[panopticon] failed to resolve issue', failure);
        }
    }

    function subscribeIssues(listener: IssueListener): () => void {
        listeners.add(listener);
        try {
            listener(snapshot());
        } catch (error) {
            console.warn('[panopticon] issue listener threw during replay', error);
        }
        return (): void => {
            listeners.delete(listener);
        };
    }

    function getIssueSnapshot(): IssueSnapshot {
        return snapshot();
    }

    function recordDiagnostic(event: DiagnosticEvent): void {
        try {
            history.push(event);
        } catch (failure) {
            console.warn('[panopticon] failed to record diagnostic', failure);
        }
    }

    function exportDiagnostics(): string {
        return '';
    }

    return {
        reportIssue,
        resolveIssue,
        subscribeIssues,
        getIssueSnapshot,
        recordDiagnostic,
        exportDiagnostics,
    };
}

/** Shared application-wide store; tests create isolated stores instead. */
export const issueStore: IssueStore = createIssueStore();
