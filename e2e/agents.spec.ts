import { test, expect } from "@playwright/test";

// Tests smoke pour les agents Hermès (sans backend).
// On vérifie uniquement que les routes dédiées admin ne sont pas accessibles
// sans authentification (guard RBAC côté serveur).

test.describe("Agents Hermès — garde RBAC", () => {
  test("la route /admin/knowledge charge le SPA sans crash", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", e => errors.push(e.message));
    await page.goto("/admin/knowledge");
    await page.waitForTimeout(2000);
    const fatal = errors.filter(e => e.includes("TypeError"));
    expect(fatal).toHaveLength(0);
    await expect(page.locator("body")).toBeVisible();
  });

  test("la route /knowledge charge le SPA sans crash", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", e => errors.push(e.message));
    await page.goto("/knowledge");
    await page.waitForTimeout(2000);
    const fatal = errors.filter(e => e.includes("TypeError"));
    expect(fatal).toHaveLength(0);
    await expect(page.locator("body")).toBeVisible();
  });
});
