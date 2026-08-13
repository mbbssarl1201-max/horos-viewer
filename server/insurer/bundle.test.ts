import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "crypto";

// On teste la logique des jetons (hachage, expiration, révocation, journal des
// téléchargements) sans dépendre d'une vraie base : `getDb` est mocké vers un
// faux drizzle chaînable (pattern repris de server/reports.lifecycle.test.ts et
// server/insurer/matchPatient.test.ts). Le flux MinIO (construireColis :
// lecture des instances DICOM + ZIP) N'EST PAS testé ici — couvert par le
// smoke test manuel post-déploiement (cf. brief).

let fauxTokens: {
  id: number;
  requestId: number;
  tokenHash: string;
  bundleKey: string;
  expireLe: Date;
  telechargements: { ts: string; ip: string }[] | null;
  revoqueLe: Date | null;
}[] = [];
let prochainId = 1;

function makeFakeDb() {
  return {
    insert: (_table: any) => ({
      values: (v: any) => {
        fauxTokens.push({
          id: prochainId++,
          requestId: v.requestId,
          tokenHash: v.tokenHash,
          bundleKey: v.bundleKey,
          expireLe: v.expireLe,
          telechargements: v.telechargements ?? null,
          revoqueLe: v.revoqueLe ?? null,
        });
        return Promise.resolve(undefined);
      },
    }),
    select: () => ({
      from: (_table: any) => ({
        where: (_c: any) => ({
          limit: (_n: any) => {
            // Le mock drizzle-orm (`eq`) capture la valeur comparée ; on filtre
            // réellement dessus (pas un mock qui ignore la condition).
            const hash = dernierEq?.value;
            return Promise.resolve(
              fauxTokens.filter(t => t.tokenHash === hash)
            );
          },
        }),
      }),
    }),
    update: (_table: any) => ({
      set: (v: any) => ({
        where: (_c: any) => {
          const id = dernierEq?.value;
          const row = fauxTokens.find(t => t.id === id);
          if (row) Object.assign(row, v);
          return Promise.resolve(undefined);
        },
      }),
    }),
  };
}

let dernierEq: { value: unknown } | null = null;

vi.mock("../db", async orig => {
  const actual = await orig<any>();
  return {
    ...actual,
    getDb: () => Promise.resolve(makeFakeDb()),
  };
});

vi.mock("drizzle-orm", async orig => {
  const actual = await orig<any>();
  return {
    ...actual,
    eq: (_column: any, value: unknown) => {
      dernierEq = { value };
      return { __mock: "eq" };
    },
  };
});

import { creerJeton, racheterJeton } from "./bundle";

beforeEach(() => {
  fauxTokens = [];
  prochainId = 1;
  dernierEq = null;
});

describe("creerJeton", () => {
  it("stocke un hash SHA-256, jamais le jeton en clair", async () => {
    const { tokenClair } = await creerJeton(1, "insurer/1/bundle.zip");
    expect(tokenClair).toMatch(/^[0-9a-f]{64}$/); // 32 octets hex
    expect(fauxTokens).toHaveLength(1);
    const row = fauxTokens[0];
    expect(row.tokenHash).not.toBe(tokenClair);
    expect(row.tokenHash).toBe(
      createHash("sha256").update(tokenClair).digest("hex")
    );
    expect(row.bundleKey).toBe("insurer/1/bundle.zip");
  });

  it("expiration à 14 jours", async () => {
    const avant = Date.now();
    await creerJeton(1, "insurer/1/bundle.zip");
    const apres = Date.now();
    const row = fauxTokens[0];
    const quatorzeJoursMs = 14 * 24 * 60 * 60 * 1000;
    expect(row.expireLe.getTime()).toBeGreaterThanOrEqual(
      avant + quatorzeJoursMs - 1000
    );
    expect(row.expireLe.getTime()).toBeLessThanOrEqual(
      apres + quatorzeJoursMs + 1000
    );
  });
});

describe("racheterJeton", () => {
  it("token inconnu → { ok: false }", async () => {
    const r = await racheterJeton("inconnu", "1.2.3.4");
    expect(r).toEqual({ ok: false });
  });

  it("token valide → ok, note le téléchargement (ts+ip)", async () => {
    const { tokenClair } = await creerJeton(1, "insurer/1/bundle.zip");
    const r = await racheterJeton(tokenClair, "1.2.3.4");
    expect(r).toMatchObject({ ok: true, bundleKey: "insurer/1/bundle.zip" });
    const row = fauxTokens[0];
    expect(row.telechargements).toHaveLength(1);
    expect(row.telechargements![0].ip).toBe("1.2.3.4");
    expect(typeof row.telechargements![0].ts).toBe("string");
  });

  it("plusieurs téléchargements s'accumulent dans le journal", async () => {
    const { tokenClair } = await creerJeton(1, "insurer/1/bundle.zip");
    await racheterJeton(tokenClair, "1.1.1.1");
    await racheterJeton(tokenClair, "2.2.2.2");
    const row = fauxTokens[0];
    expect(row.telechargements).toHaveLength(2);
    expect(row.telechargements!.map(t => t.ip)).toEqual(["1.1.1.1", "2.2.2.2"]);
  });

  it("token expiré → { ok: false }", async () => {
    const { tokenClair } = await creerJeton(1, "insurer/1/bundle.zip");
    fauxTokens[0].expireLe = new Date(Date.now() - 1000);
    const r = await racheterJeton(tokenClair, "1.2.3.4");
    expect(r).toEqual({ ok: false });
  });

  it("token révoqué → { ok: false }", async () => {
    const { tokenClair } = await creerJeton(1, "insurer/1/bundle.zip");
    fauxTokens[0].revoqueLe = new Date();
    const r = await racheterJeton(tokenClair, "1.2.3.4");
    expect(r).toEqual({ ok: false });
  });

  // Audit I2 : le multi-téléchargement pendant la fenêtre de validité est
  // intentionnel (décision du gérant), mais borné à 10 rédemptions.
  it("10 téléchargements réussissent, le 11e est refusé (plafond)", async () => {
    const { tokenClair } = await creerJeton(1, "insurer/1/bundle.zip");
    for (let i = 0; i < 10; i++) {
      const r = await racheterJeton(tokenClair, `1.2.3.${i}`);
      expect(r).toMatchObject({ ok: true });
    }
    const row = fauxTokens[0];
    expect(row.telechargements).toHaveLength(10);

    const onzieme = await racheterJeton(tokenClair, "1.2.3.11");
    expect(onzieme).toEqual({ ok: false });
    expect(row.telechargements).toHaveLength(10); // pas de 11e entrée journalisée
  });
});
