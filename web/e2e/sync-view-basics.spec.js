// sync-view-basics.spec.js — verifies the SyncView "simulate" path: pull
// Dynamics records, select two of them, run the simulated transfer, and
// confirm the mapping preview + transfer log appear AND no real POST to
// /api/simulate/transfer is fired in sim mode.
import { test, expect } from '@playwright/test';
import { setupApiMocks, makeContacts } from './helpers/mocks.js';

test.describe('sync view — simulate', () => {
  test('pull → select → simulate transfer (no real POST)', async ({ page }) => {
    const contacts = makeContacts(3);
    let transferPosts = 0;
    await setupApiMocks(page, {
      simulatePull: async (route) => {
        const u = new URL(route.request().url());
        const side   = u.searchParams.get('side');
        const entity = u.searchParams.get('entity');
        if (side === 'dynamics' && entity === 'contact') {
          return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ dynamics: { rows: contacts, nextCursor: null } }),
          });
        }
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ [side]: { rows: [], nextCursor: null } }),
        });
      },
      simulateTransfer: async (route) => {
        transferPosts += 1;
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ enqueued: { dynamics: 0, marketo: 0 }, jobs: [], errors: [] }),
        });
      },
    });

    await page.goto('/');
    await page.getByRole('button', { name: 'Sync View', exact: true }).click();

    // Entity defaults to Contact, direction defaults to → (d2m). Click Pull.
    await page.getByRole('button', { name: /Pull Dynamics/ }).click();

    // Three cards appear in the Dynamics column. Re-pull button confirms the
    // load is done (button text flips from "Pull" to "Re-pull" once rows arrive).
    const dynColumn = page.locator('.sv-col').filter({ hasText: 'Dynamics CRM' });
    await expect(dynColumn.locator('.sv-card')).toHaveCount(3);

    // Select two cards by clicking their checkboxes.
    await dynColumn.locator('.sv-card').nth(0).locator('input[type=checkbox]').check();
    await dynColumn.locator('.sv-card').nth(1).locator('input[type=checkbox]').check();

    // Selected count chip in the controls bar updates to "2 selected".
    await expect(page.getByText(/2 selected/)).toBeVisible();

    // Click Simulate transfer.
    await page.getByRole('button', { name: /Simulate transfer/ }).click();

    // Mapping preview appears.
    await expect(page.getByRole('heading', { name: /Mapping preview/ })).toBeVisible();

    // Log shows two success rows.
    await expect(page.getByRole('heading', { name: /Transfer log \(simulated\)/ })).toBeVisible();
    await expect(page.locator('.sv-log li')).toHaveCount(2);
    await expect(page.locator('.sv-log .chip.success')).toHaveCount(2);

    // No POST to /api/simulate/transfer should have been made in sim mode.
    expect(transferPosts).toBe(0);
  });
});
