// sync-view-real-toggle.spec.js — exercises the Sim ↔ Real toggle, both
// confirmation modals, and the real-mode transfer enqueue path.
import { test, expect } from '@playwright/test';
import { setupApiMocks, makeContacts } from './helpers/mocks.js';

test.describe('sync view — real-mode toggle', () => {
  test('cancel keeps Sim, confirm flips to Real, then real transfer enqueues', async ({ page }) => {
    const contacts = makeContacts(3);
    let transferPosts = 0;
    let lastTransferBody = null;
    await setupApiMocks(page, {
      simulatePull: async (route) => {
        const u = new URL(route.request().url());
        const side = u.searchParams.get('side');
        if (side === 'dynamics') {
          return route.fulfill({
            status: 200, contentType: 'application/json',
            body: JSON.stringify({ dynamics: { rows: contacts, nextCursor: null } }),
          });
        }
        return route.fulfill({
          status: 200, contentType: 'application/json',
          body: JSON.stringify({ [side]: { rows: [], nextCursor: null } }),
        });
      },
      simulateTransfer: async (route) => {
        transferPosts += 1;
        lastTransferBody = JSON.parse(route.request().postData() || '{}');
        return route.fulfill({
          status: 200, contentType: 'application/json',
          body: JSON.stringify({
            enqueued: { dynamics: 2, marketo: 0 },
            jobs: [
              { jobId: 'job-1', side: 'dynamics', ident: 'alice1@example.com' },
              { jobId: 'job-2', side: 'dynamics', ident: 'alice2@example.com' },
            ],
            errors: [],
          }),
        });
      },
    });

    await page.goto('/');
    await page.getByRole('button', { name: 'Sync View', exact: true }).click();

    // Toggle the Sim/Real switch — confirmation modal should appear.
    // The checkbox is visually collapsed (width/height:0), so click the
    // wrapping <label> (.sv-switch) which natively toggles the input.
    const modeSwitch = page.locator('.sv-switch input[type=checkbox]');
    const switchLabel = page.locator('label.sv-switch');
    await switchLabel.click();
    await expect(page.getByRole('heading', { name: 'Switch to Real World mode?' })).toBeVisible();

    // Cancel → modal closes, switch stays at Sim.
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('heading', { name: 'Switch to Real World mode?' })).toBeHidden();
    await expect(modeSwitch).not.toBeChecked();

    // Toggle again → confirm enabling Real mode.
    await switchLabel.click();
    await page.getByRole('button', { name: 'Yes, enable Real mode' }).click();
    await expect(modeSwitch).toBeChecked();
    // Active label flips to "Real World".
    await expect(page.locator('.sv-mode-lbl.real.active')).toBeVisible();

    // Pull Dynamics, select two records.
    await page.getByRole('button', { name: /Pull Dynamics/ }).click();
    const dynColumn = page.locator('.sv-col').filter({ hasText: 'Dynamics CRM' });
    await expect(dynColumn.locator('.sv-card')).toHaveCount(3);
    await dynColumn.locator('.sv-card').nth(0).locator('input[type=checkbox]').check();
    await dynColumn.locator('.sv-card').nth(1).locator('input[type=checkbox]').check();

    // Click Transfer (REAL WRITE).
    await page.getByRole('button', { name: /Transfer .* \(REAL WRITE\)/ }).click();

    // Second confirmation modal appears.
    await expect(page.getByRole('heading', { name: 'Perform a REAL transfer?' })).toBeVisible();
    await page.getByRole('button', { name: 'Yes, transfer for real' }).click();

    // POST is made; toast appears with enqueued count.
    await expect.poll(() => transferPosts).toBe(1);
    expect(lastTransferBody.direction).toBe('d2m');
    expect(lastTransferBody.entity).toBe('contact');
    expect(lastTransferBody.records.dynamics).toHaveLength(2);
    await expect(page.locator('.toast.ok', { hasText: /Enqueued 2 record/ })).toBeVisible();
  });
});
