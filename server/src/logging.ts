/**
 * Application logging with TTY-aware rendering.
 *
 * The server used to render its room state by calling
 * `process.stdout.moveCursor`/`clearScreenDown` unconditionally. Node only
 * implements those on real TTY streams: under a pipe (services, test
 * runners, `node | cat`) they are undefined and the first state log crashed
 * the server with a TypeError. The logger therefore probes the stream and
 * falls back to plain sequential writes when cursor controls are missing.
 */

export interface Logger {
    /**
     * Renders the current application state via the injected renderer,
     * skips unchanged state, and writes it (rewriting in place on a TTY).
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

/** How many lines a state render occupies (header + one per room). */
const STATE_BLOCK_LINES = 4;

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

    const writeLine = (line: string): void => {
        stream.write(`${line}\n`);
    };

    return {
        logApplicationState(): void {
            const state = options.renderState();
            if (state === lastState) return;

            lastState = state;

            if (canRewrite(stream)) {
                // Move back onto the previous state block and clear it so the
                // new render replaces it in place. Skipped entirely for pipes,
                // where the same output simply appends sequentially.
                stream.moveCursor(0, -STATE_BLOCK_LINES);
                stream.clearScreenDown();
            }

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

    const json: unknown = JSON.stringify(item);
    return typeof json === 'string' ? json : String(item);
}
