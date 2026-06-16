import { defineConfig, devices } from "@playwright/test";

// Configuration Playwright pour les tests E2E « smoke » (e2e/).
// Ces tests NE dépendent PAS d'un PACS réel ni de PHI : ils vérifient que le
// SPA se charge (page de connexion, garde d'authentification) en servant le
// build statique du client via `vite preview` — aucun secret, aucun réseau
// PACS, aucune base de données requise.
//
// Lancement : `npx playwright test` (NB : les navigateurs doivent être
// installés une fois avec `npx playwright install chromium`).
// Les specs vivent sous e2e/ et ne sont PAS ramassées par Vitest (dont
// l'include se limite à server/** et client/src/lib/**).

const PORT = Number(process.env.E2E_PORT ?? 4173);
const BASE_URL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  // Fail-safe : pas de .only oublié, retries en CI, exécution séquentielle
  // suffisante pour des smoke tests.
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  // Sert le build statique du client. Si un serveur tourne déjà sur le port
  // (dev), on le réutilise. `vite build` doit avoir été lancé au préalable
  // (le smoke teste l'app telle qu'elle est livrée).
  webServer: {
    command: `npx vite preview --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: BASE_URL,
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
  },
});
