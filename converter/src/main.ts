import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { doTranscode, type TranscodeProgress } from "./doTranscode";
import { describeOutputRefusal, deriveOutputPath } from "./ffmpegArgs";
import { getTargetExtension, getTargetFolder } from "./getInputs";

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

/** Collect `<folder>/*.<extension>` files (non-recursive). Throws when the
 *  folder has no match, since there is nothing for the run to do. */
export function collectInputFiles(folder: string, extension: string): string[] {
    const inputFiles: string[] = [];

    for (const entry of readdirSync(folder, { withFileTypes: true })) {
        if (entry.isDirectory()) continue;
        if (!entry.name.endsWith(extension)) continue;

        inputFiles.push(join(entry.parentPath, entry.name));
    }

    if (inputFiles.length === 0) {
        throw new Error(`No ${extension} files found in ${folder}`);
    }

    return inputFiles;
}

function clock(seconds: number): string {
    const minutes = Math.floor(seconds / 60);
    const rest = seconds - minutes * 60;

    return `${String(minutes).padStart(2, "0")}:${rest.toFixed(1).padStart(4, "0")}`;
}

/** One plain-text progress line: `name 00:05.0 / 00:10.0 (50%) speed=1.5x`. */
export function formatProgressLine(
    fileName: string,
    progress: TranscodeProgress,
    durationSeconds: number | null,
): string {
    const knownDuration = durationSeconds !== null && durationSeconds > 0;
    const time =
        progress.outTimeSeconds !== null && Number.isFinite(progress.outTimeSeconds)
            ? clock(progress.outTimeSeconds)
            : "--:--.-";
    const total = knownDuration ? ` / ${clock(durationSeconds)}` : "";
    const percent =
        knownDuration && progress.outTimeSeconds !== null
            ? ` (${Math.min(100, (progress.outTimeSeconds / durationSeconds) * 100).toFixed(0)}%)`
            : "";
    const speed = progress.speed !== null ? ` speed=${progress.speed}` : "";

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
        options.write ?? ((text: string) => { process.stdout.write(text); });
    let lastLength = 0;
    let drewLine = false;

    return {
        update(progress: TranscodeProgress): void {
            if (!options.isTty) return;

            drewLine = true;

            const line = formatProgressLine(fileName, progress, null).slice(0, 120);

            write(`\r${line.padEnd(lastLength)}`);
            lastLength = line.length;
        },
        end(): void {
            if (drewLine) write("\n");
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
              `(${failed.map((failure) => basename(failure.file)).join(", ")}).`;

    return { line, exitCode: failed.length === 0 ? 0 : 1 };
}

async function main(): Promise<void> {
    const folder = await getTargetFolder();

    const extension = await getTargetExtension();

    const inputFiles = collectInputFiles(folder, extension);

    const outDir = join(folder, "transcoded");

    mkdirSync(outDir, { recursive: true });

    const succeeded: string[] = [];
    const failed: { file: string; error: unknown }[] = [];

    // Collision check before starting: every output path that already exists
    // is named now, and its file is skipped — the rest of the batch still runs.
    const runnable: string[] = [];

    for (const file of inputFiles) {
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
            const result = await doTranscode(file, outDir, { onProgress: display.update });

            display.end();
            console.log(`✓ ${basename(file)} → ${result.output} (${(result.elapsedMs / 1000).toFixed(1)}s)`);
            succeeded.push(file);
        } catch (error) {
            display.end();
            console.error(`✗ ${basename(file)}: ${error instanceof Error ? error.message : String(error)}`);
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
