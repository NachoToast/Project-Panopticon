import { expect, test } from '@playwright/test';

// Harness smoke test: proves the project's engine launches, the driver
// connects, and locators/assertions work (runs under chromium, firefox,
// and webkit). Real-page coverage lives in playback.spec.ts.
test('the browser harness launches and renders a page', async ({ page }): Promise<void> => {
    await page.setContent('<h1>Panopticon browser harness</h1>');

    await expect(page.locator('h1')).toHaveText('Panopticon browser harness');
});
