/**
 * Bounded stderr accumulation.
 *
 * ffmpeg writes diagnostics to stderr in arbitrary-sized chunks; an error
 * message can be split across many chunk boundaries, so chunks are
 * concatenated first and only then trimmed. The tail keeps at most
 * `maxBytes` bytes and drops any partial UTF-8 sequence at the front so the
 * retained text never begins with a replacement character.
 */
export class StderrTail {
    private buffer: Buffer = Buffer.alloc(0);

    constructor(readonly maxBytes: number = 64 * 1024) {}

    push(chunk: Buffer | Uint8Array | string): void {
        const bytes = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);

        this.buffer =
            this.buffer.length === 0 ? bytes : Buffer.concat([this.buffer, bytes]);

        if (this.buffer.length > this.maxBytes) {
            let start = this.buffer.length - this.maxBytes;

            // Skip UTF-8 continuation bytes (0b10xxxxxx) so the tail starts on
            // a character boundary.
            while (start < this.buffer.length && (this.buffer[start]! & 0xc0) === 0x80) {
                start += 1;
            }

            this.buffer = this.buffer.subarray(start);
        }
    }

    get byteLength(): number {
        return this.buffer.length;
    }

    tail(): string {
        return this.buffer.toString("utf8");
    }
}

/**
 * Human-readable explanation for a failed `spawn`. The ENOENT case gets its
 * own wording because "missing binary" is by far the most common cause and
 * deserves an actionable message.
 */
export function describeSpawnFailure(binary: string, error: unknown): string {
    const code = (error as NodeJS.ErrnoException | null)?.code;

    if (code === "ENOENT") {
        return (
            `${binary} was not found on PATH. Install ffmpeg (the brew/apt/zip ` +
            `bundles include ffprobe) or fix PATH so both binaries resolve.`
        );
    }

    return `failed to start ${binary}: ${error instanceof Error ? error.message : String(error)}`;
}
