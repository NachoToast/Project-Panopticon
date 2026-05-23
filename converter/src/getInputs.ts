
async function prompt(text: string): Promise<string> {
    process.stdout.write(text);

    return new Promise((resolve) => {
        function handleData(d: string | NonSharedBuffer): void {
            const data = d.toString().trim();

            if (data.length === 0) {
                process.stdout.write(text);
            } else {
                process.stdin.off('data', handleData);
                resolve(data);
            }
        }

        process.stdin.on("data", handleData);
    })
}

export async function getTargetFolder(): Promise<string> {
    return await prompt("Enter target folder path: ");
}

export async function getTargetExtension(): Promise<string> {
    const value = await prompt("Enter file extension: ");

    return value.replaceAll('.', '');
}
