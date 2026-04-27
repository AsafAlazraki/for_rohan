// sync-view-account-list.spec.js — covers the Account-list mode end to end:
// per-record vs named-list sub-toggle, dry-run preview, real-mode confirm,
// and the success-result panel after the live POST.
import { test, expect } from '@playwright/test';
import { setupApiMocks, makeAccounts } from './helpers/mocks.js';

test.describe('sync view — account list mode', () => {
  test('preview (dry-run) then push as named list (real)', async ({ page }) => {
    const accounts = makeAccounts(2);
    let dryRunPosts = 0;
    let listSyncPosts = 0;
    let dryRunBody = null;
    let listSyncBody = null;

    await setupApiMocks(page, {
      simulatePull: async (route) => {
        const u = new URL(route.request().url());
        const side   = u.searchParams.get('side');
        const entity = u.searchParams.get('entity');
        if (side === 'dynamics' && entity === 'account') {
          return route.fulfill({
            status: 200, contentType: 'application/json',
            body: JSON.stringify({ dynamics: { rows: accounts, nextCursor: null } }),
          });
        }
        return route.fulfill({
          status: 200, contentType: 'application/json',
          body: JSON.stringify({ [side]: { rows: [], nextCursor: null } }),
        });
      },
      accountListDryRun: async (route) => {
        dryRunPosts += 1;
        dryRunBody = JSON.parse(route.request().postData() || '{}');
        return route.fulfill({
          status: 200, contentType: 'application/json',
          body: JSON.stringify({
            dryRun: true,
            listName: dryRunBody.listName,
            members: accounts.map(a => ({ name: a.name })),
            droppedNoName: 0,
            note: null,
          }),
        });
      },
      accountListSync: async (route) => {
        listSyncPosts += 1;
        listSyncBody = JSON.parse(route.request().postData() || '{}');
        return route.fulfill({
          status: 200, contentType: 'application/json',
          body: JSON.stringify({
            listName: listSyncBody.listName,
            listId:   '99001',
            upserted: accounts.map(a => ({ name: a.name, namedAccountId: 'n-' + a.accountid, status: 'created' })),
            addedToList: accounts.map(a => ({ id: 'n-' + a.accountid, status: 'added' })),
          }),
        });
      },
    });

    await page.goto('/');
    await page.getByRole('button', { name: 'Sync View', exact: true }).click();

    // Switch entity to Account.
    await page.locator('select').first().selectOption('account');

    // Account-mode sub-toggle should appear.
    await expect(page.getByRole('tab', { name: /Per-record sync/ })).toBeVisible();
    const namedListTab = page.getByRole('tab', { name: /Push as Named List/ });
    await expect(namedListTab).toBeVisible();
    await namedListTab.click();
    await expect(namedListTab).toHaveAttribute('aria-selected', 'true');

    // Action button text reflects the new mode.
    await expect(page.getByRole('button', { name: /Preview Named List/ })).toBeVisible();

    // Pull both accounts.
    await page.getByRole('button', { name: /Pull Dynamics/ }).click();
    const dynColumn = page.locator('.sv-col').filter({ hasText: 'Dynamics CRM' });
    await expect(dynColumn.locator('.sv-card')).toHaveCount(2);
    await dynColumn.locator('.sv-card').nth(0).locator('input[type=checkbox]').check();
    await dynColumn.locator('.sv-card').nth(1).locator('input[type=checkbox]').check();

    // Click "Preview Named List →" — modal opens with a default name pre-filled.
    await page.getByRole('button', { name: /Preview Named List/ }).click();
    const modal = page.locator('.sv-modal');
    await expect(modal).toBeVisible();
    const nameInput = modal.locator('input[type=text]');
    await expect(nameInput).toHaveValue(/D365 Account Sync — \d{4}-\d{2}-\d{2}/);

    await modal.getByRole('button', { name: 'Preview' }).click();

    // Dry-run POST happens; result panel appears with member rows.
    await expect.poll(() => dryRunPosts).toBe(1);
    expect(dryRunBody.accounts).toHaveLength(2);
    await expect(page.getByRole('heading', { name: /Named Account List \(preview\)/ })).toBeVisible();
    await expect(page.locator('.sv-log li')).toHaveCount(2);

    // Now toggle to Real mode (with confirm) and run the live push. Click
    // the wrapping <label> since the underlying checkbox is collapsed to 0×0.
    await page.locator('label.sv-switch').click();
    await page.getByRole('button', { name: 'Yes, enable Real mode' }).click();

    await expect(page.getByRole('button', { name: /Push as Named List → \(REAL WRITE\)/ })).toBeVisible();
    await page.getByRole('button', { name: /Push as Named List → \(REAL WRITE\)/ }).click();

    const modal2 = page.locator('.sv-modal');
    await expect(modal2).toBeVisible();
    await modal2.getByRole('button', { name: /Create list & add/ }).click();

    await expect.poll(() => listSyncPosts).toBe(1);
    expect(listSyncBody.accounts).toHaveLength(2);
    await expect(page.locator('.toast.ok', { hasText: /List "[^"]+" created \(id 99001\)/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: /Named Account List result/ })).toBeVisible();
    // The list-id appears in the result panel summary span.
    await expect(page.locator('.sv-list-v', { hasText: '99001' })).toBeVisible();
  });
});
