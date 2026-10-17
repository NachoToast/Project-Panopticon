import { IssueStore } from './issues';
import { IssueCode, normalizeErrorName, withErrorName } from './snapshot';

/** Diagnostic type strings recorded by the runtime handlers. */
export const DIAGNOSTIC_TYPES = {
    WindowError: 'window-error',
    UnhandledRejection: 'unhandled-rejection',
    ExtensionError: 'extension-error',
    AppInitFailure: 'app-init-failure',
} as const;

const EXTENSION_SCHEMES: readonly string[] = [
    'chrome-extension://',
    'safari-web-extension://',
    'moz-extension://',
];

/** Anything that can register global event listeners (the browser passes `window`). */
export interface RuntimeTarget {
    addEventListener(type: string, listener: (event: unknown) => void): void;
}

export interface InstallRuntimeHandlersOptions {
    /** Flags scripts served from other http(s) origins. */
    readonly appOrigin?: string;
}

/**
 * Broad detector for non-first-party script origins. Deliberately broad,
 * with conservative attribution: a match does not prove an extension caused
 * the failure, and callers must not present it as an app failure either.
 */
export function looksLikeExtensionOrigin(filename: unknown, appOrigin: string | undefined): boolean {
    if (typeof filename !== 'string' || filename.length === 0) {
        return false;
    }
    if (EXTENSION_SCHEMES.some((scheme: string): boolean => filename.startsWith(scheme))) {
        return true;
    }
    if (appOrigin === undefined || appOrigin.length === 0) {
        return false;
    }
    if (!/^https?:\/\//.test(filename)) {
        return false;
    }
    try {
        // Compare origins, not prefixes, so lookalikes like
        // localhost:1730.evil.com get caught.
        return new URL(filename).origin !== appOrigin;
    } catch {
        // An unparsable http(s) URL can't be one of our scripts, so treat
        // it as foreign. Diagnostic only.
        return true;
    }
}

/**
 * Installs last-resort `error` and `unhandledrejection` handlers reporting
 * into the issue store. Native console behavior is preserved.
 */
export function installRuntimeHandlers(
    target: RuntimeTarget,
    store: IssueStore,
    options: InstallRuntimeHandlersOptions = {},
): void {
    target.addEventListener('error', (event: unknown): void => {
        handleScriptError(event, store, options.appOrigin);
    });
    target.addEventListener('unhandledrejection', (event: unknown): void => {
        handleRejection(event, store);
    });
}

function readEventField(event: unknown, field: string): unknown {
    if (typeof event !== 'object' || event === null) {
        return undefined;
    }
    return (event as Record<string, unknown>)[field];
}

function handleScriptError(event: unknown, store: IssueStore, appOrigin: string | undefined): void {
    try {
        const message = readEventField(event, 'message');
        const filename = readEventField(event, 'filename');
        const error = readEventField(event, 'error');
        const errorName = normalizeErrorName(error);

        if (looksLikeExtensionOrigin(filename, appOrigin)) {
            store.recordDiagnostic({
                ...withErrorName(DIAGNOSTIC_TYPES.ExtensionError, Date.now(), errorName),
                extensionOrigin: true,
            });
            console.debug('[panopticon] recorded non-app script error (possible extension origin)');
            return;
        }

        store.recordDiagnostic(withErrorName(DIAGNOSTIC_TYPES.WindowError, Date.now(), errorName));
        store.reportIssue({ code: IssueCode.Unexpected, error: error ?? message });
        console.error(error ?? message ?? event);
    } catch (handlerFailure) {
        console.warn('[panopticon] runtime error handler failed', handlerFailure);
    }
}

function handleRejection(event: unknown, store: IssueStore): void {
    try {
        const reason = readEventField(event, 'reason');
        const errorName = normalizeErrorName(reason);

        store.recordDiagnostic(withErrorName(DIAGNOSTIC_TYPES.UnhandledRejection, Date.now(), errorName));
        store.reportIssue({ code: IssueCode.Unexpected, error: reason });
        console.error(reason ?? event);
    } catch (handlerFailure) {
        console.warn('[panopticon] runtime rejection handler failed', handlerFailure);
    }
}
