// engagement.spec.js — verifies the Engagement tab renders stats + recent
// feed, the type filter narrows the visible rows (server-side refetch),
// the Run-preview (SIM) button calls /api/engagement/dry-run, and the
// SIM→REAL toggle gates the live /api/engagement/trigger call.
import { test, expect } from '@playwright/test';
import { setupApiMocks, makeEngagementRow } from './helpers/mocks.js';

test.describe('engagement tab', () => {
  test('stats panel + recent feed render with status chips', async ({ page }) => {
    const rows = [
      makeEngagementRow({ id: 1, type: 10, typeName: 'Email Open',     status: 'written' }),
      makeEngagementRow({ id: 2, type: 11, typeName: 'Email Click',    status: 'written' }),
      makeEngagementRow({ id: 3, type: 2,  typeName: 'Form Submit',    status: 'skipped' }),
      makeEngagementRow({ id: 4, type: 12, typeName: 'Web Visit',      status: 'unmatched' }),
      makeEngagementRow({ id: 5, type: 1,  typeName: 'Email Delivered',status: 'written' }),
    ];
    await setupApiMocks(page, {
      engagementRecent: { rows },
      engagementStats:  {
        totalIngested: 1234,
        byType:   { 'Email Open': 600, 'Email Click': 320, 'Form Submit': 100 },
        byStatus: { written: 1100, skipped: 100, unmatched: 34 },
        lastRun:  { at: new Date(Date.now() - 30_000).toISOString(), fetched: 50, filtered: 5, written: 40, durationMs: 1234 },
      },
    });

    await page.goto('/');
    await page.getByRole('button', { name: 'Engagement', exact: true }).click();

    // Stats: 3 cards (Total ingested, Last run, By type).
    await expect(page.locator('.eng-stat-card')).toHaveCount(3);
    await expect(page.getByText('1,234')).toBeVisible();
    await expect(page.getByText(/40.* written/)).toBeVisible();

    // Feed: 5 rows.
    await expect(page.locator('.eng-feed li')).toHaveCount(5);

    // Status chips render with their classed variants.
    await expect(page.locator('.eng-status-chip-written').first()).toBeVisible();
    await expect(page.locator('.eng-status-chip-skipped').first()).toBeVisible();
    await expect(page.locator('.eng-status-chip-unmatched').first()).toBeVisible();
  });

  test('type filter narrows the visible rows', async ({ page }) => {
    const allRows = [
      makeEngagementRow({ id: 1, type: 10, typeName: 'Email Open' }),
      makeEngagementRow({ id: 2, type: 11, typeName: 'Email Click' }),
      makeEngagementRow({ id: 3, type: 10, typeName: 'Email Open' }),
    ];
    const opensOnly = allRows.filter(r => r.type === 10);

    await setupApiMocks(page, {
      engagementRecent: async (route) => {
        const u = new URL(route.request().url());
        const t = u.searchParams.get('type');
        const subset = t === '10' ? opensOnly : allRows;
        return route.fulfill({
          status: 200, contentType: 'application/json',
          body: JSON.stringify({ rows: subset }),
        });
      },
    });

    await page.goto('/');
    await page.getByRole('button', { name: 'Engagement', exact: true }).click();

    await expect(page.locator('.eng-feed li')).toHaveCount(3);

    // The type select is the only <select> rendered on this tab.
    await page.locator('select').selectOption('10');
    await expect(page.locator('.eng-feed li')).toHaveCount(2);
  });

  test('SIM Run preview hits /api/engagement/dry-run and shows preview rows', async ({ page }) => {
    let dryRunCalls = 0;
    await setupApiMocks(page, {
      engagementRecent: { rows: [] },
      engagementDryRun: async (route) => {
        dryRunCalls += 1;
        return route.fulfill({
          status: 200, contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            summary: {
              fetched: 4, written: 0, skipped: 1, unmatched: 0, durationMs: 250,
              samples: [
                { marketoActivityId: 'p1', type: 10, typeName: 'Email Open',  contactEmail: 'a@x.com', assetName: 'Promo', occurredAt: new Date().toISOString() },
                { marketoActivityId: 'p2', type: 11, typeName: 'Email Click', contactEmail: 'b@x.com', assetName: 'Promo', occurredAt: new Date().toISOString() },
              ],
            },
          }),
        });
      },
    });

    await page.goto('/');
    await page.getByRole('button', { name: 'Engagement', exact: true }).click();

    // SIM is the default; the button label reflects that.
    const previewBtn = page.getByRole('button', { name: 'Run preview (no writes)' });
    await expect(previewBtn).toBeVisible();
    await previewBtn.click();

    await expect.poll(() => dryRunCalls).toBe(1);
    // Two preview rows render above the (empty) feed.
    await expect(page.locator('.eng-feed li')).toHaveCount(2);
    await expect(page.locator('.toast.ok', { hasText: /Preview complete: 2 would be written/ })).toBeVisible();
  });

  test('REAL toggle gates Run now → /api/engagement/trigger', async ({ page }) => {
    let triggers = 0;
    await setupApiMocks(page, {
      engagementRecent: { rows: [makeEngagementRow({ id: 1 })] },
      engagementTrigger: async (route) => {
        triggers += 1;
        return route.fulfill({
          status: 200, contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            summary: { fetched: 10, written: 6, skipped: 3, unmatched: 1, durationMs: 1234 },
          }),
        });
      },
    });

    await page.goto('/');
    await page.getByRole('button', { name: 'Engagement', exact: true }).click();

    // Flip SIM → REAL (confirmation modal). The checkbox is visually
    // collapsed; click the <label> wrapping it instead.
    await page.locator('label.sv-switch').click();
    await page.getByRole('button', { name: 'Yes, enable Real mode' }).click();

    // Now the run button label flips to "Run now" and a click fires the real endpoint.
    const runBtn = page.getByRole('button', { name: 'Run now' });
    await expect(runBtn).toBeVisible();
    await runBtn.click();

    await expect.poll(() => triggers).toBe(1);
    await expect(page.locator('.toast.ok', { hasText: /6 written.*3 skipped.*1 unmatched/ })).toBeVisible();
  });
});
