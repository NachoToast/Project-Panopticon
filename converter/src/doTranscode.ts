import { spawn } from "node:child_process";

export async function doTranscode(input: string, output: string, log: (x: string) => void): Promise<void> {
    const ffmpeg = spawn("ffmpeg", [
        "-i", input,
        "-c:v", "libx264",
        "-level", "4.1",
        "-pix_fmt", "yuv420p",
        "-preset", "medium",
        "-crf", "22",
        "-c:a", "aac",
        "-b:a", "128k",
        "-ac", "2",
        "-movflags",
        "+faststart",
        "-nostats",
        "-y",
        "-progress", "pipe:1",
        output
    ]);

    ffmpeg.stdout.setEncoding("utf-8");

    // Duration Reading

    let duration = 0;

    function handleDuration(d: string | NonSharedBuffer): void {
        const data = d.toString().trim();

        const match = data.match(/Duration: (\d+):(\d+):(\d+\.\d+)/);

        if (match) {
            const [, h, m, s] = match;

            duration = parseInt(h) * 3600 + parseInt(m) * 60 + parseFloat(s);

            ffmpeg.stderr.off("data", handleDuration);
        }
    }

    ffmpeg.stderr.on("data", handleDuration);


    // Progress Reading

    function handleProgress(d: string | NonSharedBuffer): void {
        const lines = d.toString().trim().split("\n");

        const progress: Record<string, string> = {};

        for (const line of lines) {
            const [key, value] = line.split("=");

            progress[key] = value;
        }

        if (progress['progress'] === "end") {
            log('Done!');
            ffmpeg.stdout.off('data', handleProgress);
        } else if (progress['out_time_ms'] && progress['out_time_ms'] !== 'N/A' && duration) {
            const outTime = parseInt(progress['out_time_ms']) / 1_000_000;

            const percent = (outTime / duration) * 100;

            log(`${percent.toFixed(2)}%`);
        }
    }

    ffmpeg.stdout.on('data', handleProgress);

    return new Promise((resolve, reject) => {

        ffmpeg.on('error', (error) => {
            ffmpeg.removeAllListeners();

            log(`ERR`);
            reject(error);
        })

        ffmpeg.on("close", (code) => {
            ffmpeg.removeAllListeners();

            if (code === 0) {
                resolve();
            } else {
                reject(code);
            }
        });
    })


}
