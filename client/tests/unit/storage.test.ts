import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createIssueStore } from '../../src/diagnostics/issues';
import { IssueCode, IssueSnapshot } from '../../src/diagnostics/snapshot';
import { createSafeStorage, safeGetStorage } from '../../src/util/storage';

/** Minimal in-memory Storage stand-in; only the surface the wrapper touches. */
class FakeStorage {
    private readonly entries = new Map<string, string>();

    public getItem(key: string): string | null {
        return this.entries.get(key) ?? null;
    }

    public setItem(key: string, value: string): void {
        this.entries.set(key, value);
    }

    public removeItem(key: string): void {
        this.entries.delete(key);
    }

    public clear(): void {
        this.entries.clear();
    }
}

/** Storage whose item access fails the way blocked or quota-limited browsers do. */
class ThrowingStorage extends FakeStorage {
    public override getItem(): string | null {
        throw new Error('SecurityError: The operation is insecure.');
    }

    public override setItem(): void {
        throw new Error('QuotaExceededError: The quota has been exceeded.');
    }
}

const originalStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

/** Makes merely reading `localStorage` throw, as browsers with storage blocked do. */
function blockStorageAccess(): void {
    Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        get(): Storage {
            throw new Error('SecurityError: The operation is insecure.');
        },
    });
}

afterEach((): void => {
    vi.unstubAllGlobals();
    if (originalStorageDescriptor === undefined) {
        delete (globalThis as { localStorage?: Storage }).localStorage;
    } else {
        Object.defineProperty(globalThis, 'localStorage', originalStorageDescriptor);
    }
});

/** Collects snapshots the injected store pushes, for issue assertions. */
function trackIssues(store: ReturnType<typeof createIssueStore>): IssueSnapshot[] {
    const snapshots: IssueSnapshot[] = [];
    store.subscribeIssues((snapshot: IssueSnapshot): void => {
        snapshots.push(snapshot);
    });
    return snapshots;
}

describe('safeGetStorage', (): void => {
    it('returns the global storage when it is accessible', (): void => {
        const fake = new FakeStorage();
        vi.stubGlobal('localStorage', fake);

        expect(safeGetStorage()).toBe(fake);
    });

    it('returns null when accessing storage itself throws', (): void => {
        blockStorageAccess();

        expect(safeGetStorage()).toBeNull();
    });

    it('returns null when no storage global exists', (): void => {
        delete (globalThis as { localStorage?: Storage }).localStorage;

        expect(safeGetStorage()).toBeNull();
    });
});

describe('readStoredString', (): void => {
    it('returns the stored string for an existing key', (): void => {
        vi.stubGlobal('localStorage', new FakeStorage());
        const storage = createSafeStorage(createIssueStore());
        storage.writeStoredString('username', 'alice');

        expect(storage.readStoredString('username')).toBe('alice');
    });

    it('returns null for a missing key without reporting an issue', (): void => {
        vi.stubGlobal('localStorage', new FakeStorage());
        const store = createIssueStore();
        const storage = createSafeStorage(store);

        expect(storage.readStoredString('username')).toBeNull();
        expect(store.getIssueSnapshot().issues).toHaveLength(0);
    });

    it('returns null and reports StorageUnavailable when getItem throws', (): void => {
        vi.stubGlobal('localStorage', new ThrowingStorage());
        const store = createIssueStore();
        const storage = createSafeStorage(store);

        expect(storage.readStoredString('username')).toBeNull();
        expect(store.getIssueSnapshot().issues).toHaveLength(1);
        expect(store.getIssueSnapshot().issues[0]?.code).toBe(IssueCode.StorageUnavailable);
    });

    it('returns null and reports StorageUnavailable when storage access is blocked', (): void => {
        blockStorageAccess();
        const store = createIssueStore();
        const storage = createSafeStorage(store);

        expect(storage.readStoredString('username')).toBeNull();
        expect(store.getIssueSnapshot().issues).toHaveLength(1);
        expect(store.getIssueSnapshot().issues[0]?.code).toBe(IssueCode.StorageUnavailable);
    });

    it('serves the in-memory fallback written after a failed write', (): void => {
        const fake = new ThrowingStorage();
        vi.stubGlobal('localStorage', fake);
        const storage = createSafeStorage(createIssueStore());

        expect(storage.writeStoredString('volume', '0.4')).toBe(false);
        expect(storage.readStoredString('volume')).toBe('0.4');
    });
});

