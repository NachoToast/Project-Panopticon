const SIZE = 20;
const SPACING = 1;
const STYLE = 'rgba(23, 23, 23, 0.3)';

export function makeBackgroundCanvas(): void {
    const canvas = document.createElement('canvas');

    canvas.style.position = 'fixed';
    canvas.style.top = '0';
    canvas.style.left = '0';
    canvas.style.zIndex = '-1';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.backgroundColor = 'black';

    document.body.appendChild(canvas);

    const context = canvas.getContext('2d');

    if (context === null) {
        console.warn(
            'Could not get 2d context for canvas, skipping background draw',
        );
        return;
    }

    const ctx = context;

    function drawToCanvas(): void {
        const width = (canvas.width = window.innerWidth);
        const height = (canvas.height = window.innerHeight);

        const squaresPerRow = Math.ceil((width - SPACING) / (SIZE + SPACING));

        const squaresPerCol = Math.ceil((height - SPACING) / (SIZE + SPACING));

        const numSquares = squaresPerRow * squaresPerCol;

        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = STYLE;

        for (let i = 0; i < numSquares; i++) {
            const row = Math.floor(i / squaresPerRow);
            const col = i - row * squaresPerRow;

            const x = SPACING + col * (SIZE + SPACING);
            const y = SPACING + row * (SIZE + SPACING);

            ctx.fillRect(x, y, SIZE, SIZE);
        }
    }

    window.requestAnimationFrame(drawToCanvas);

    window.addEventListener('resize', () => {
        window.requestAnimationFrame(drawToCanvas);
    });
}
