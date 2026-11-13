import { IssueStore, issueStore } from './diagnostics/issues';
import { DIAGNOSTIC_TYPES, installRuntimeHandlers, RuntimeTarget } from './diagnostics/runtime';
import { IssueCode, normalizeErrorName, withErrorName } from './diagnostics/snapshot';

/** Structural stand-in for the hidden `#startup-fallback` div. */
export interface StartupFallbackContainer {
    hidden: boolean;
    textContent: string | null;
}

/** The window surface bootstrap needs, fakes stand in for unit tests. */
export interface BootstrapWindow extends RuntimeTarget {
    readonly document: {
        readonly readyState: string;
        getElementById(id: string): StartupFallbackContainer | null;
    };
    readonly location: { readonly origin: string };
    addEventListener(type: string, listener: (event: unknown) => void, options?: { once?: boolean }): void;
}

/** Shape of the dynamically imported application entry. */
export interface MainModule {
    initApp(): Promise<void>;
}

export interface StartAppOptions {
    readonly window: BootstrapWindow;
    readonly store: IssueStore;
    readonly importMain: () => Promise<MainModule>;
    readonly getFallbackContainer?: () => StartupFallbackContainer | null;
}

export const STARTUP_FALLBACK_MESSAGE =
    'The app failed to start. Reload the page to try again. Details are in the browser console.';

/**
 * Renders the minimal plain-text startup fallback: the last resort when the
 * application could not even load, so nothing here may depend on
 * application code or rich markup.
 */
export function renderStartupFallback(container: StartupFallbackContainer | null, message: string): void {
    if (container === null) {
        return;
    }
    container.hidden = false;
    container.textContent = message;
}

/**
 * Waits until the page is ready for `initApp` (no subresource dependency).
 * The wait lives before the dynamic import because a `load` listener
 * registered inside main.ts could be attached too late.
 */
function waitForPageLoad(win: BootstrapWindow): Promise<void> {
    const readyState = win.document.readyState;
    if (readyState === 'interactive' || readyState === 'complete') {
        return Promise.resolve();
    }
    return new Promise<void>((resolve: () => void): void => {
        win.addEventListener(
            'load',
            (): void => {
                resolve();
            },
            { once: true },
        );
    });
}

/**
 * Installs last-resort reporting, waits for the page, then imports and
 * initializes the application. A failure becomes an `app-init` issue,
 * surfaces in the fallback container, and gets logged.
 */
export async function startApp(options: StartAppOptions): Promise<void> {
    const win = options.window;
    const getFallbackContainer =
        options.getFallbackContainer ?? ((): StartupFallbackContainer | null => win.document.getElementById('startup-fallback'));

    installRuntimeHandlers(win, options.store, { appOrigin: win.location.origin });

    await waitForPageLoad(win);

    try {
        const main = await options.importMain();
        await main.initApp();
    } catch (failure) {
        const errorName = normalizeErrorName(failure);
        options.store.recordDiagnostic(withErrorName(DIAGNOSTIC_TYPES.AppInitFailure, Date.now(), errorName));
        options.store.reportIssue({ code: IssueCode.AppInit, error: failure });
        renderStartupFallback(getFallbackContainer(), STARTUP_FALLBACK_MESSAGE);
        console.error(STARTUP_FALLBACK_MESSAGE, failure);
    }
}

// Browser-only entry point: index.html loads this module. The guard keeps the
// module inert when imported by Node-based unit tests.
const host = globalThis as { readonly window?: BootstrapWindow };
if (host.window !== undefined) {
    void startApp({
        window: host.window,
        store: issueStore,
        importMain: async (): Promise<MainModule> => import('./main'),
    });
}
