import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { doTranscode } from "./doTranscode";
import { getTargetExtension, getTargetFolder } from "./getInputs";
import { ProgressLogger } from "./progressLogger";

const folder = await getTargetFolder();

const extension = await getTargetExtension();

const inputFiles: string[] = [];

for (const file of readdirSync(folder, { withFileTypes: true })) {
    if (file.isDirectory()) continue;
    if (!file.name.endsWith(extension)) continue;

    inputFiles.push(join(file.parentPath, file.name));
}

if (inputFiles.length === 0) {
    throw new Error(`No ${extension} files found in ${folder}`);
}

const outDir = join(folder, "transcoded");

if (!existsSync(outDir)) {
    mkdirSync(outDir);
}

const padAmount = Math.max(...inputFiles.map(x => basename(x).length)) + 1;

const logger = new ProgressLogger(inputFiles.map(x => basename(x).padEnd(padAmount, " ")))

const promises = await Promise.allSettled(inputFiles.map((file, i) => {
    return doTranscode(file, join(outDir, basename(file)), x => logger.log(i, x));
}))

logger.close();

for (const promise of promises) {
    if (promise.status === 'fulfilled') continue;

    console.error(promise.reason)
}
