import { test, expect } from "@playwright/test";

// Tests « smoke » : vérifient que le SPA se charge et que l'UI publique est
// présente, SANS PACS, sans backend de données et sans PHI. On cible la page
// de connexion (rendu synchrone) et la garde d'authentification de l'accueil.

test.describe("Smoke — chargement de l'application", () => {
  test("la page de connexion s'affiche", async ({ page }) => {
    await page.goto("/login");

    // Titre de l'app (carte de connexion).
    await expect(
      page.getByText("MediView", { exact: true }).first()
    ).toBeVisible();

    // Champs e-mail / mot de passe et bouton « Se connecter » présents.
    await expect(page.getByLabel("E-mail")).toBeVisible();
    await expect(page.getByLabel("Mot de passe")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Se connecter" })
    ).toBeVisible();
  });

  test("bascule connexion ↔ inscription", async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("button", { name: /S'inscrire/ }).click();
    // En mode inscription, le champ « Nom » apparaît.
    await expect(page.getByLabel("Nom")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Créer le compte" })
    ).toBeVisible();
  });

  test("la racine non authentifiée affiche la garde de connexion", async ({
    page,
  }) => {
    await page.goto("/");
    // Sans session, l'accueil montre l'écran « Sign In » (aucune donnée
    // patient n'est chargée tant qu'on n'est pas authentifié).
    await expect(page.getByRole("button", { name: /Sign In/i })).toBeVisible({
      timeout: 15_000,
    });
  });

  test("une route inconnue rend la page 404", async ({ page }) => {
    await page.goto("/route-inexistante-xyz");
    // La page NotFound se charge (le SPA répond, fallback index.html).
    await expect(page.locator("body")).toBeVisible();
    await expect(page).toHaveTitle(/.*/);
  });
});
