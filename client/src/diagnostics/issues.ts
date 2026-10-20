import { DIAGNOSTICS_HEADER, formatDiagnosticsReport } from './report';
import {
    ACTIVE_ISSUE_LIMIT,
    currentEngineFamily,
    DiagnosticEvent,
    DiagnosticEventInput,
    DIAGNOSTIC_HISTORY_LIMIT,
    isSafeToken,
    Issue,
    IssueCode,
    IssueDefinition,
    IssueInput,
    IssueListener,
    IssueSnapshot,
    MAX_NAME_LENGTH,
    MAX_READINGS_PER_EVENT,
    RecoveryAction,
    Severity,
} from './snapshot';

/**
 * Fixed definitions for every known issue code. Messages are neutral and
 * actionable: they never speculate about causes or embed raw error text.
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
    [IssueCode.InvalidConfiguration]: {
        code: IssueCode.InvalidConfiguration,
        message: 'The movie settings could not be read, so playback may not start. Ask the host to check the shared movie files.',
        severity: Severity.Warning,
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

// Subscribers get these shared arrays, so freeze them.
for (const definition of Object.values(ISSUE_CATALOG)) {
    Object.freeze(definition.recoveryActions);
    Object.freeze(definition);
}
Object.freeze(ISSUE_CATALOG);

const GLOBAL_SCOPE = 'global';

/** Incident family shared by related media source errors (network + decode). */
const MEDIA_PLAYBACK_INCIDENT = 'media-playback';

/** Sanitization bound for media ids accepted into an issue (tighter than the wire cap). */
const MAX_ISSUE_MEDIA_ID_LENGTH = 64;
const MAX_EVENT_TYPE_LENGTH = 64;

/** Counter based ids, no secure context needed. */
let incidentCounter = 0;

function nextIncidentId(): string {
    incidentCounter += 1;
    return `issue-${String(incidentCounter)}`;
}

/** Snapshots expose defensive copies of this. */
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
 * Incident key: `${code}:${scope}` where scope is the media id or `global`.
 * MediaNetwork and MediaDecode both key to `media-playback:${mediaId}` so
 * related source failures land in one incident, with the code tracking the
 * most recent report.
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

/**
 * Valid `MediaError.code` values: 1-4 per the HTML spec, plus 5 (reported by
 * some engines when encrypted-media support is absent). Other finite numbers
 * (e.g. an HTTP status) are dropped.
 */
const MIN_MEDIA_ERROR_CODE = 1;
const MAX_MEDIA_ERROR_CODE = 5;

function isMediaErrorCode(value: unknown): value is number {
    return (
        typeof value === 'number' &&
        Number.isInteger(value) &&
        value >= MIN_MEDIA_ERROR_CODE &&
        value <= MAX_MEDIA_ERROR_CODE
    );
}

/** Reads a valid `MediaError.code` (range 1-5) from `code`/`mediaErrorCode` on any value. */
function extractMediaErrorCode(value: unknown): number | undefined {
    const record = toRecord(value);
    const candidate = record['code'] ?? record['mediaErrorCode'];
    return isMediaErrorCode(candidate) ? candidate : undefined;
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
            typeof rawMediaId === 'string' && rawMediaId.length > 0 && rawMediaId.length <= MAX_ISSUE_MEDIA_ID_LENGTH
                ? rawMediaId
                : undefined,
        error,
        mediaErrorCode,
    };
}

/**
 * Reduces any input to the allowlisted DiagnosticEvent shape. The result
 * holds no DOM events, error objects or elements.
 */
function sanitizeDiagnosticEvent(event: unknown, fallbackAt: number): DiagnosticEvent {
    const record = toRecord(event);
    const rawType = record['type'];
    const rawAt = record['at'];

    const sanitized: DiagnosticEvent = {
        type:
            typeof rawType === 'string' && rawType.length > 0 && rawType.length <= MAX_EVENT_TYPE_LENGTH
                ? rawType
                : 'unknown',
        at: typeof rawAt === 'number' && Number.isFinite(rawAt) ? rawAt : fallbackAt,
        ...pickErrorName(record['errorName']),
        ...pickMediaErrorCode(record['mediaErrorCode']),
        ...(record['extensionOrigin'] === true ? { extensionOrigin: true } : {}),
        ...pickReadings(record['readings']),
    };
    return sanitized;
}

function pickErrorName(value: unknown): { errorName?: string } {
    return typeof value === 'string' && value.length > 0 && value.length <= MAX_NAME_LENGTH ? { errorName: value } : {};
}

function pickMediaErrorCode(value: unknown): { mediaErrorCode?: number } {
    return isMediaErrorCode(value) ? { mediaErrorCode: value } : {};
}

function pickReadings(value: unknown): { readings?: Readonly<Record<string, number>> } {
    if (typeof value !== 'object' || value === null) {
        return {};
    }
    const readings: Record<string, number> = {};
    for (const [key, reading] of Object.entries(value as Record<string, unknown>)) {
        if (Object.keys(readings).length >= MAX_READINGS_PER_EVENT) {
            break;
        }
        if (isSafeToken(key) && typeof reading === 'number' && Number.isFinite(reading)) {
            readings[key] = reading;
        }
    }
    return Object.keys(readings).length > 0 ? { readings } : {};
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
    recordDiagnostic(event: DiagnosticEventInput): void;
    exportDiagnostics(): string;
}

/**
 * Creates an issue store. `now` is injectable for deterministic timestamps,
 * and every mutating entry point tolerates arbitrary garbage.
 */
export function createIssueStore(now: () => number = Date.now): IssueStore {
    /** Active incidents by incident key. */
    const active = new Map<string, MutableIssue>();
    /** Allowlisted diagnostic events (bounded ring). */
    const history: DiagnosticEvent[] = [];
    const listeners = new Set<IssueListener>();
    let totalIncidents = 0;
    let retiredIncidents = 0;

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
                if (Number.isFinite(incident.lastSeen) && incident.lastSeen < oldestSeen) {
                    oldestSeen = incident.lastSeen;
                    oldestKey = key;
                }
            }
            // A broken clock can leave every lastSeen non-finite, so fall
            // back to dropping the first entry.
            const keyToEvict = oldestKey ?? active.keys().next().value;
            if (keyToEvict === undefined) {
                break;
            }
            active.delete(keyToEvict);
            retiredIncidents += 1;
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
                totalIncidents += 1;
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
                    retiredIncidents += 1;
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

    function recordDiagnostic(event: DiagnosticEventInput): void {
        try {
            history.push(sanitizeDiagnosticEvent(event, now()));
            while (history.length > DIAGNOSTIC_HISTORY_LIMIT) {
                history.shift();
            }
        } catch (failure) {
            console.warn('[panopticon] failed to record diagnostic', failure);
        }
    }

    function exportDiagnostics(): string {
        try {
            return formatDiagnosticsReport({
                generatedAt: now(),
                engineFamily: currentEngineFamily(),
                activeIssues: [...active.values()].map(toPublicIssue),
                diagnostics: [...history],
                totalIncidentCount: totalIncidents,
                retiredIncidentCount: retiredIncidents,
            });
        } catch {
            return `${DIAGNOSTICS_HEADER}\nDiagnostics export failed.`;
        }
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

/** Shared app wide store, tests make isolated ones. */
export const issueStore: IssueStore = createIssueStore();
