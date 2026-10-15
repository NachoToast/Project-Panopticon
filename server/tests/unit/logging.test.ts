import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '../../src/logging.js';

// The application logger must never throw when stdout is a PIPE: Node only
// implements moveCursor/clearScreenDown on TTY streams, and the previous
// logApplicationState crashed the server on first admission under pipes.

interface FakeStreamOptions {
    readonly tty: boolean;
    readonly cursorControls: boolean;
}

interface FakeStream {
    readonly stream: NodeJS.WriteStream;
    readonly writes: string[];
    readonly moveCursor: ReturnType<typeof vi.fn>;
    readonly clearScreenDown: ReturnType<typeof vi.fn>;
}

/** A minimal recorded stand-in for process.stdout. */
function fakeStream(options: FakeStreamOptions): FakeStream {
    const writes = new Array<string>();
    const moveCursor = vi.fn();
    const clearScreenDown = vi.fn();

    const stream: Record<string, unknown> = {
        writes,
        write: (chunk: string): boolean => {
            writes.push(chunk);
            return true;
        },
        // Cursor controls only exist on real TTYs; pipes leave them absent.
        ...(options.cursorControls
            ? { moveCursor, clearScreenDown }
            : { moveCursor: undefined, clearScreenDown: undefined }),
    };

    // Bracket assignment: `isTTY` is the stream API's own (non-camelCase) name.
    stream['isTTY'] = options.tty;

    return {
        stream: stream as unknown as NodeJS.WriteStream,
        writes,
        moveCursor,
        clearScreenDown,
    };
}

/** A state renderer that yields the given lines in order, one per call. */
function renderer(states: readonly string[]): { renderState: () => string } {
    let index = 0;
    return {
        renderState: (): string => {
            const last = states[states.length - 1] ?? '';
            const state = states[index] ?? last;
            index = Math.min(index + 1, states.length - 1);
            return state;
        },
    };
}

describe('createLogger', (): void => {
    it('does not throw when the stream is a pipe without cursor controls', (): void => {
        const fake = fakeStream({ tty: false, cursorControls: false });
        const logger = createLogger(fake.stream, renderer(['Admins(0) {  }']));

        expect((): void => {
            logger.logApplicationState();
        }).not.toThrow();
    });

    it('writes the rendered state sequentially on a pipe', (): void => {
        const fake = fakeStream({ tty: false, cursorControls: false });
        const logger = createLogger(fake.stream, renderer(['Admins(1) { host }']));

        logger.logApplicationState();

        expect(fake.writes.join('')).toContain('Admins(1) { host }');
        expect(fake.moveCursor).not.toHaveBeenCalled();
    });

    it('rewrites in place with cursor controls on a TTY', (): void => {
        const fake = fakeStream({ tty: true, cursorControls: true });
        const logger = createLogger(fake.stream, renderer(['Admins(1) { host }']));

        logger.logApplicationState();

        expect(fake.moveCursor).toHaveBeenCalledWith(0, -4);
        expect(fake.clearScreenDown).toHaveBeenCalledOnce();
        expect(fake.writes.join('')).toContain('Admins(1) { host }');
    });

    it('skips unchanged state', (): void => {
        const fake = fakeStream({ tty: false, cursorControls: false });
        const logger = createLogger(fake.stream, renderer(['same']));

        logger.logApplicationState();
        const afterFirst = fake.writes.length;
        logger.logApplicationState();

        expect(fake.writes.length).toBe(afterFirst);
    });

    it('logs changed state again', (): void => {
        const fake = fakeStream({ tty: false, cursorControls: false });
        const logger = createLogger(fake.stream, renderer(['first', 'second']));

        logger.logApplicationState();
        logger.logApplicationState();

        const output = fake.writes.join('');
        expect(output).toContain('first');
        expect(output).toContain('second');
    });

    it('writes info/warn/error messages through the stream', (): void => {
        const fake = fakeStream({ tty: false, cursorControls: false });
        const logger = createLogger(fake.stream, renderer(['unused']));

        logger.info('hello');
        logger.warn('careful', { detail: 1 });
        logger.error('broken');

        const output = fake.writes.join('');
        expect(output).toContain('hello');
        expect(output).toContain('careful');
        expect(output).toContain('broken');
    });

    it('logs an Error as its stack, not an empty object', (): void => {
        const fake = fakeStream({ tty: false, cursorControls: false });
        const logger = createLogger(fake.stream, renderer(['unused']));

        logger.error('room join failed', new Error('adapter unavailable'));

        // JSON.stringify(new Error()) is "{}" — message and stack are
        // not enumerable — which made every logged error unreadable.
        const output = fake.writes.join('');
        expect(output).toContain('adapter unavailable');
    });

    it('does not throw on circular metadata', (): void => {
        const fake = fakeStream({ tty: false, cursorControls: false });
        const logger = createLogger(fake.stream, renderer(['unused']));
        const circular: Record<string, unknown> = {};
        circular['self'] = circular;

        // JSON.stringify throws on cycles; the error path must never
        // fail to log (and never crash the caller) because of it.
        expect((): void => {
            logger.warn('careful', circular);
        }).not.toThrow();
        expect(fake.writes.join('')).toContain('careful');
    });
});
