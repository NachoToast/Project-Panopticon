import { IssueStore, normalizeErrorName } from './issues';
import { IssueCode } from './snapshot';

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
    /** Origin the app is served from; foreign http(s) scripts are flagged. */
    readonly appOrigin?: string;
}

/**
 * Conservative filter for script origins that look like browser extensions.
 * This is informational only: matching does not prove an extension caused a
 * failure, and nothing may present it as a first-party app failure either.
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
    return /^https?:\/\//.test(filename) && !filename.startsWith(appOrigin);
}

/**
 * Installs last-resort `error` and `unhandledrejection` handlers that
 * normalize and report into the issue store. Native console behavior is
 * preserved: genuine failures still go through `console.error`, and the
 * handlers never call `preventDefault`.
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
                type: DIAGNOSTIC_TYPES.ExtensionError,
                at: Date.now(),
                ...(errorName !== undefined ? { errorName } : {}),
                extensionOrigin: true,
            });
            console.debug('[panopticon] recorded non-app script error (possible extension origin)');
            return;
        }

        store.recordDiagnostic({
            type: DIAGNOSTIC_TYPES.WindowError,
            at: Date.now(),
            ...(errorName !== undefined ? { errorName } : {}),
        });
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

        store.recordDiagnostic({
            type: DIAGNOSTIC_TYPES.UnhandledRejection,
            at: Date.now(),
            ...(errorName !== undefined ? { errorName } : {}),
        });
        store.reportIssue({ code: IssueCode.Unexpected, error: reason });
        console.error(reason ?? event);
    } catch (handlerFailure) {
        console.warn('[panopticon] runtime rejection handler failed', handlerFailure);
    }
}
