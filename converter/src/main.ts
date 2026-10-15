import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { doTranscode, type TranscodeProgress } from './doTranscode';
import { describeOutputRefusal, deriveOutputPath } from './ffmpegArgs';
import { getTargetExtension, getTargetFolder } from './getInputs';

/**
 * CLI entry point.
 *
 * UX contract:
 * - prompt for folder + extension, convert every matching file serially;
 * - check all output collisions UP FRONT so a conflict is named before any
 *   encoding work starts, then convert everything that can run;
 * - one line per file completion (works identically on a TTY and a pipe);
 * - live progress only on a TTY, drawn with plain `\r` + padding — never
 *   moveCursor/clearLine, which throw when stdout is a pipe;
 * - a failing file does not abort the run: the loop continues, the summary
 *   reports `n converted, m failed`, and the process exits nonzero if
 *   anything failed.
 */

/** Collect `<folder>/*.<extension>` files (non-recursive). The match is a
 *  case-insensitive `.<extension>` suffix: `clip.mkv` and `clip.MKV` both
 *  match, while `clipsmkv` (bare suffix) and `note.mkvx` (longer suffix)
 *  do not. Throws when the folder has no match, since there is nothing
 *  for the run to do. */
export function collectInputFiles(folder: string, extension: string): string[] {
    const suffix = `.${extension.replaceAll('.', '')}`.toLowerCase();
    const inputFiles: string[] = [];

    for (const entry of readdirSync(folder, { withFileTypes: true })) {
        if (entry.isDirectory()) continue;
        if (!entry.name.toLowerCase().endsWith(suffix)) continue;

        inputFiles.push(join(entry.parentPath, entry.name));
    }

    if (inputFiles.length === 0) {
        throw new Error(`No ${extension} files found in ${folder}`);
    }

    return inputFiles;
}

/** `mm:ss.d` on a 60-second dial. The seconds remainder is rounded FIRST
 *  and a full minute carried, so rounding never renders a nonexistent
 *  00:60.0 (clock(59.96) → 01:00.0). */
export function clock(seconds: number): string {
    const tenths = Math.round(seconds * 10);
    const minutes = Math.floor(tenths / 600);
    const rest = (tenths - minutes * 600) / 10;

    return `${String(minutes).padStart(2, '0')}:${rest.toFixed(1).padStart(4, '0')}`;
}

/** One plain-text progress line: `name 00:05.0 / 00:10.0 (50%) speed=1.5x`. */
export function formatProgressLine(
    fileName: string,
    progress: TranscodeProgress,
    durationSeconds: number | null,
): string {
    const knownDuration = durationSeconds !== null && durationSeconds > 0;
    const time =
        progress.outTimeSeconds !== null &&
        Number.isFinite(progress.outTimeSeconds)
            ? clock(progress.outTimeSeconds)
            : '--:--.-';
    const total = knownDuration ? ` / ${clock(durationSeconds)}` : '';
    const percent =
        knownDuration && progress.outTimeSeconds !== null
            ? ` (${Math.min(100, (progress.outTimeSeconds / durationSeconds) * 100).toFixed(0)}%)`
            : '';
    const speed = progress.speed !== null ? ` speed=${progress.speed}` : '';

    return `${fileName} ${time}${total}${percent}${speed}`;
}

export type FileProgressDisplay = {
    update(progress: TranscodeProgress): void;
    end(): void;
};

/**
 * TTY-only in-place progress via `\r` + right-padding (padding erases any
 * leftover characters when the new line is shorter). On a pipe it stays
 * completely silent — piping must never throw, and a piped run gets one
 * line per file completion instead.
 */
export function createFileProgress(
    fileName: string,
    options: { isTty: boolean; write?: (text: string) => void },
): FileProgressDisplay {
    const write =
        options.write ??
        ((text: string) => {
            process.stdout.write(text);
        });
    let lastLength = 0;
    let drewLine = false;

    return {
        update(progress: TranscodeProgress): void {
            if (!options.isTty) return;

            drewLine = true;

            // The duration rides on the progress payload (threaded from the
            // preflight probe by doTranscode), so the TTY percent display
            // works in production.
            const line = formatProgressLine(
                fileName,
                progress,
                progress.durationSeconds,
            ).slice(0, 120);

            write(`\r${line.padEnd(lastLength)}`);
            lastLength = line.length;
        },
        end(): void {
            if (drewLine) write('\n');
        },
    };
}

/** Final line + process exit policy: nonzero exit when anything failed. */
export function summarizeRun(
    succeeded: readonly string[],
    failed: readonly { file: string; error: unknown }[],
): { line: string; exitCode: number } {
    const line =
        failed.length === 0
            ? `Done: ${succeeded.length} converted, 0 failed.`
            : `Done: ${succeeded.length} converted, ${failed.length} failed ` +
              `(${failed.map((failure) => basename(failure.file)).join(', ')}).`;

    return { line, exitCode: failed.length === 0 ? 0 : 1 };
}

