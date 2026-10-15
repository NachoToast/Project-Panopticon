import { afterEach, describe, expect, it, vi } from 'vitest';
import { createIssueStore } from '../../src/diagnostics/issues';
import {
    installRuntimeHandlers,
    looksLikeExtensionOrigin,
    RuntimeTarget,
} from '../../src/diagnostics/runtime';
import {
    BootstrapWindow,
    MainModule,
    renderStartupFallback,
    startApp,
    StartupFallbackContainer,
} from '../../src/bootstrap';
import { IssueCode } from '../../src/diagnostics/snapshot';

afterEach((): void => {
    vi.restoreAllMocks();
});

interface FakeTarget extends RuntimeTarget {
    dispatch(type: string, event: unknown): void;
}

function createTarget(): FakeTarget {
    const listeners = new Map<string, ((event: unknown) => void)[]>();
    return {
        addEventListener(type: string, listener: (event: unknown) => void): void {
            const existing = listeners.get(type);
            if (existing === undefined) {
                listeners.set(type, [listener]);
            } else {
                existing.push(listener);
            }
        },
        dispatch(type: string, event: unknown): void {
            for (const listener of listeners.get(type) ?? []) {
                listener(event);
            }
        },
    };
}

interface FakeWindow extends BootstrapWindow {
    emitLoad(): void;
}

function createWindow(readyState: string): FakeWindow {
    const loadListeners = new Array<(event: unknown) => void>();
    return {
        addEventListener(type: string, listener: (event: unknown) => void): void {
            if (type === 'load') {
                loadListeners.push(listener);
            }
        },
        document: {
            readyState,
            getElementById: (): StartupFallbackContainer | null => null,
        },
        location: { origin: 'http://localhost:1730' },
        emitLoad(): void {
            for (const listener of loadListeners) {
                listener({});
            }
        },
    };
}

describe('runtime handlers', (): void => {
    it('reports genuine app errors as Unexpected issues and preserves console reporting', (): void => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation((): void => undefined);
        const consoleWarn = vi.spyOn(console, 'warn').mockImplementation((): void => undefined);
        const store = createIssueStore();
        const target = createTarget();

        installRuntimeHandlers(target, store, { appOrigin: 'http://localhost:1730' });
        target.dispatch('error', {
            message: 'Uncaught TypeError: boom',
            filename: 'http://localhost:1730/src/main.ts',
            error: new TypeError('boom for alice'),
        });

        const issues = store.getIssueSnapshot().issues;
        expect(issues).toHaveLength(1);
        expect(issues[0]?.code).toBe(IssueCode.Unexpected);

        const report = store.exportDiagnostics();
        expect(report).toContain('window-error');
        expect(report).toContain('name=TypeError');
        expect(report).not.toContain('boom for alice');

        expect(consoleError).toHaveBeenCalled();
        expect(consoleWarn).not.toHaveBeenCalled();
    });

    it('marks extension-origin script errors as diagnostics, not app failures', (): void => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation((): void => undefined);
        const consoleDebug = vi.spyOn(console, 'debug').mockImplementation((): void => undefined);
        const store = createIssueStore();
        const target = createTarget();

        installRuntimeHandlers(target, store, { appOrigin: 'http://localhost:1730' });
        target.dispatch('error', {
            message: 'extension script failed',
            filename: 'chrome-extension://abcdef/content-script.js',
            error: new RangeError('from an extension'),
        });
        target.dispatch('error', {
            message: 'injected script failed',
            filename: 'safari-web-extension://xyz/inject.js',
            error: new RangeError('injected'),
        });

        expect(store.getIssueSnapshot().issues).toHaveLength(0);

        const report = store.exportDiagnostics();
        expect(report).toContain('extension-error');
        expect(report).toContain('EXTENSION_ORIGIN');

        // No first-party attribution: console.error stays reserved for genuine app failures.
        expect(consoleError).not.toHaveBeenCalled();
        expect(consoleDebug).toHaveBeenCalled();
    });

    it('normalizes primitive rejection reasons without leaking their values', (): void => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation((): void => undefined);
        const store = createIssueStore();
        const target = createTarget();

        installRuntimeHandlers(target, store);
        target.dispatch('unhandledrejection', { reason: 'connection to ws://10.9.9.9:5000 failed' });

        expect(store.getIssueSnapshot().issues).toHaveLength(1);
        expect(store.getIssueSnapshot().issues[0]?.code).toBe(IssueCode.Unexpected);

        const report = store.exportDiagnostics();
        expect(report).toContain('unhandled-rejection');
        expect(report).not.toContain('10.9.9.9');
        expect(consoleError).toHaveBeenCalled();
    });

    it('tolerates garbage handler events', (): void => {
        vi.spyOn(console, 'error').mockImplementation((): void => undefined);
        vi.spyOn(console, 'warn').mockImplementation((): void => undefined);
        const store = createIssueStore();
        const target = createTarget();

        installRuntimeHandlers(target, store);

        expect(() => {
            target.dispatch('error', null);
        }).not.toThrow();
        expect(() => {
            target.dispatch('error', 'just a string event');
        }).not.toThrow();
        expect(() => {
            target.dispatch('unhandledrejection', undefined);
        }).not.toThrow();
    });
});

