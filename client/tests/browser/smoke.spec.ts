import { expect, test } from '@playwright/test';

// Harness smoke test: proves chromium launches, the driver connects, and
// locators/assertions work. Real page tests arrive with Task 6.
test('the browser harness launches and renders a page', async ({ page }): Promise<void> => {
    await page.setContent('<h1>Panopticon browser harness</h1>');

    await expect(page.locator('h1')).toHaveText('Panopticon browser harness');
});
