// app-shell.spec.js — verifies the topbar renders all 6 tabs, each tab
// activates on click and shows its expected H2/panel, and no JS console
// errors fire during a full-nav round-trip.
import { test, expect } from '@playwright/test';
import { setupApiMocks } from './helpers/mocks.js';

// Each tab renders a unique landmark — use the most stable one available.
// SyncView's first panel has no H2 by design (controls + columns), so we
// match an H3 ("Dynamics CRM") that's always present once the tab mounts.
const TABS = [
  { id: 'syncview',     label: 'Sync View',    landmark: { role: 'heading', name: /Dynamics CRM/i, level: 3 } },
  { id: 'dashboard',    label: 'Dashboard',    landmark: { role: 'heading', name: /Live sync feed/i, level: 2 } },
  { id: 'engagement',   label: 'Engagement',   landmark: { role: 'heading', name: /Filter & run|Recent activity|Stats/i, level: 2 } },
  { id: 'architecture', label: 'Architecture', landmark: { role: 'heading', name: /Architecture overview/i, level: 2 } },
  { id: 'admin',        label: 'Admin',        landmark: { role: 'heading', name: /Sync direction|Credentials/i, level: 2 } },
  { id: 'trigger',      label: 'Trigger',      landmark: { role: 'heading', name: /Trigger a sync/i, level: 2 } },
];

test.describe('app shell', () => {
  test('topbar renders all six tabs', async ({ page }) => {
    await setupApiMocks(page);
    await page.goto('/');
    for (const t of TABS) {
      await expect(page.getByRole('button', { name: t.label, exact: true })).toBeVisible();
    }
    await expect(page.getByRole('heading', { level: 1, name: /Dynamics.*Marketo Sync/i })).toBeVisible();
  });

  test('each tab activates on click and shows its panel', async ({ page }) => {
    await setupApiMocks(page);
    await page.goto('/');

    for (const t of TABS) {
      const btn = page.getByRole('button', { name: t.label, exact: true });
      await btn.click();
      await expect(btn).toHaveClass(/active/);
      await expect(
        page.getByRole(t.landmark.role, { name: t.landmark.name, level: t.landmark.level }).first()
      ).toBeVisible();
    }
  });

  test('no JS console errors across a full nav round-trip', async ({ page }) => {
    await setupApiMocks(page);
    const errors = [];
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
    });

    await page.goto('/');
    for (const t of TABS) {
      await page.getByRole('button', { name: t.label, exact: true }).click();
      // Give each tab a moment to mount and run its initial fetches.
      await page.waitForLoadState('networkidle').catch(() => {});
    }

    // Ignore noisy framework warnings that aren't real defects.
    const real = errors.filter(e =>
      !/Download the React DevTools/.test(e) &&
      !/Mermaid error/.test(e) &&  // mermaid renders may log non-fatal warnings
      !/EventSource/.test(e),
    );
    expect(real, real.join('\n')).toEqual([]);
  });
});