/**
 * Inputs whose derived outputs collide case-insensitively.
 *
 * The comparison is unconditionally case-insensitive (not gated on a
 * filesystem probe): default APFS/Darwin and NTFS/Windows filesystems treat
 * `A.mp4` and `a.mp4` as the same file, so on a case-SENSITIVE filesystem
 * the collision is merely cosmetic — both outputs would still be distinct
 * files — while on a case-insensitive one the second conversion would
 * clobber the first during promotion. Naming the collision up front is
 * correct in both worlds and costs nothing.
 */
export function findCaseInsensitiveOutputCollisions(
    inputs: readonly string[],
    outDir: string,
): { output: string; inputs: string[] }[] {
    const groups = new Map<string, string[]>();

    for (const input of inputs) {
        const output = deriveOutputPath(input, outDir);
        const key = output.toLowerCase();
        const group = groups.get(key);

        if (group === undefined) {
            groups.set(key, [input]);
        } else {
            group.push(input);
        }
    }

    const collisions: { output: string; inputs: string[] }[] = [];

    for (const groupInputs of groups.values()) {
        if (groupInputs.length > 1) {
            collisions.push({
                output: deriveOutputPath(groupInputs[0]!, outDir),
                inputs: groupInputs,
            });
        }
    }

    return collisions;
}

async function main(): Promise<void> {
    const folder = await getTargetFolder();

    const extension = await getTargetExtension();

    const inputFiles = collectInputFiles(folder, extension);

    const outDir = join(folder, 'transcoded');

    mkdirSync(outDir, { recursive: true });

    const succeeded: string[] = [];
    const failed: { file: string; error: unknown }[] = [];

    // Collision check before starting: every output path that already exists
    // is named now, and its file is skipped — the rest of the batch still
    // runs. Deliberately duplicated with doTranscode's per-file guard: this
    // pre-check names every collision before any encoding work starts,
    // while the guard inside doTranscode still protects standalone API
    // callers and the TOCTOU window between this check and each file's
    // turn. Keep both.
    const runnable: string[] = [];

    // Case-insensitive collisions BETWEEN batch members (A.mkv + a.mkv
    // derive outputs that are the same file on default APFS/NTFS) are also
    // named up front, before any encoding work.
    const collisionByInput = new Map<
        string,
        { output: string; inputs: string[] }
    >();

    for (const collision of findCaseInsensitiveOutputCollisions(
        inputFiles,
        outDir,
    )) {
        for (const input of collision.inputs) {
            collisionByInput.set(input, collision);
        }
    }

    for (const file of inputFiles) {
        const collision = collisionByInput.get(file);

        if (collision !== undefined) {
            const names = collision.inputs
                .map((input: string) => basename(input))
                .join(', ');
            const refusal =
                `Refusing to convert: case-insensitive output collision — ${names} would all ` +
                `write ${collision.output}; this filesystem treats e.g. A.mp4 and a.mp4 as the ` +
                `same file. Rename the inputs so their outputs differ.`;

            console.error(`✗ ${basename(file)}: ${refusal}`);
            failed.push({ file, error: new Error(refusal) });
            continue;
        }

        const output = deriveOutputPath(file, outDir);
        const refusal = describeOutputRefusal(file, output, existsSync(output));

        if (refusal !== null) {
            console.error(`✗ ${basename(file)}: ${refusal}`);
            failed.push({ file, error: new Error(refusal) });
            continue;
        }

        runnable.push(file);
    }

    for (const file of runnable) {
        const display = createFileProgress(basename(file), {
            isTty: process.stdout.isTTY ?? false,
        });

        try {
            const result = await doTranscode(file, outDir, {
                onProgress: display.update,
            });

            display.end();
            console.log(
                `✓ ${basename(file)} → ${result.output} (${(result.elapsedMs / 1000).toFixed(1)}s)`,
            );

            // x264 warns (but does not fail) when the requested level is
            // impossible — surface it so a promoted file never carries a
            // lying level flag silently.
            for (const warning of result.warnings) {
                console.log(`  ⚠ ${warning.trim()}`);
            }

            succeeded.push(file);
        } catch (error) {
            display.end();
            console.error(
                `✗ ${basename(file)}: ${error instanceof Error ? error.message : String(error)}`,
            );
            failed.push({ file, error });
        }
    }

    const summary = summarizeRun(succeeded, failed);

    console.log(summary.line);
    process.exitCode = summary.exitCode;
}

if (import.meta.main) {
    await main();
}
