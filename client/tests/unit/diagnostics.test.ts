import { describe, expect, it } from 'vitest';
import { createIssueStore } from '../../src/diagnostics/issues';
import {
    detectEngineFamily,
    DIAGNOSTIC_HISTORY_LIMIT,
    DiagnosticEvent,
    IssueCode,
    summarizeEventArgs,
} from '../../src/diagnostics/snapshot';

describe('diagnostic ring', (): void => {
    it('bounds the diagnostic ring to the documented limit, evicting oldest first', (): void => {
        let clock = 0;
        const store = createIssueStore((): number => clock);

        for (let index = 0; index < 60; index += 1) {
            clock += 1;
            store.recordDiagnostic({ type: 'probe', at: clock });
        }

        const report = store.exportDiagnostics();

        expect(report).not.toContain(new Date(1).toISOString());
        expect(report).not.toContain(new Date(10).toISOString());
        expect(report).toContain(new Date(11).toISOString());
        expect(report).toContain(new Date(60).toISOString());
        expect(report.match(/probe/g)).toHaveLength(DIAGNOSTIC_HISTORY_LIMIT);
        expect(report).toContain(`Diagnostic history (${String(DIAGNOSTIC_HISTORY_LIMIT)}/${String(DIAGNOSTIC_HISTORY_LIMIT)} entries)`);
    });

    it('sanitizes diagnostic events to allowlisted fields only', (): void => {
        const store = createIssueStore();

        const hostile: unknown = {
            type: 'window-error',
            at: 12345,
            errorName: 'TypeError',
            mediaErrorCode: 2,
            message: 'secret message with token=abc',
            stack: 'at http://10.0.0.1/x.js',
            url: 'http://10.0.0.1/x.js?token=abc',
            username: 'alice',
            rawEvent: { target: 'video element' },
        };
        const garbage: unknown = 'garbage';

        expect(() => {
            store.recordDiagnostic(hostile as DiagnosticEvent);
        }).not.toThrow();
        expect(() => {
            store.recordDiagnostic(garbage as DiagnosticEvent);
        }).not.toThrow();

        const report = store.exportDiagnostics();
        expect(report).toContain('window-error');
        expect(report).toContain('name=TypeError');
        expect(report).toContain('mediaErrorCode=2');
        for (const banned of ['secret message', 'token=abc', '10.0.0.1', 'alice', 'video element']) {
            expect(report).not.toContain(banned);
        }
    });
});

describe('exportDiagnostics', (): void => {
    it('exports an allowlisted, human-readable report', (): void => {
        const store = createIssueStore();

        const secretUrl = 'http://192.168.1.50:5000/?token=sekrit&user=alice';
        const failure = new TypeError(`failed to load ${secretUrl}`);
        failure.stack = `TypeError: failed to load ${secretUrl}\n    at load (${secretUrl}:1:1)`;

        store.reportIssue({
            code: IssueCode.MediaNetwork,
            mediaId: 'movie',
            error: failure,
            detail: { code: 2, message: 'nope', url: secretUrl, username: 'alice' },
        });
        store.recordDiagnostic({ type: 'window-error', at: 4242424, errorName: 'TypeError' });

        const report = store.exportDiagnostics();

        // Header, allowlisted identifiers, and coarse environment info.
        expect(report).toContain('Project Panopticon diagnostics');
        expect(report).toContain('Local-only');
        expect(report).toContain('media-network');
        expect(report).toContain('name=TypeError');
        expect(report).toContain('mediaErrorCode=2');
        expect(report).toMatch(/^Engine: (gecko|blink|webkit|unknown)$/m);

        // Usernames, URLs/IPs, query tokens, messages, and stacks never appear.
        for (const banned of ['alice', 'sekrit', '192.168.1.50', 'token=', 'failed to load']) {
            expect(report).not.toContain(banned);
        }
    });

    it('omits unsafe media ids from the exported report', (): void => {
        const store = createIssueStore();

        store.reportIssue({ code: IssueCode.MediaMismatch, mediaId: 'http://10.0.0.7/logged-token' });

        const report = store.exportDiagnostics();
        expect(report).toContain('media-mismatch');
        expect(report).not.toContain('10.0.0.7');
        expect(report).not.toContain('logged-token');
    });
});

describe('detectEngineFamily', (): void => {
    it('maps user agents to coarse engine families', (): void => {
        expect(detectEngineFamily('Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0')).toBe('gecko');
        expect(
            detectEngineFamily(
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            ),
        ).toBe('blink');
        expect(
            detectEngineFamily(
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
            ),
        ).toBe('blink');
        expect(
            detectEngineFamily(
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
            ),
        ).toBe('webkit');
        expect(detectEngineFamily('curl/8.4.0')).toBe('unknown');
        expect(detectEngineFamily('')).toBe('unknown');
        expect(detectEngineFamily(undefined)).toBe('unknown');
    });
});

describe('summarizeEventArgs', (): void => {
    it('describes argument kinds without leaking values', (): void => {
        const summary = summarizeEventArgs([{ username: 'alice' }, 42, 'sekrit token', null, [1, 2], undefined]);

        expect(summary).toBe('args=6 [object, number, string, null, array, undefined]');
        expect(summary).not.toContain('alice');
        expect(summary).not.toContain('sekrit');
    });

    it('summarizes empty argument lists', (): void => {
        expect(summarizeEventArgs([])).toBe('args=0');
    });
});
