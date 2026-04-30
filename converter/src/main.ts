import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { doTranscode } from "./doTranscode";
import { getTargetExtension, getTargetFolder } from "./getInputs";

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

for (const file of inputFiles) {
    await doTranscode(file, join(outDir, basename(file)));
}
