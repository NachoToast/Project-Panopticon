/**
 * Application logging with TTY-aware rendering. Node only implements
 * `moveCursor`/`clearScreenDown` on real TTY streams; under a pipe they
 * are undefined and the old unconditional calls crashed the server. The
 * logger probes the stream and falls back to plain sequential writes.
 */

export interface Logger {
    /**
     * Renders the current application state via the injected renderer,
     * skipping unchanged state (rewriting in place on a TTY).
     */
    logApplicationState(): void;

    /** Plain informational line. */
    info(message: string): void;

    /** Warning line with optional inspected metadata. */
    warn(message: string, ...meta: unknown[]): void;

    /** Error line with optional inspected metadata. */
    error(message: string, ...meta: unknown[]): void;
}

export interface LoggerOptions {
    /** Renders the current application state (e.g. the room registry). */
    readonly renderState: () => string;
}

function canRewrite(stream: NodeJS.WriteStream): boolean {
    // Node types declare `isTTY: boolean`, but at runtime piped streams leave
    // it undefined; read through an optional view so the guard stays honest.
    // eslint-disable-next-line @typescript-eslint/naming-convention -- isTTY is Node's own stream API name
    const tty = (stream as { isTTY?: boolean }).isTTY === true;

    return (
        tty &&
        typeof stream.moveCursor === 'function' &&
        typeof stream.clearScreenDown === 'function'
    );
}

export function createLogger(
    stream: NodeJS.WriteStream,
    options: LoggerOptions,
): Logger {
    let lastState = '';
    /** Height of the last rendered state block (header + state lines). */
    let lastStateLines = 0;

    const writeLine = (line: string): void => {
        stream.write(`${line}\n`);
    };

    return {
        logApplicationState(): void {
            const state = options.renderState();
            if (state === lastState) return;

            if (lastStateLines > 0 && canRewrite(stream)) {
                // Move back onto the previous state block and clear it so
                // the new render replaces it in place. The height is
                // whatever the PREVIOUS block actually occupied — anything
                // interleaved since (info/warn/error lines) is wiped with
                // it. Skipped entirely for pipes and for the first render,
                // where there is no block to rewrite.
                stream.moveCursor(0, -lastStateLines);
                stream.clearScreenDown();
            }

            lastState = state;
            lastStateLines = state.split('\n').length + 1;

            writeLine(`=== [${new Date().toLocaleTimeString('en-NZ')}] ===`);
            writeLine(state);
        },
        info(message: string): void {
            writeLine(message);
        },
        warn(message: string, ...meta: unknown[]): void {
            writeLine(`WARN ${formatMeta(message, meta)}`);
        },
        error(message: string, ...meta: unknown[]): void {
            writeLine(`ERROR ${formatMeta(message, meta)}`);
        },
    };
}

function formatMeta(message: string, meta: readonly unknown[]): string {
    if (meta.length === 0) return message;
    return meta
        .reduce<string>(
            (line, item) => `${line} ${describe(item)}`,
            message,
        )
        .trimEnd();
}

function describe(item: unknown): string {
    if (typeof item === 'string') return item;

    // JSON.stringify(new Error()) is "{}" (message/stack are not
    // enumerable) and it THROWS on circular structures — both fatal for
    // a logging path that must never fail to log.
    if (item instanceof Error) return item.stack ?? String(item);

    try {
        const json: unknown = JSON.stringify(item);
        return typeof json === 'string' ? json : String(item);
    } catch {
        return String(item);
    }
}
