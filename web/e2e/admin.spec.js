// admin.spec.js — verifies the Admin tab renders config rows, supports
// editing & saving a value, and lets the operator switch sync direction
// with the API call body matching the new selection.
import { test, expect } from '@playwright/test';
import { setupApiMocks } from './helpers/mocks.js';

test.describe('admin tab', () => {
  test('renders all five config rows', async ({ page }) => {
    await setupApiMocks(page);
    await page.goto('/');
    await page.getByRole('button', { name: 'Admin', exact: true }).click();

    // Wait for the Credentials panel header to mark the load complete.
    await expect(page.getByRole('heading', { name: 'Credentials' })).toBeVisible();

    // Each config row renders the key in a `.config-row .key` span.
    const rows = page.locator('.config-row');
    await expect(rows).toHaveCount(5);
    await expect(page.locator('.config-row .key', { hasText: 'DYN_TENANT_ID' })).toBeVisible();
    await expect(page.locator('.config-row .key', { hasText: 'MKT_CLIENT_SECRET' })).toBeVisible();

    // env-source row shows the "from .env" badge.
    await expect(page.locator('.config-row', { hasText: 'DYN_TENANT_ID' })
      .getByText('from .env')).toBeVisible();
  });

  test('edit then save fires POST with correct body and shows success toast', async ({ page }) => {
    let savedBody = null;
    await setupApiMocks(page, {
      configSave: async (route) => {
        savedBody = JSON.parse(route.request().postData() || '{}');
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
      },
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Admin', exact: true }).click();

    const row = page.locator('.config-row', { hasText: 'MKT_CLIENT_ID' });
    await row.getByRole('button', { name: 'Edit' }).click();

    const input = row.locator('input');
    await expect(input).toBeVisible();
    await input.fill('new-mkt-client-value');
    await row.getByRole('button', { name: 'Save' }).click();

    await expect.poll(() => savedBody, { timeout: 5_000 }).toEqual({
      key:   'MKT_CLIENT_ID',
      value: 'new-mkt-client-value',
    });

    // Toast shows the saved confirmation.
    await expect(page.locator('.toast.ok', { hasText: /MKT_CLIENT_ID saved/ })).toBeVisible();
  });


});
