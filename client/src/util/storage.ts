import { issueStore } from '../diagnostics/issues';
import { IssueCode, IssueInput } from '../diagnostics/snapshot';

/** The issue-store surface the storage wrapper reports through. */
export interface StorageIssueReporter {
    reportIssue(input: IssueInput): void;
}

/** Bounds and fallback for reading a stored number. */
export interface StoredNumberOptions {
    readonly minimum: number;
    readonly maximum: number;
    readonly fallback: number;
}

/** Never-throwing preference storage; see `createSafeStorage`. */
export interface SafeStorage {
    /** Reads a stored string; null when missing or unreadable. */
    readStoredString(key: string): string | null;
    /** Writes a stored string; false when the write failed. */
    writeStoredString(key: string, value: string): boolean;
    /** Reads a finite number in range; the fallback when missing or invalid. */
    readStoredNumber(key: string, options: StoredNumberOptions): number;
}

/**
 * Returns the browser's localStorage, or null when storage is blocked.
 * Merely reading the global can throw (SecurityError), so guard it.
 */
export function safeGetStorage(): Storage | null {
    try {
        const storage = (globalThis as { readonly localStorage?: Storage }).localStorage;
        return storage ?? null;
    } catch {
        return null;
    }
}

/**
 * Creates a never-throwing wrapper over browser storage for preferences: a
 * blocked or quota-limited storage must never break username entry or
 * playback. Failed writes are mirrored to an in-memory map for the rest of
 * the session, and each failure reports one deduplicated
 * `StorageUnavailable` issue through the given reporter.
 */
export function createSafeStorage(reporter: StorageIssueReporter = issueStore): SafeStorage {
    /** Values written after storage failed, so reads still see them this session. */
    const failedWrites = new Map<string, string>();

    function reportStorageIssue(): void {
        try {
            reporter.reportIssue({ code: IssueCode.StorageUnavailable });
        } catch {
            // Reporting is best-effort; it must never break the caller either.
        }
    }

    function readStoredString(key: string): string | null {
        // A pending failed write is the freshest value for this key; consult
        // the map before touching storage.
        const pending = failedWrites.get(key);
        if (pending !== undefined) {
            return pending;
        }
        let stored: string | null = null;
        const storage = safeGetStorage();
        if (storage === null) {
            reportStorageIssue();
        } else {
            try {
                stored = storage.getItem(key);
            } catch {
                reportStorageIssue();
            }
        }
        return stored;
    }

    function writeStoredString(key: string, value: string): boolean {
        const storage = safeGetStorage();
        if (storage !== null) {
            try {
                storage.setItem(key, value);
                failedWrites.delete(key);
                return true;
            } catch {
                // Fall through to the failure path below.
            }
        }
        reportStorageIssue();
        failedWrites.set(key, value);
        return false;
    }

    function readStoredNumber(key: string, options: StoredNumberOptions): number {
        const raw = readStoredString(key);
        if (raw === null || raw.trim() === '') {
            return options.fallback;
        }
        const value = Number(raw.trim());
        // The finite check covers NaN (malformed text) and Infinity; the
        // range checks cover hand-edited values.
        if (!Number.isFinite(value) || value < options.minimum || value > options.maximum) {
            return options.fallback;
        }
        return value;
    }

    return { readStoredString, writeStoredString, readStoredNumber };
}

/** Shared application-wide wrapper; tests create isolated wrappers instead. */
export const safeStorage: SafeStorage = createSafeStorage();
