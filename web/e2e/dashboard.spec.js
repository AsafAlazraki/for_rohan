import { test, expect } from '@playwright/test';

test.describe('Dashboard Live Metrics', () => {
  test.beforeEach(async ({ page }) => {
    // Mock the backend API responses to provide consistent data
    await page.route('**/api/events/stats', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          totalEvents: 10500,
          percentChange: 12.5,
          recentErrors: 15,
          syncStatus: 'Healthy',
          webhookSuccessRate: 99.5,
          graphData: [
            { time: '2026-04-23T00:00:00Z', hourLabel: '00:00', count: 100 },
            { time: '2026-04-23T01:00:00Z', hourLabel: '01:00', count: 150 },
          ]
        })
      });
    });

    await page.route('**/api/webhooks/sinks', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          sinks: [
            { id: 1, enabled: true },
            { id: 2, enabled: true },
            { id: 3, enabled: false }
          ]
        })
      });
    });

    // We assume the Dashboard is the default page or available at /
    await page.goto('/');
  });

  test('displays all live metrics correctly', async ({ page }) => {
    // Check Total Records Synced
    const totalStat = page.locator('.stat-card', { hasText: 'Total Records Synced' });
    await expect(totalStat.locator('.stat-value')).toHaveText('10,500');
    await expect(totalStat.locator('.stat-sub')).toContainText('+12.5% last 24h');

    // Check Active Webhooks
    const webhooksStat = page.locator('.stat-card', { hasText: 'Active Webhooks' });
    await expect(webhooksStat.locator('.stat-value')).toHaveText('2');
    await expect(webhooksStat.locator('.stat-sub')).toContainText('99.5% success rate');

    // Check Recent Errors
    const errorsStat = page.locator('.stat-card', { hasText: 'Recent Errors' });
    await expect(errorsStat.locator('.stat-value')).toHaveText('15');
    await expect(errorsStat.locator('.stat-sub')).toContainText('Failed last 24h');

    // Check Sync Status
    const statusStat = page.locator('.stat-card', { hasText: 'Sync Status' });
    await expect(statusStat.locator('.stat-value')).toHaveText('Healthy');
  });

  test('displays info popover tooltips for metrics and graph', async ({ page }) => {
    // Wait for the UI to finish loading
    await expect(page.locator('.stat-card')).toHaveCount(4);

    const infoTriggers = page.locator('.info-trigger');
    await expect(infoTriggers).toHaveCount(5); // 4 for cards, 1 for graph

    // Hover the Total Records info trigger and verify the popover appears
    const totalCard = page.locator('.stat-card', { hasText: 'Total Records Synced' });
    await totalCard.locator('.info-trigger').hover();
    const popover = totalCard.locator('.info-popover');
    await expect(popover).toBeVisible();
    await expect(popover.locator('p')).toContainText('Total number of sync events processed');
  });

  test('renders the 24-hour activity graph', async ({ page }) => {
    // Wait for Recharts to render
    const chartContainer = page.locator('.recharts-responsive-container');
    await expect(chartContainer).toBeVisible();

    // Verify SVG is rendered inside
    const svgSurface = page.locator('.recharts-surface');
    await expect(svgSurface).toBeVisible();
  });
});