describe('writeStoredString', (): void => {
    it('persists the value and returns true on success', (): void => {
        const fake = new FakeStorage();
        vi.stubGlobal('localStorage', fake);
        const storage = createSafeStorage(createIssueStore());

        expect(storage.writeStoredString('volume', '0.15')).toBe(true);
        expect(fake.getItem('volume')).toBe('0.15');
    });

    it('returns false and reports StorageUnavailable when setItem throws', (): void => {
        vi.stubGlobal('localStorage', new ThrowingStorage());
        const store = createIssueStore();
        const storage = createSafeStorage(store);

        expect(storage.writeStoredString('volume', '0.15')).toBe(false);
        expect(store.getIssueSnapshot().issues).toHaveLength(1);
        expect(store.getIssueSnapshot().issues[0]?.code).toBe(IssueCode.StorageUnavailable);
    });

    it('returns false and reports StorageUnavailable when storage access is blocked', (): void => {
        blockStorageAccess();
        const store = createIssueStore();
        const storage = createSafeStorage(store);

        expect(storage.writeStoredString('volume', '0.15')).toBe(false);
        expect(store.getIssueSnapshot().issues).toHaveLength(1);
        expect(store.getIssueSnapshot().issues[0]?.code).toBe(IssueCode.StorageUnavailable);
    });

    it('lets a later successful write replace a stale fallback value', (): void => {
        const fake = new FakeStorage();
        vi.stubGlobal('localStorage', new ThrowingStorage());
        const storage = createSafeStorage(createIssueStore());
        storage.writeStoredString('volume', '0.4');

        vi.stubGlobal('localStorage', fake);
        storage.writeStoredString('volume', '0.6');

        expect(storage.readStoredString('volume')).toBe('0.6');
        expect(fake.getItem('volume')).toBe('0.6');
    });
});

describe('storage issue reporting', (): void => {
    it('folds repeated read and write failures into a single StorageUnavailable incident', (): void => {
        vi.stubGlobal('localStorage', new ThrowingStorage());
        const store = createIssueStore();
        const snapshots = trackIssues(store);
        const storage = createSafeStorage(store);

        storage.readStoredString('username');
        storage.writeStoredString('volume', '0.15');
        storage.readStoredString('volume');

        const issues = store.getIssueSnapshot().issues;
        expect(issues).toHaveLength(1);
        expect(issues[0]?.code).toBe(IssueCode.StorageUnavailable);
        expect(issues[0]?.blocking).toBe(false);
        expect(snapshots.length).toBeGreaterThan(0);
    });
});

describe('readStoredNumber', (): void => {
    it.each([
        ['missing key', undefined],
        ['empty string', ''],
        ['whitespace-only string', '   '],
        ['malformed value', 'loud'],
        ['trailing garbage', '0.5abc'],
        ['NaN', 'NaN'],
        ['positive infinity', 'Infinity'],
        ['negative infinity', '-Infinity'],
        ['below the minimum', '-0.1'],
        ['above the maximum', '1.5'],
    ])('falls back to the default for a %s', (_label: string, stored: string | undefined): void => {
        const fake = new FakeStorage();
        vi.stubGlobal('localStorage', fake);
        if (stored !== undefined) {
            fake.setItem('volume', stored);
        }
        const storage = createSafeStorage(createIssueStore());

        expect(storage.readStoredNumber('volume', { fallback: 0.15, minimum: 0, maximum: 1 })).toBe(0.15);
    });

    it('preserves a valid saved zero instead of raising it', (): void => {
        const fake = new FakeStorage();
        fake.setItem('volume', '0');
        vi.stubGlobal('localStorage', fake);
        const storage = createSafeStorage(createIssueStore());

        expect(storage.readStoredNumber('volume', { fallback: 0.15, minimum: 0, maximum: 1 })).toBe(0);
    });

    it('returns valid saved values, trimming surrounding whitespace', (): void => {
        const fake = new FakeStorage();
        fake.setItem('volume', ' 0.5 ');
        vi.stubGlobal('localStorage', fake);
        const storage = createSafeStorage(createIssueStore());

        expect(storage.readStoredNumber('volume', { fallback: 0.15, minimum: 0, maximum: 1 })).toBe(0.5);
    });

    it('uses the default volume when storage is entirely blocked', (): void => {
        blockStorageAccess();
        const storage = createSafeStorage(createIssueStore());

        expect(storage.readStoredNumber('volume', { fallback: 0.15, minimum: 0, maximum: 1 })).toBe(0.15);
    });
});

describe('preference adoption', (): void => {
    /** Recursively lists TypeScript files under a directory. */
    function listSourceFiles(directory: string): string[] {
        const files: string[] = [];
        for (const entry of readdirSync(directory)) {
            const full = join(directory, entry);
            if (statSync(full).isDirectory()) {
                files.push(...listSourceFiles(full));
            } else if (entry.endsWith('.ts')) {
                files.push(full);
            }
        }
        return files;
    }

    it('routes every preference through the wrapper: no direct localStorage outside util/storage.ts', (): void => {
        const srcRoot = fileURLToPath(new URL('../../src', import.meta.url));
        const wrapperPath = join(srcRoot, 'util', 'storage.ts');

        const offenders: string[] = [];
        for (const file of listSourceFiles(srcRoot)) {
            if (file === wrapperPath) {
                continue;
            }
            if (readFileSync(file, 'utf8').includes('localStorage')) {
                offenders.push(file);
            }
        }

        // Source-level pin: getUsername and the movie controller still grab DOM
        // at module scope (restructured in Task 6), so Node tests cannot import
        // them. Proving they use the wrapper — instead of touching storage
        // directly — is therefore a source assertion until then.
        expect(offenders).toEqual([]);
    });
});
