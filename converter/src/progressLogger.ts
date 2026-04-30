
export class ProgressLogger {
    private readonly fileNames: string[];

    private readonly output: string[];

    private readonly interval: NodeJS.Timeout;

    private isDirty: boolean;

    public constructor(fileNames: string[]) {
        this.fileNames = fileNames;

        this.output = new Array(fileNames.length).fill('-');

        for (let i = 0; i < this.fileNames.length; i++) {
            process.stdout.write(`${this.fileNames[i]} ${this.output[i]}\n`);
        }

        this.interval = setInterval(() => {
            if (this.isDirty) {
                this.isDirty = false;
                this.update();
            }
        }, 250);

        this.isDirty = true;
    }

    private update(): void {
        process.stdout.moveCursor(0, -this.fileNames.length);

        for (let i = 0; i < this.fileNames.length; i++) {
            process.stdout.moveCursor(this.fileNames[i].length + 1, 0);
            process.stdout.write(`${this.output[i]}\n`);
        }
    }

    public log(index: number, value: string): void {
        this.output[index] = value;
        this.isDirty = true;
    }

    public close(): void {
        clearInterval(this.interval);
    }
}