describe('looksLikeExtensionOrigin', (): void => {
    it('detects extension schemes and foreign origins conservatively', (): void => {
        const appOrigin = 'http://localhost:1730';

        expect(looksLikeExtensionOrigin('chrome-extension://abc/x.js', appOrigin)).toBe(true);
        expect(looksLikeExtensionOrigin('safari-web-extension://abc/x.js', appOrigin)).toBe(true);
        expect(looksLikeExtensionOrigin('moz-extension://abc/x.js', appOrigin)).toBe(true);
        expect(looksLikeExtensionOrigin('https://evil.example.com/x.js', appOrigin)).toBe(true);

        expect(looksLikeExtensionOrigin('http://localhost:1730/src/main.ts', appOrigin)).toBe(false);
        expect(looksLikeExtensionOrigin('/src/main.ts', appOrigin)).toBe(false);
        expect(looksLikeExtensionOrigin('eval at <anonymous>', appOrigin)).toBe(false);
        expect(looksLikeExtensionOrigin(undefined, appOrigin)).toBe(false);

        // Without an app origin to compare against, only explicit schemes count.
        expect(looksLikeExtensionOrigin('chrome-extension://abc/x.js', undefined)).toBe(true);
        expect(looksLikeExtensionOrigin('https://evil.example.com/x.js', undefined)).toBe(false);
    });
});

describe('startApp', (): void => {
    it('reports and renders a fallback when the app module fails to import', async (): Promise<void> => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation((): void => undefined);
        const store = createIssueStore();
        const fallback: StartupFallbackContainer = { hidden: true, textContent: null };

        await startApp({
            window: createWindow('complete'),
            store,
            importMain: (): Promise<MainModule> => Promise.reject(new Error('chunk load failed for alice')),
            getFallbackContainer: (): StartupFallbackContainer => fallback,
        });

        const issues = store.getIssueSnapshot().issues;
        expect(issues).toHaveLength(1);
        expect(issues[0]?.code).toBe(IssueCode.AppInit);

        expect(fallback.hidden).toBe(false);
        expect(fallback.textContent).toContain('Reload');

        const report = store.exportDiagnostics();
        expect(report).toContain('app-init');
        expect(report).not.toContain('chunk load failed');
        expect(report).not.toContain('alice');
        expect(consoleError).toHaveBeenCalled();
    });

    it('reports and renders a fallback when initApp rejects', async (): Promise<void> => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation((): void => undefined);
        const store = createIssueStore();
        const fallback: StartupFallbackContainer = { hidden: true, textContent: null };

        await startApp({
            window: createWindow('complete'),
            store,
            importMain: (): Promise<MainModule> =>
                Promise.resolve({
                    initApp: (): Promise<void> => Promise.reject(new TypeError('init exploded')),
                }),
            getFallbackContainer: (): StartupFallbackContainer => fallback,
        });

        expect(store.getIssueSnapshot().issues[0]?.code).toBe(IssueCode.AppInit);
        expect(fallback.hidden).toBe(false);
        expect(consoleError).toHaveBeenCalled();
    });

    it('initializes through the app module once the page has loaded', async (): Promise<void> => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation((): void => undefined);
        const store = createIssueStore();
        const initApp = vi.fn((): Promise<void> => Promise.resolve());

        await startApp({
            window: createWindow('complete'),
            store,
            importMain: (): Promise<MainModule> => Promise.resolve({ initApp }),
        });

        expect(initApp).toHaveBeenCalledTimes(1);
        expect(store.getIssueSnapshot().issues).toHaveLength(0);
        expect(consoleError).not.toHaveBeenCalled();
    });

    it('waits for the load event when the document is still loading', async (): Promise<void> => {
        const store = createIssueStore();
        const initApp = vi.fn((): Promise<void> => Promise.resolve());
        const win = createWindow('loading');

        const running = startApp({
            window: win,
            store,
            importMain: (): Promise<MainModule> => Promise.resolve({ initApp }),
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(initApp).not.toHaveBeenCalled();

        win.emitLoad();
        await running;
        expect(initApp).toHaveBeenCalledTimes(1);
    });
});

describe('renderStartupFallback', (): void => {
    it('unhides the container and writes plain text only', (): void => {
        const container: StartupFallbackContainer = { hidden: true, textContent: null };

        renderStartupFallback(container, 'The app failed to start. Reload the page to try again.');

        expect(container.hidden).toBe(false);
        expect(container.textContent).toBe('The app failed to start. Reload the page to try again.');
    });

    it('is a no-op without a container', (): void => {
        expect(() => {
            renderStartupFallback(null, 'x');
        }).not.toThrow();
    });
});
