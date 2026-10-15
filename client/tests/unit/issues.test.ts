import { afterEach, describe, expect, it, vi } from 'vitest';
import { createIssueStore, ISSUE_CATALOG } from '../../src/diagnostics/issues';
import {
    ACTIVE_ISSUE_LIMIT,
    IssueCode,
    IssueInput,
    IssueSnapshot,
    MAX_READINGS_PER_EVENT,
    normalizeErrorName,
    RecoveryAction,
} from '../../src/diagnostics/snapshot';

afterEach((): void => {
    vi.restoreAllMocks();
});

describe('issue store', (): void => {
    it('replays current state to subscribers that attach after reports', (): void => {
        const store = createIssueStore();
        store.reportIssue({ code: IssueCode.ConnectionLost });

        let received: IssueSnapshot | undefined;
        store.subscribeIssues((snapshot: IssueSnapshot): void => {
            received = snapshot;
        });

        expect(received?.issues).toHaveLength(1);
        expect(received?.issues[0]?.code).toBe(IssueCode.ConnectionLost);
    });

    it('merges repeated reports into one incident with an occurrence count', (): void => {
        const store = createIssueStore();

        store.reportIssue({ code: IssueCode.MediaNetwork, mediaId: 'movie' });
        store.reportIssue({ code: IssueCode.MediaNetwork, mediaId: 'movie' });
        store.reportIssue({ code: IssueCode.MediaNetwork, mediaId: 'movie' });

        const issues = store.getIssueSnapshot().issues;
        expect(issues).toHaveLength(1);
        expect(issues[0]?.occurrences).toBe(3);
        expect(issues[0]?.message).toBe(ISSUE_CATALOG[IssueCode.MediaNetwork].message);
    });

    it('derives user-facing text from the catalog, never from the error', (): void => {
        const store = createIssueStore();

        store.reportIssue({ code: IssueCode.Unexpected, error: new Error('sekrit token at http://10.0.0.1:5000') });

        const [issue] = store.getIssueSnapshot().issues;
        expect(issue?.message).toBe(ISSUE_CATALOG[IssueCode.Unexpected].message);
        expect(issue?.message).not.toContain('sekrit');
    });

    it('removes resolved issues from active state and starts a fresh incident on recurrence', (): void => {
        const store = createIssueStore();
        store.reportIssue({ code: IssueCode.ConnectionLost });

        const [first] = store.getIssueSnapshot().issues;
        if (first === undefined) {
            throw new Error('expected a ConnectionLost issue');
        }

        store.resolveIssue(first.id);
        expect(store.getIssueSnapshot().issues).toHaveLength(0);

        store.reportIssue({ code: IssueCode.ConnectionLost });
        const [recurred] = store.getIssueSnapshot().issues;
        expect(recurred?.occurrences).toBe(1);
        expect(recurred?.id).not.toBe(first.id);

        // Unknown ids are a no-op, not a throw.
        store.resolveIssue('does-not-exist');
        expect(store.getIssueSnapshot().issues).toHaveLength(1);
    });

    it('folds related media network and decode failures into one per-media incident', (): void => {
        const store = createIssueStore();

        store.reportIssue({ code: IssueCode.MediaNetwork, mediaId: 'movie' });
        store.reportIssue({ code: IssueCode.MediaDecode, mediaId: 'movie' });
        store.reportIssue({ code: IssueCode.MediaDecode, mediaId: 'trailer' });

        const issues = store.getIssueSnapshot().issues;
        expect(issues).toHaveLength(2);

        const [movie] = issues.filter((issue) => issue.mediaId === 'movie');
        expect(movie?.occurrences).toBe(2);
    });

    it('caps active issues and evicts the least recently reported', (): void => {
        let clock = 0;
        const store = createIssueStore((): number => clock);

        for (let index = 0; index < 20; index += 1) {
            clock += 1;
            store.reportIssue({ code: IssueCode.InvalidServerState, mediaId: `media-${String(index)}` });
        }

        const mediaIds = store.getIssueSnapshot().issues.map((issue) => issue.mediaId);
        expect(mediaIds).toHaveLength(ACTIVE_ISSUE_LIMIT);
        expect(mediaIds).not.toContain('media-3');
        expect(mediaIds).toContain('media-4');
        expect(mediaIds).toContain('media-19');

        // Re-reporting an old incident bumps its recency and protects it.
        clock += 1;
        store.reportIssue({ code: IssueCode.InvalidServerState, mediaId: 'media-4' });
        clock += 1;
        store.reportIssue({ code: IssueCode.InvalidServerState, mediaId: 'media-20' });

        const remaining = store.getIssueSnapshot().issues.map((issue) => issue.mediaId);
        expect(remaining).toHaveLength(ACTIVE_ISSUE_LIMIT);
        expect(remaining).toContain('media-4');
        expect(remaining).not.toContain('media-5');
        expect(remaining).toContain('media-20');
    });

    it('isolates subscriber failures from other subscribers and the reporter', (): void => {
        const warn = vi.spyOn(console, 'warn').mockImplementation((): void => undefined);
        const store = createIssueStore();

        const breaking = vi.fn((): void => {
            throw new Error('listener bug');
        });
        expect(() => {
            store.subscribeIssues(breaking);
        }).not.toThrow();

        const snapshots: IssueSnapshot[] = [];
        store.subscribeIssues((snapshot: IssueSnapshot): void => {
            snapshots.push(snapshot);
        });

        expect(() => {
            store.reportIssue({ code: IssueCode.ConnectionLost });
        }).not.toThrow();
        expect(breaking).toHaveBeenCalled();
        expect(warn).toHaveBeenCalled();

        // Replay plus the report notification both reached the healthy listener.
        expect(snapshots).toHaveLength(2);
        expect(snapshots[1]?.issues).toHaveLength(1);
    });

    it('normalizes garbage, missing, and hostile inputs without throwing', (): void => {
        const circular: Record<string, unknown> = { username: 'alice' };
        circular['self'] = circular;

        const symbolKeyed: Record<PropertyKey, unknown> = {};
        symbolKeyed[Symbol('k')] = 'value';
        symbolKeyed['name'] = 12345;

        const nullInput: unknown = null;
        const numberInput: unknown = 42;

        const store = createIssueStore();

        expect(() => {
            store.reportIssue({});
        }).not.toThrow();
        expect(() => {
            store.reportIssue(nullInput as IssueInput);
        }).not.toThrow();
        expect(() => {
            store.reportIssue(numberInput as IssueInput);
        }).not.toThrow();
        expect(() => {
            store.reportIssue({ code: 'definitely-not-a-code', error: circular });
        }).not.toThrow();
        expect(() => {
            store.reportIssue({ code: IssueCode.Unexpected, error: 'primitive rejection' });
        }).not.toThrow();
        expect(() => {
            store.reportIssue({ code: IssueCode.Unexpected, error: 7 });
        }).not.toThrow();
        expect(() => {
            store.reportIssue({ code: IssueCode.Unexpected, error: null });
        }).not.toThrow();
        expect(() => {
            store.reportIssue({ code: IssueCode.Unexpected, error: symbolKeyed });
        }).not.toThrow();

        const issues = store.getIssueSnapshot().issues;
        expect(issues).toHaveLength(1);
        expect(issues[0]?.code).toBe(IssueCode.Unexpected);
        expect(issues[0]?.occurrences).toBe(8);
        expect(issues[0]?.key).toBe('unexpected:global');
    });

    it('assigns unique stable ids per incident', (): void => {
        const store = createIssueStore();

        store.reportIssue({ code: IssueCode.StorageUnavailable });
        store.reportIssue({ code: IssueCode.InvalidServerState });

        const ids = store.getIssueSnapshot().issues.map((issue) => issue.id);
        expect(new Set(ids).size).toBe(2);
    });

    it('captures numeric media error codes from detail payloads', (): void => {
        const store = createIssueStore();

        store.reportIssue({ code: IssueCode.MediaDecode, mediaId: 'movie', detail: { code: 3 } });

        const [issue] = store.getIssueSnapshot().issues;
        expect(issue?.mediaErrorCode).toBe(3);
    });

    it('stops notifying torn-down subscribers while later subscribers keep receiving', (): void => {
        const store = createIssueStore();
        const receivedByA: IssueSnapshot[] = [];
        const receivedByB: IssueSnapshot[] = [];

        const teardownA = store.subscribeIssues((snapshot: IssueSnapshot): void => {
            receivedByA.push(snapshot);
        });
        store.subscribeIssues((snapshot: IssueSnapshot): void => {
            receivedByB.push(snapshot);
        });
        teardownA();

        store.reportIssue({ code: IssueCode.ConnectionLost });

        // A saw only the replay from subscribing; B saw replay plus the report.
        expect(receivedByA).toHaveLength(1);
        expect(receivedByB).toHaveLength(2);
        expect(receivedByB[1]?.issues[0]?.code).toBe(IssueCode.ConnectionLost);
    });

    it('keeps safe finite readings and drops unsafe keys and non-finite values', (): void => {
        const store = createIssueStore();

        // Keys and values are intentionally hostile; they are listed as pairs
        // because they are data, not identifiers.
        const readingEntries: readonly (readonly [string, unknown])[] = [
            ['clock-skew', -12.5],
            ['buffer_ratio', 0.75],
            ['has-Dash_case123', 3],
            ['unsafe key!', 1],
            ['user@example', 2],
            ['too-long-token-1234567890-1234567890123456789012345678901234567890', 4],
            ['notANumber', Number.NaN],
            ['infinite', Number.POSITIVE_INFINITY],
            ['aString', '42'],
        ];
        const readings: Record<string, unknown> = Object.fromEntries(readingEntries);

        store.recordDiagnostic({ type: 'probe', at: 4242424, readings });

        const report = store.exportDiagnostics();
        expect(report).toContain('clock-skew=-12.5');
        expect(report).toContain('buffer_ratio=0.75');
        expect(report).toContain('has-Dash_case123=3');
        expect(report).not.toContain('unsafe key');
        expect(report).not.toContain('user@example');
        expect(report).not.toContain('too-long-token');
        expect(report).not.toContain('NaN');
        expect(report).not.toContain('Infinity');
        expect(report).not.toContain('aString');
    });

    it('drops readings beyond the per-event maximum', (): void => {
        const store = createIssueStore();

        const readings: Record<string, number> = {};
        for (let index = 0; index < MAX_READINGS_PER_EVENT + 2; index += 1) {
            readings[`reading-${String(index)}`] = index;
        }
        store.recordDiagnostic({ type: 'probe', at: 4242424, readings });

        const report = store.exportDiagnostics();
        const lastKept = `reading-${String(MAX_READINGS_PER_EVENT - 1)}=${String(MAX_READINGS_PER_EVENT - 1)}`;
        expect(report).toContain(lastKept);
        expect(report).not.toContain(`reading-${String(MAX_READINGS_PER_EVENT)}=`);
        expect(report).not.toContain(`reading-${String(MAX_READINGS_PER_EVENT + 1)}=`);
    });

    it('freezes catalog-backed recovery actions against mutation', (): void => {
        const store = createIssueStore();
        store.reportIssue({ code: IssueCode.ConnectionLost });

        const [issue] = store.getIssueSnapshot().issues;
        if (issue === undefined) {
            throw new Error('expected a ConnectionLost issue');
        }

        // `recoveryActions` aliases the catalog's array; mutating it must
        // throw instead of corrupting every future issue of that code.
        const actions = issue.recoveryActions as unknown as RecoveryAction[];
        expect(() => {
            actions.push(RecoveryAction.Retry);
        }).toThrow();
        const definition = ISSUE_CATALOG[IssueCode.ConnectionLost] as unknown as { message: string };
        expect(() => {
            definition.message = 'tampered';
        }).toThrow();
        expect(ISSUE_CATALOG[IssueCode.ConnectionLost].recoveryActions).toHaveLength(2);
    });

    it('still caps active issues when every timestamp is non-finite', (): void => {
        const store = createIssueStore((): number => Number.NaN);

        for (let index = 0; index < ACTIVE_ISSUE_LIMIT + 4; index += 1) {
            store.reportIssue({ code: IssueCode.InvalidServerState, mediaId: `media-${String(index)}` });
        }

        // No finite lastSeen exists to compare; eviction must fall back to
        // dropping an entry rather than letting the active set grow unbounded.
        expect(store.getIssueSnapshot().issues).toHaveLength(ACTIVE_ISSUE_LIMIT);
    });

    it('keeps the cap when one report lands on a non-finite timestamp', (): void => {
        let clock: number = Number.NaN;
        const store = createIssueStore((): number => clock);

        store.reportIssue({ code: IssueCode.InvalidServerState, mediaId: 'media-nan' });
        clock = 0;
        for (let index = 0; index < 20; index += 1) {
            clock += 1;
            store.reportIssue({ code: IssueCode.InvalidServerState, mediaId: `media-${String(index)}` });
        }

        expect(store.getIssueSnapshot().issues).toHaveLength(ACTIVE_ISSUE_LIMIT);
    });

    it('keeps only real MediaError codes and drops lookalikes like HTTP statuses', (): void => {
        const store = createIssueStore();

        store.reportIssue({ code: IssueCode.MediaNetwork, mediaId: 'movie', detail: { code: 404 } });
        expect(store.getIssueSnapshot().issues[0]?.mediaErrorCode).toBeUndefined();

        store.reportIssue({ code: IssueCode.MediaDecode, mediaId: 'movie', detail: { code: 3 } });
        expect(store.getIssueSnapshot().issues[0]?.mediaErrorCode).toBe(3);

        store.recordDiagnostic({ type: 'probe', at: 4242424, mediaErrorCode: 500 });
        const report = store.exportDiagnostics();
        expect(report).not.toContain('mediaErrorCode=404');
        expect(report).not.toContain('mediaErrorCode=500');
        expect(report).toContain('mediaErrorCode=3');
    });
});

describe('normalizeErrorName', (): void => {
    it('reads constructor names and survives primitives and garbage', (): void => {
        expect(normalizeErrorName(new TypeError('boom'))).toBe('TypeError');
        expect(normalizeErrorName('just a string')).toBeUndefined();
        expect(normalizeErrorName(null)).toBeUndefined();
        expect(normalizeErrorName(undefined)).toBeUndefined();
        expect(normalizeErrorName({ name: 12345 })).toBe('Object');
    });
});
