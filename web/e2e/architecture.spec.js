// architecture.spec.js — confirms the Architecture tab lazy-loads Mermaid,
// renders all 3 SVG diagrams, and that the component cards expand on click.
import { test, expect } from '@playwright/test';
import { setupApiMocks } from './helpers/mocks.js';

test.describe('architecture tab', () => {
  test('lazy-loads three Mermaid diagrams as SVG', async ({ page }) => {
    await setupApiMocks(page);
    await page.goto('/');
    await page.getByRole('button', { name: 'Architecture', exact: true }).click();

    // Mermaid is lazy-imported, so give it generous time to render.
    await expect(page.locator('.mermaid-host svg').nth(0)).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.mermaid-host svg').nth(1)).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.mermaid-host svg').nth(2)).toBeVisible({ timeout: 20_000 });

    const count = await page.locator('.mermaid-host svg').count();
    expect(count).toBeGreaterThanOrEqual(3);
  });

  test('component cards expand on click', async ({ page }) => {
    await setupApiMocks(page);
    await page.goto('/');
    await page.getByRole('button', { name: 'Architecture', exact: true }).click();

    // The 'Worker pipeline' card starts open by default per the source.
    const workerCard = page.locator('.arch-card').filter({ hasText: 'Worker pipeline' });
    await expect(workerCard).toHaveClass(/open/);

    // Pick one that is closed by default and click it to expand.
    const listenersCard = page.locator('.arch-card').filter({ hasText: 'Webhook listeners' });
    await expect(listenersCard).not.toHaveClass(/open/);
    await listenersCard.click();
    await expect(listenersCard).toHaveClass(/open/);
    // The expanded body contains a UL of bullet points.
    await expect(listenersCard.locator('ul.arch-card-details li').first()).toBeVisible();

    // Toggling again collapses it.
    await listenersCard.click();
    await expect(listenersCard).not.toHaveClass(/open/);
  });
});
