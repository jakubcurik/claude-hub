// SPDX-License-Identifier: Apache-2.0
import { expect, test } from '@playwright/test';

test('first-run setup, then register, then login, then /api/auth/me', async ({ page, request }) => {
  // Setup wizard
  await page.goto('/setup');
  await page.fill('input[name="name"]', 'Root');
  await page.fill('input[name="email"]', 'root@example.com');
  await page.fill('input[name="password"]', 'rootpassword12');
  await page.click('button[type="submit"]');
  await expect(page).toHaveURL(/\/login/);

  // Register a member
  await page.goto('/register');
  await page.fill('input[name="name"]', 'Member');
  await page.fill('input[name="email"]', 'member@example.com');
  await page.fill('input[name="password"]', 'memberpassword12');
  await page.click('button[type="submit"]');
  await expect(page).toHaveURL(/\/login/);

  // Login
  await page.goto('/login');
  await page.fill('input[name="email"]', 'member@example.com');
  await page.fill('input[name="password"]', 'memberpassword12');
  await page.click('button[type="submit"]');
  await expect(page).toHaveURL('/');

  // /api/auth/me reachable with cookie
  const cookies = await page.context().cookies();
  const session = cookies.find((c) => c.name === 'hub_session');
  expect(session).toBeDefined();
  const meRes = await request.get('http://localhost:3000/api/auth/me', {
    headers: { cookie: `hub_session=${session!.value}` },
  });
  expect(meRes.status()).toBe(200);
  expect((await meRes.json()).email).toBe('member@example.com');
});
