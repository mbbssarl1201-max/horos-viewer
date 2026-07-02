# Hermès Enrichissement — 8 nouveaux outils Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ajouter 8 outils à Hermès Copilote (vault RAG, météo/timezone/calendrier, PubMed/guidelines, interaction agent CR) tous protégés par le tool-gate existant.

**Architecture:** Chaque outil est une fonction TypeScript dans `server/tools/`, exposée via une route tRPC dans `hermes` router, et enregistrée dans `AgentSpec.tools` du copilote dans `registry.ts`. `searchSimilar` dans `store.ts` est étendu d'un paramètre `sourcePrefix` pour filtrer les chunks par type de source. Aucune migration DB requise.

**Tech Stack:** TypeScript, tRPC v11, Drizzle/MySQL, Vitest, Ollama local (embeddings), Open-Meteo API (gratuit), NCBI E-utilities (gratuit), `googleapis` npm package.

## Global Constraints

- Branche : `self-host` (ne pas push sur main/master)
- PHI : ne jamais écrire de données patient dans un chunk knowledge, ni retourner AVS/nom patient depuis les outils CR
- Secrets : dans `.env` uniquement (gitignoré). `GOOGLE_SA_KEY_JSON` = JSON stringifié du service account
- Tests : Vitest (`pnpm test`), `pnpm check` pour tsc. Run : `pnpm -C /Users/mbbssarl/Documents/GitHub/horos-viewer test`
- `reports.status` enum MySQL = `["draft", "signed"]` uniquement — pas de "pending_signature"
- `searchSimilar` ancienne signature : `(embedding: number[], k?: number)`. Nouvelle : `(embedding: number[], k?: number, opts?: { sourcePrefix?: string })` — rétrocompatible
- Package manager : pnpm
- `googleapis` n'est pas installé — à ajouter via `pnpm add googleapis`

---

## File Structure

| Fichier                                   | Action   | Rôle                                                                                   |
| ----------------------------------------- | -------- | -------------------------------------------------------------------------------------- |
| `server/knowledge/store.ts`               | Modifier | Ajouter `sourcePrefix` à `searchSimilar`                                               |
| `server/tools/vaultTools.ts`              | Créer    | `searchVaultFn(query)`                                                                 |
| `server/tools/contextTools.ts`            | Créer    | `getWeatherFn()`, `getLocalTimeFn()`, `calendarTodayFn(date?)`                         |
| `server/tools/researchTools.ts`           | Créer    | `pubmedSearchFn(query, max?)`, `searchGuidelinesFn(query)`                             |
| `server/tools/crTools.ts`                 | Créer    | `listPendingSignaturesFn()`, `getCRDraftFn(studyId)`, `requestCRGenerationFn(studyId)` |
| `server/knowledge/guidelinesSync.ts`      | Créer    | `syncGuidelines()` — fetch ESR/ACR RSS → chunk → embed → store                         |
| `server/agents/registry.ts`               | Modifier | Ajouter 8 outils à copilote.tools                                                      |
| `server/_core/env.ts`                     | Modifier | Ajouter 5 vars d'environnement                                                         |
| `.env.example`                            | Modifier | Documenter les nouvelles vars                                                          |
| `server/routers.ts`                       | Modifier | Ajouter 8 routes dans hermes + 2 dans knowledge                                        |
| `server/knowledge/store.test.ts`          | Créer    | Unit tests searchSimilar + sourcePrefix                                                |
| `server/tools/vaultTools.test.ts`         | Créer    | Unit tests searchVaultFn                                                               |
| `server/tools/contextTools.test.ts`       | Créer    | Unit tests weather/time/calendar                                                       |
| `server/tools/researchTools.test.ts`      | Créer    | Unit tests pubmedSearch/searchGuidelines                                               |
| `server/tools/crTools.test.ts`            | Créer    | Unit tests CR tools                                                                    |
| `server/knowledge/guidelinesSync.test.ts` | Créer    | Unit tests guidelinesSync                                                              |

---

## Task 1: Étendre `searchSimilar` avec filtre `sourcePrefix`

**Files:**

- Modify: `server/knowledge/store.ts`
- Create: `server/knowledge/store.test.ts`

**Interfaces:**

- Produces: `searchSimilar(embedding: number[], k?: number, opts?: { sourcePrefix?: string }): Promise<SimilarChunk[]>` — rétrocompatible (appels `searchSimilar(emb, 8)` non cassés)

- [ ] **Step 1: Écrire le test en échec**

```ts
// server/knowledge/store.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db", () => ({
  getDb: vi.fn(),
}));
vi.mock("../../drizzle/schema", () => ({
  knowledgeChunks: {
    source: "source",
    heading: "heading",
    content: "content",
    embedding: "embedding",
  },
}));

import { searchSimilar } from "./store";
import { getDb } from "../db";

const mockChunks = [
  {
    source: "vault:notes.md",
    heading: "H1",
    content: "vault content",
    embedding: JSON.stringify([1, 0]),
  },
  {
    source: "guidelines:esr",
    heading: "G1",
    content: "guidelines content",
    embedding: JSON.stringify([0, 1]),
  },
];

beforeEach(() => {
  vi.mocked(getDb).mockResolvedValue({
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([mockChunks[0]]),
      }),
    }),
  } as any);
});

describe("searchSimilar avec sourcePrefix", () => {
  it("sans sourcePrefix appelle la query sans WHERE", async () => {
    const db = (await getDb()) as any;
    db.select.mockReturnValue({
      from: vi.fn().mockResolvedValue(mockChunks),
    });
    const results = await searchSimilar([1, 0], 5);
    expect(results.length).toBe(2);
  });

  it("avec sourcePrefix filtre par source LIKE 'vault:%'", async () => {
    const db = (await getDb()) as any;
    const whereMock = vi.fn().mockResolvedValue([mockChunks[0]]);
    db.select.mockReturnValue({
      from: vi.fn().mockReturnValue({ where: whereMock }),
    });
    const results = await searchSimilar([1, 0], 5, { sourcePrefix: "vault:" });
    expect(whereMock).toHaveBeenCalled();
    expect(results.length).toBe(1);
    expect(results[0].source).toBe("vault:notes.md");
  });
});
```

- [ ] **Step 2: Vérifier que le test échoue**

```bash
cd /Users/mbbssarl/Documents/GitHub/horos-viewer
pnpm test server/knowledge/store.test.ts
```

Expected: FAIL — `searchSimilar` ne prend pas d'opts

- [ ] **Step 3: Modifier `server/knowledge/store.ts`**

Remplacer la signature et le corps de `searchSimilar` :

```ts
import { like } from "drizzle-orm";
```

Ajouter l'import `like` dans la ligne existante d'imports drizzle-orm (l. 3) :

```ts
import { eq, sql, like } from "drizzle-orm";
```

Remplacer la fonction `searchSimilar` complète (lignes 36-67) :

```ts
/** Charge les chunks (filtrés par sourcePrefix si fourni), calcule le cosinus en JS, renvoie le top-k. */
export async function searchSimilar(
  queryEmbedding: number[],
  k = 5,
  opts?: { sourcePrefix?: string }
): Promise<SimilarChunk[]> {
  const db = await getDb();
  if (!db) return [];
  const baseQuery = db
    .select({
      source: knowledgeChunks.source,
      heading: knowledgeChunks.heading,
      content: knowledgeChunks.content,
      embedding: knowledgeChunks.embedding,
    })
    .from(knowledgeChunks);
  const rows = opts?.sourcePrefix
    ? await baseQuery.where(
        like(knowledgeChunks.source, `${opts.sourcePrefix}%`)
      )
    : await baseQuery;
  const scored: SimilarChunk[] = [];
  for (const r of rows) {
    let emb: number[];
    try {
      emb = JSON.parse(r.embedding);
    } catch {
      continue;
    }
    scored.push({
      source: r.source,
      heading: r.heading,
      content: r.content,
      score: cosineSimilarity(queryEmbedding, emb),
    });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(1, k));
}
```

- [ ] **Step 4: Vérifier que les tests passent**

```bash
pnpm test server/knowledge/store.test.ts
pnpm check
```

Expected: PASS + tsc OK

- [ ] **Step 5: Commit**

```bash
git add server/knowledge/store.ts server/knowledge/store.test.ts
git commit -m "feat: searchSimilar accepts sourcePrefix filter for vault/guidelines isolation"
```

---

## Task 2: Group A — `searchVault` outil + route syncVaultFromDisk

**Files:**

- Create: `server/tools/vaultTools.ts`
- Create: `server/tools/vaultTools.test.ts`
- Modify: `server/agents/registry.ts` (ajouter "searchVault" au copilote)
- Modify: `server/_core/env.ts` (ajouter `vaultSyncToken`)
- Modify: `server/routers.ts` (hermes.searchVault + knowledge.syncVaultFromDisk)

**Interfaces:**

- Consumes: `searchSimilar(emb, k, { sourcePrefix: "vault:" })` de Task 1 ; `embedText()` de embeddings.ts ; `selectRelevant()`, `buildKnowledgeBlock()` de retrieve.ts ; `syncVault()` de vaultSync.ts
- Produces: `searchVaultFn(args: { query: string }): Promise<{ context: string; sources: string[] }>`

- [ ] **Step 1: Écrire le test en échec**

```ts
// server/tools/vaultTools.test.ts
import { describe, it, expect, vi } from "vitest";

vi.mock("../knowledge/embeddings", () => ({
  embedText: vi.fn().mockResolvedValue([0.5, 0.5]),
}));
vi.mock("../knowledge/store", () => ({
  searchSimilar: vi.fn().mockResolvedValue([
    {
      source: "vault:notes.md",
      heading: "Protocole IRM",
      content: "Contenu IRM",
      score: 0.8,
    },
  ]),
}));
vi.mock("../knowledge/retrieve", () => ({
  selectRelevant: vi.fn(chunks => chunks),
  buildKnowledgeBlock: vi
    .fn()
    .mockReturnValue("[vault:notes.md › Protocole IRM]\nContenu IRM"),
}));

import { searchVaultFn } from "./vaultTools";

describe("searchVaultFn", () => {
  it("retourne le contexte vault et les sources", async () => {
    const result = await searchVaultFn({ query: "protocole IRM genou" });
    expect(result.context).toContain("Contenu IRM");
    expect(result.sources).toContain("vault:notes.md");
  });

  it("filtre avec sourcePrefix vault:", async () => {
    const { searchSimilar } = await import("../knowledge/store");
    expect(vi.mocked(searchSimilar)).toHaveBeenCalledWith(
      expect.any(Array),
      5,
      { sourcePrefix: "vault:" }
    );
  });

  it("retourne contexte vide si Ollama indisponible", async () => {
    const { embedText } = await import("../knowledge/embeddings");
    vi.mocked(embedText).mockRejectedValueOnce(new Error("timeout"));
    const result = await searchVaultFn({ query: "test" });
    expect(result.context).toBe("");
    expect(result.sources).toEqual([]);
  });
});
```

- [ ] **Step 2: Vérifier que le test échoue**

```bash
pnpm test server/tools/vaultTools.test.ts
```

Expected: FAIL — module introuvable

- [ ] **Step 3: Créer `server/tools/vaultTools.ts`**

```ts
import { embedText } from "../knowledge/embeddings";
import { searchSimilar } from "../knowledge/store";
import { selectRelevant, buildKnowledgeBlock } from "../knowledge/retrieve";

export async function searchVaultFn(args: {
  query: string;
}): Promise<{ context: string; sources: string[] }> {
  try {
    const emb = await embedText(args.query);
    const hits = await searchSimilar(emb, 5, { sourcePrefix: "vault:" });
    const selected = selectRelevant(hits);
    return {
      context: buildKnowledgeBlock(selected),
      sources: selected.map(s => s.source),
    };
  } catch {
    return { context: "", sources: [] };
  }
}
```

- [ ] **Step 4: Ajouter "searchVault" au copilote dans `server/agents/registry.ts`**

Remplacer la ligne `tools: ["searchPatient", "explainReport"],` dans le spec copilote par :

```ts
tools: ["searchPatient", "explainReport", "searchVault"],
```

- [ ] **Step 5: Ajouter `vaultSyncToken` dans `server/_core/env.ts`**

Ajouter à la fin de l'objet `ENV`, avant la fermeture `}` :

```ts
  // Token Bearer pour déclencher la sync vault depuis un cron externe (hors UI).
  vaultSyncToken: process.env.VAULT_SYNC_TOKEN ?? "",
```

- [ ] **Step 6: Ajouter les routes dans `server/routers.ts`**

Dans le bloc `hermes: router({`, après la route `backfillNameSearch`, ajouter :

```ts
    searchVault: medicalProcedure
      .input(z.object({ query: z.string().min(1).max(500) }))
      .query(async ({ input }) => {
        const { runAgentTool } = await import("./agents/tools");
        const { searchVaultFn } = await import("./tools/vaultTools");
        return runAgentTool("copilote", "searchVault", searchVaultFn, { query: input.query });
      }),
```

Dans le bloc `knowledge: router({`, après la route `ingest`, ajouter :

```ts
    syncVaultFromDisk: adminProcedure.mutation(async ({ ctx }) => {
      const { syncVault } = await import("./knowledge/vaultSync");
      const { ENV } = await import("./_core/env");
      if (!ENV.knowledgeVaultDir) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "KNOWLEDGE_VAULT_DIR non configuré" });
      }
      const result = await syncVault();
      await recordAccess({
        userId: ctx.user.id,
        action: "knowledge.syncVault",
        studyId: null,
        detail: `added=${result.added} removed=${result.removed}`,
        ipAddress: ctx.req?.ip ?? null,
      });
      return result;
    }),
```

- [ ] **Step 7: Vérifier les tests et le typage**

```bash
pnpm test server/tools/vaultTools.test.ts
pnpm check
```

Expected: PASS + tsc OK

- [ ] **Step 8: Commit**

```bash
git add server/tools/vaultTools.ts server/tools/vaultTools.test.ts \
  server/agents/registry.ts server/_core/env.ts server/routers.ts
git commit -m "feat(hermes): searchVault tool + syncVaultFromDisk route (Group A)"
```

---

## Task 3: Group B — Météo + fuseau horaire + calendrier

**Files:**

- Create: `server/tools/contextTools.ts`
- Create: `server/tools/contextTools.test.ts`
- Modify: `server/agents/registry.ts` (ajouter 3 outils au copilote)
- Modify: `server/_core/env.ts` (ajouter cabinetLat, cabinetLng, googleServiceAccountJson)
- Modify: `server/routers.ts` (hermes.weather, hermes.localTime, hermes.calendarToday)

**Interfaces:**

- Produces:
  - `getWeatherFn(): Promise<{ available: boolean; temperature?: number; condition?: string; tomorrow?: { temperature: number; condition: string } }>`
  - `getLocalTimeFn(): Promise<{ iso: string; formatted: string; timezone: string }>`
  - `calendarTodayFn(args: { date?: string }): Promise<{ events: Array<{ time: string; title: string; source: string; studyId?: number }> }>`

- [ ] **Step 1: Installer googleapis**

```bash
cd /Users/mbbssarl/Documents/GitHub/horos-viewer
pnpm add googleapis
```

Expected: `googleapis` ajouté à `package.json`

- [ ] **Step 2: Écrire les tests en échec**

```ts
// server/tools/contextTools.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock global fetch for Open-Meteo
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

vi.mock("../db", () => ({ getDb: vi.fn() }));
vi.mock("../../drizzle/schema", () => ({ studies: {} }));
vi.mock("drizzle-orm", () => ({ eq: vi.fn(), sql: vi.fn() }));

import { getWeatherFn, getLocalTimeFn, calendarTodayFn } from "./contextTools";
import { getDb } from "../db";

describe("getLocalTimeFn", () => {
  it("retourne heure suisse correctement formatée", async () => {
    const result = await getLocalTimeFn();
    expect(result.timezone).toBe("Europe/Zurich");
    expect(result.iso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(result.formatted).toMatch(/\d{2}:\d{2}/);
  });
});

describe("getWeatherFn", () => {
  beforeEach(() => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        current: { temperature_2m: 18, weathercode: 1 },
        daily: {
          temperature_2m_max: [20],
          weathercode: [3],
        },
      }),
    });
  });

  it("retourne la météo parsée correctement", async () => {
    const result = await getWeatherFn();
    expect(result.available).toBe(true);
    expect(result.temperature).toBe(18);
    expect(result.condition).toBeTruthy();
  });

  it("retourne available: false si fetch échoue", async () => {
    mockFetch.mockRejectedValueOnce(new Error("network error"));
    const result = await getWeatherFn();
    expect(result.available).toBe(false);
  });

  it("retourne available: false si réponse non-ok", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false });
    const result = await getWeatherFn();
    expect(result.available).toBe(false);
  });
});

describe("calendarTodayFn", () => {
  beforeEach(() => {
    vi.mocked(getDb).mockResolvedValue({
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi
            .fn()
            .mockResolvedValue([
              { id: 42, modality: "CT", studyDate: "2026-06-24" },
            ]),
        }),
      }),
    } as any);
  });

  it("retourne les études du jour comme événements", async () => {
    const result = await calendarTodayFn({ date: "2026-06-24" });
    const studyEvt = result.events.find(e => e.source === "studies");
    expect(studyEvt).toBeDefined();
    expect(studyEvt?.studyId).toBe(42);
  });

  it("fusionne Google Calendar et études (gcal absent = pas d'erreur)", async () => {
    const result = await calendarTodayFn({ date: "2026-06-24" });
    expect(Array.isArray(result.events)).toBe(true);
  });
});
```

- [ ] **Step 3: Vérifier que le test échoue**

```bash
pnpm test server/tools/contextTools.test.ts
```

Expected: FAIL — module introuvable

- [ ] **Step 4: Créer `server/tools/contextTools.ts`**

```ts
import { ENV } from "../_core/env";

// ─── Codes météo WMO → libellé français ───────────────────────────────────
const WMO_LABELS: Record<number, string> = {
  0: "Ciel dégagé",
  1: "Légèrement nuageux",
  2: "Partiellement nuageux",
  3: "Couvert",
  45: "Brouillard",
  48: "Brouillard givrant",
  51: "Bruine légère",
  53: "Bruine modérée",
  55: "Bruine dense",
  61: "Pluie légère",
  63: "Pluie modérée",
  65: "Pluie forte",
  71: "Neige légère",
  73: "Neige modérée",
  75: "Neige forte",
  80: "Averses légères",
  81: "Averses modérées",
  82: "Averses fortes",
  95: "Orage",
  96: "Orage avec grêle",
  99: "Orage avec forte grêle",
};

function wmoLabel(code: number): string {
  return WMO_LABELS[code] ?? `Code ${code}`;
}

// ─── Météo ─────────────────────────────────────────────────────────────────
export async function getWeatherFn(): Promise<{
  available: boolean;
  temperature?: number;
  condition?: string;
  tomorrow?: { temperature: number; condition: string };
}> {
  const lat = ENV.cabinetLat;
  const lng = ENV.cabinetLng;
  if (!lat || !lng) return { available: false };
  const url =
    `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${lat}&longitude=${lng}` +
    `&current=temperature_2m,weathercode` +
    `&daily=temperature_2m_max,weathercode&timezone=Europe%2FZurich&forecast_days=2`;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 5000);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) return { available: false };
    const data = await resp.json();
    return {
      available: true,
      temperature: data.current?.temperature_2m,
      condition: wmoLabel(data.current?.weathercode ?? 0),
      tomorrow: {
        temperature:
          data.daily?.temperature_2m_max?.[1] ??
          data.daily?.temperature_2m_max?.[0],
        condition: wmoLabel(data.daily?.weathercode?.[1] ?? 0),
      },
    };
  } catch {
    return { available: false };
  } finally {
    clearTimeout(t);
  }
}

// ─── Heure locale ──────────────────────────────────────────────────────────
export async function getLocalTimeFn(): Promise<{
  iso: string;
  formatted: string;
  timezone: string;
}> {
  const now = new Date();
  const formatted = new Intl.DateTimeFormat("fr-CH", {
    timeZone: "Europe/Zurich",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(now);
  const iso = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Zurich",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
    .format(now)
    .replace(" ", "T");
  return { iso, formatted, timezone: "Europe/Zurich" };
}

// ─── Calendrier (Google + études MySQL) ────────────────────────────────────
type CalEvent = {
  time: string;
  title: string;
  source: "gcal" | "studies";
  studyId?: number;
};

async function fetchGcalEvents(date: string): Promise<CalEvent[]> {
  const keyJson = ENV.googleServiceAccountJson;
  if (!keyJson) return [];
  try {
    const { google } = await import("googleapis");
    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(keyJson),
      scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
    });
    const calendar = google.calendar({
      version: "v3",
      auth: await auth.getClient(),
    });
    const timeMin = new Date(`${date}T00:00:00+01:00`).toISOString();
    const timeMax = new Date(`${date}T23:59:59+01:00`).toISOString();
    const calendarId = ENV.googleCalendarId || "primary";
    const resp = await calendar.events.list({
      calendarId,
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 20,
    });
    return (resp.data.items ?? []).map(ev => ({
      time: ev.start?.dateTime
        ? new Date(ev.start.dateTime).toLocaleTimeString("fr-CH", {
            hour: "2-digit",
            minute: "2-digit",
          })
        : "00:00",
      title: ev.summary ?? "(sans titre)",
      source: "gcal" as const,
    }));
  } catch {
    return [];
  }
}

async function fetchStudyEvents(date: string): Promise<CalEvent[]> {
  try {
    const { getDb } = await import("../db");
    const { studies } = await import("../../drizzle/schema");
    const { eq } = await import("drizzle-orm");
    const db = await getDb();
    if (!db) return [];
    const rows = await db
      .select({
        id: studies.id,
        modality: studies.modality,
        studyDate: studies.studyDate,
      })
      .from(studies)
      .where(eq(studies.studyDate, date));
    return rows.map(r => ({
      time: "00:00",
      title: `Étude ${r.modality ?? "?"}`,
      source: "studies" as const,
      studyId: r.id,
    }));
  } catch {
    return [];
  }
}

export async function calendarTodayFn(args: { date?: string }): Promise<{
  events: CalEvent[];
}> {
  const date =
    args.date ??
    new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Europe/Zurich",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  const [gcal, studyEvts] = await Promise.all([
    fetchGcalEvents(date),
    fetchStudyEvents(date),
  ]);
  const events = [...gcal, ...studyEvts].sort((a, b) =>
    a.time.localeCompare(b.time)
  );
  return { events };
}
```

- [ ] **Step 5: Ajouter les 3 vars d'env dans `server/_core/env.ts`**

Ajouter à la fin de l'objet `ENV` (avant la fermeture `}`) :

```ts
  // Coordonnées GPS du cabinet pour la météo Open-Meteo (pas de clé requise).
  cabinetLat: process.env.CABINET_LAT ?? "",
  cabinetLng: process.env.CABINET_LNG ?? "",
  // Service account Google Calendar (JSON stringifié). Vide = calendrier désactivé.
  googleServiceAccountJson: process.env.GOOGLE_SA_KEY_JSON ?? "",
  // ID du calendrier Google à lire (défaut = "primary" du service account).
  googleCalendarId: process.env.GOOGLE_CALENDAR_ID ?? "primary",
```

- [ ] **Step 6: Ajouter les 3 outils dans `registry.ts` copilote**

```ts
tools: ["searchPatient", "explainReport", "searchVault", "getWeather", "getLocalTime", "calendarToday"],
```

- [ ] **Step 7: Ajouter les 3 routes tRPC dans `server/routers.ts` (bloc `hermes`)**

```ts
    weather: medicalProcedure.query(async () => {
      const { runAgentTool } = await import("./agents/tools");
      const { getWeatherFn } = await import("./tools/contextTools");
      return runAgentTool("copilote", "getWeather", () => getWeatherFn(), null);
    }),
    localTime: medicalProcedure.query(async () => {
      const { runAgentTool } = await import("./agents/tools");
      const { getLocalTimeFn } = await import("./tools/contextTools");
      return runAgentTool("copilote", "getLocalTime", () => getLocalTimeFn(), null);
    }),
    calendarToday: medicalProcedure
      .input(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }))
      .query(async ({ input }) => {
        const { runAgentTool } = await import("./agents/tools");
        const { calendarTodayFn } = await import("./tools/contextTools");
        return runAgentTool("copilote", "calendarToday", calendarTodayFn, { date: input.date });
      }),
```

- [ ] **Step 8: Vérifier tests et typage**

```bash
pnpm test server/tools/contextTools.test.ts
pnpm check
```

Expected: PASS + tsc OK

- [ ] **Step 9: Commit**

```bash
git add server/tools/contextTools.ts server/tools/contextTools.test.ts \
  server/agents/registry.ts server/_core/env.ts server/routers.ts package.json pnpm-lock.yaml
git commit -m "feat(hermes): getWeather + getLocalTime + calendarToday tools (Group B)"
```

---

## Task 4: Group C — PubMed + guidelinesSync + searchGuidelines

**Files:**

- Create: `server/tools/researchTools.ts`
- Create: `server/tools/researchTools.test.ts`
- Create: `server/knowledge/guidelinesSync.ts`
- Create: `server/knowledge/guidelinesSync.test.ts`
- Modify: `server/agents/registry.ts` (ajouter 2 outils)
- Modify: `server/_core/env.ts` (ajouter ncbiApiKey)
- Modify: `server/routers.ts` (hermes.pubmedSearch, hermes.searchGuidelines, knowledge.syncGuidelines)

**Interfaces:**

- Produces:
  - `pubmedSearchFn(args: { query: string; maxResults?: number }): Promise<{ available: boolean; results: Array<{ pmid: string; title: string; abstract: string; year: string }> }>`
  - `searchGuidelinesFn(args: { query: string }): Promise<{ context: string; sources: string[] }>`
  - `syncGuidelines(): Promise<{ inserted: number; sources: string[] }>`

- [ ] **Step 1: Écrire les tests en échec**

```ts
// server/tools/researchTools.test.ts
import { describe, it, expect, vi } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

vi.mock("../knowledge/embeddings", () => ({
  embedText: vi.fn().mockResolvedValue([0.5, 0.5]),
}));
vi.mock("../knowledge/store", () => ({
  searchSimilar: vi.fn().mockResolvedValue([
    {
      source: "guidelines:esr",
      heading: "Protocole IRM",
      content: "Contenu guideline",
      score: 0.9,
    },
  ]),
}));
vi.mock("../knowledge/retrieve", () => ({
  selectRelevant: vi.fn(chunks => chunks),
  buildKnowledgeBlock: vi
    .fn()
    .mockReturnValue("[guidelines:esr › Protocole IRM]\nContenu guideline"),
}));

import { pubmedSearchFn, searchGuidelinesFn } from "./researchTools";

describe("pubmedSearchFn", () => {
  it("retourne les résultats PubMed parsés", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: vi
          .fn()
          .mockResolvedValue({ esearchresult: { idlist: ["12345678"] } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: vi
          .fn()
          .mockResolvedValue(
            "1. Radiology protocol review.\n" +
              "Smith J, et al.\n" +
              "Radiology. 2025;300(1):10-15.\n" +
              "PMID: 12345678\n" +
              "DOI: 10.1234/rad.2025\n\n" +
              "Abstract: This study examines IRM protocols."
          ),
      });
    const result = await pubmedSearchFn({
      query: "IRM genou protocole",
      maxResults: 1,
    });
    expect(result.available).toBe(true);
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results[0].pmid).toBe("12345678");
  });

  it("retourne available: false si réseau KO", async () => {
    mockFetch.mockRejectedValueOnce(new Error("network"));
    const result = await pubmedSearchFn({ query: "test" });
    expect(result.available).toBe(false);
  });

  it("retourne available: false si aucun PMID trouvé", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({ esearchresult: { idlist: [] } }),
    });
    const result = await pubmedSearchFn({ query: "rien" });
    expect(result.available).toBe(true);
    expect(result.results).toEqual([]);
  });
});

describe("searchGuidelinesFn", () => {
  it("filtre les chunks avec sourcePrefix guidelines:", async () => {
    const { searchSimilar } = await import("../knowledge/store");
    const result = await searchGuidelinesFn({ query: "IRM protocole" });
    expect(vi.mocked(searchSimilar)).toHaveBeenCalledWith(
      expect.any(Array),
      5,
      { sourcePrefix: "guidelines:" }
    );
    expect(result.context).toContain("guidelines:esr");
  });
});
```

```ts
// server/knowledge/guidelinesSync.test.ts
import { describe, it, expect, vi } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

vi.mock("./embeddings", () => ({
  embedText: vi.fn().mockResolvedValue([0.5, 0.5]),
}));
vi.mock("./store", () => ({
  insertChunks: vi.fn().mockResolvedValue(1),
  clearKnowledge: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./chunk", () => ({
  chunkMarkdown: vi
    .fn()
    .mockReturnValue([
      { heading: "ESR Guideline", content: "Content here", length: 12 },
    ]),
}));

import { parseRssItems, buildGuidelinesSource } from "./guidelinesSync";

describe("guidelinesSync — fonctions pures", () => {
  it("parseRssItems extrait titre et description du RSS", () => {
    const xml = `<rss><channel>
      <item><title>ESR Guideline 2025</title><description>New protocol</description><link>https://example.com/1</link></item>
    </channel></rss>`;
    const items = parseRssItems(xml);
    expect(items.length).toBe(1);
    expect(items[0].title).toBe("ESR Guideline 2025");
    expect(items[0].content).toContain("New protocol");
  });

  it("buildGuidelinesSource normalise le slug source", () => {
    expect(buildGuidelinesSource("ESR")).toBe("guidelines:esr");
    expect(buildGuidelinesSource("ACR Guidelines")).toBe(
      "guidelines:acr-guidelines"
    );
  });
});
```

- [ ] **Step 2: Vérifier que les tests échouent**

```bash
pnpm test server/tools/researchTools.test.ts server/knowledge/guidelinesSync.test.ts
```

Expected: FAIL — modules introuvables

- [ ] **Step 3: Créer `server/tools/researchTools.ts`**

```ts
import { ENV } from "../_core/env";
import { embedText } from "../knowledge/embeddings";
import { searchSimilar } from "../knowledge/store";
import { selectRelevant, buildKnowledgeBlock } from "../knowledge/retrieve";

const NCBI_BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";

// ─── PubMed à la demande ──────────────────────────────────────────────────
export async function pubmedSearchFn(args: {
  query: string;
  maxResults?: number;
}): Promise<{
  available: boolean;
  results: Array<{
    pmid: string;
    title: string;
    abstract: string;
    year: string;
  }>;
}> {
  const maxResults = Math.min(args.maxResults ?? 5, 10);
  const apiKey = ENV.ncbiApiKey ? `&api_key=${ENV.ncbiApiKey}` : "";
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 10_000);
  try {
    const searchUrl =
      `${NCBI_BASE}/esearch.fcgi?db=pubmed&retmode=json&sort=relevance` +
      `&retmax=${maxResults}&term=${encodeURIComponent(args.query)}${apiKey}`;
    const searchResp = await fetch(searchUrl, { signal: controller.signal });
    if (!searchResp.ok) return { available: false, results: [] };
    const searchData = await searchResp.json();
    const idlist: string[] = searchData?.esearchresult?.idlist ?? [];
    if (idlist.length === 0) return { available: true, results: [] };

    const fetchUrl =
      `${NCBI_BASE}/efetch.fcgi?db=pubmed&rettype=abstract&retmode=text` +
      `&id=${idlist.join(",")}${apiKey}`;
    const fetchResp = await fetch(fetchUrl, { signal: controller.signal });
    if (!fetchResp.ok) return { available: false, results: [] };
    const raw = await fetchResp.text();

    const results = parseAbstractsText(raw, idlist);
    return { available: true, results };
  } catch {
    return { available: false, results: [] };
  } finally {
    clearTimeout(t);
  }
}

/** Parse le texte brut efetch en tableau structuré. */
function parseAbstractsText(
  text: string,
  idlist: string[]
): Array<{ pmid: string; title: string; abstract: string; year: string }> {
  const blocks = text.split(/\n\n(?=\d+\.)/).filter(Boolean);
  return blocks.map((block, i) => {
    const lines = block
      .split("\n")
      .map(l => l.trim())
      .filter(Boolean);
    const title = lines[0]?.replace(/^\d+\.\s*/, "") ?? "";
    const pmidMatch = block.match(/PMID:\s*(\d+)/);
    const pmid = pmidMatch?.[1] ?? idlist[i] ?? "";
    const yearMatch = block.match(/\b(19|20)\d{2}\b/);
    const year = yearMatch?.[0] ?? "";
    const abstractStart = block.indexOf("Abstract:");
    const abstract =
      abstractStart >= 0
        ? block
            .slice(abstractStart + 9)
            .trim()
            .slice(0, 800)
        : lines.slice(2, 5).join(" ").slice(0, 800);
    return { pmid, title, abstract, year };
  });
}

// ─── Guidelines indexées (recherche locale) ────────────────────────────────
export async function searchGuidelinesFn(args: {
  query: string;
}): Promise<{ context: string; sources: string[] }> {
  try {
    const emb = await embedText(args.query);
    const hits = await searchSimilar(emb, 5, { sourcePrefix: "guidelines:" });
    const selected = selectRelevant(hits);
    return {
      context: buildKnowledgeBlock(selected),
      sources: selected.map(s => s.source),
    };
  } catch {
    return { context: "", sources: [] };
  }
}
```

- [ ] **Step 4: Créer `server/knowledge/guidelinesSync.ts`**

```ts
import { embedText } from "./embeddings";
import { chunkMarkdown } from "./chunk";
import { insertChunks, clearKnowledge } from "./store";

export interface RssItem {
  title: string;
  content: string;
  link: string;
}

export function buildGuidelinesSource(name: string): string {
  return `guidelines:${name.toLowerCase().replace(/\s+/g, "-")}`;
}

export function parseRssItems(xml: string): RssItem[] {
  const items: RssItem[] = [];
  const itemMatches = xml.matchAll(/<item>([\s\S]*?)<\/item>/g);
  for (const m of itemMatches) {
    const block = m[1];
    const title =
      block.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/)?.[1] ??
      block.match(/<title>(.*?)<\/title>/)?.[1] ??
      "";
    const description =
      block.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/s)?.[1] ??
      block.match(/<description>(.*?)<\/description>/s)?.[1] ??
      "";
    const link = block.match(/<link>(.*?)<\/link>/)?.[1] ?? "";
    if (title) {
      items.push({
        title: title.trim(),
        content: `${title.trim()}\n\n${description.replace(/<[^>]+>/g, "").trim()}`,
        link: link.trim(),
      });
    }
  }
  return items;
}

interface GuidelinesSource {
  name: string;
  url: string;
  type: "rss" | "html";
}

const SOURCES: GuidelinesSource[] = [
  {
    name: "ESR",
    url: "https://www.myesr.org/rss/guidelines",
    type: "rss",
  },
  {
    name: "ACR",
    url: "https://www.acr.org/Clinical-Resources/ACR-Appropriateness-Criteria",
    type: "html",
  },
];

async function fetchSource(src: GuidelinesSource): Promise<string> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 15_000);
  try {
    const resp = await fetch(src.url, { signal: controller.signal });
    if (!resp.ok) return "";
    return await resp.text();
  } catch {
    return "";
  } finally {
    clearTimeout(t);
  }
}

async function syncSource(src: GuidelinesSource): Promise<number> {
  const raw = await fetchSource(src);
  if (!raw) return 0;
  const source = buildGuidelinesSource(src.name);

  let markdownItems: string[] = [];
  if (src.type === "rss") {
    const items = parseRssItems(raw);
    markdownItems = items.map(it => `# ${it.title}\n\n${it.content}`);
  } else {
    // HTML: extraction basique du texte
    const text = raw
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    markdownItems = [`# ${src.name} Guidelines\n\n${text.slice(0, 20000)}`];
  }

  if (markdownItems.length === 0) return 0;
  const combined = markdownItems.join("\n\n---\n\n");
  const chunks = chunkMarkdown(`${src.name}.md`, combined);

  // Purge les anciens chunks de cette source
  await clearKnowledge(source);

  let inserted = 0;
  for (const chunk of chunks) {
    try {
      const embedding = await embedText(`${chunk.heading}\n${chunk.content}`);
      await insertChunks([
        {
          source,
          heading: chunk.heading,
          content: chunk.content,
          embedding,
        },
      ]);
      inserted++;
    } catch {
      // fail-soft : on continue avec le chunk suivant
    }
  }
  return inserted;
}

export async function syncGuidelines(): Promise<{
  inserted: number;
  sources: string[];
}> {
  let totalInserted = 0;
  const syncedSources: string[] = [];
  for (const src of SOURCES) {
    const n = await syncSource(src);
    if (n > 0) {
      totalInserted += n;
      syncedSources.push(buildGuidelinesSource(src.name));
    }
  }
  return { inserted: totalInserted, sources: syncedSources };
}
```

- [ ] **Step 5: Ajouter `ncbiApiKey` dans `server/_core/env.ts`**

```ts
  // Clé API NCBI optionnelle (lève la limite 3→10 req/s pour PubMed).
  ncbiApiKey: process.env.NCBI_API_KEY ?? "",
```

- [ ] **Step 6: Ajouter les 2 outils dans `registry.ts` copilote**

```ts
tools: [
  "searchPatient", "explainReport", "searchVault",
  "getWeather", "getLocalTime", "calendarToday",
  "pubmedSearch", "searchGuidelines",
],
```

- [ ] **Step 7: Ajouter les 3 routes dans `server/routers.ts`**

Dans `hermes` router :

```ts
    pubmedSearch: medicalProcedure
      .input(z.object({
        query: z.string().min(1).max(300),
        maxResults: z.number().int().min(1).max(10).optional(),
      }))
      .query(async ({ input }) => {
        const { runAgentTool } = await import("./agents/tools");
        const { pubmedSearchFn } = await import("./tools/researchTools");
        return runAgentTool("copilote", "pubmedSearch", pubmedSearchFn, input);
      }),
    searchGuidelines: medicalProcedure
      .input(z.object({ query: z.string().min(1).max(300) }))
      .query(async ({ input }) => {
        const { runAgentTool } = await import("./agents/tools");
        const { searchGuidelinesFn } = await import("./tools/researchTools");
        return runAgentTool("copilote", "searchGuidelines", searchGuidelinesFn, { query: input.query });
      }),
```

Dans `knowledge` router :

```ts
    syncGuidelines: adminProcedure.mutation(async ({ ctx }) => {
      const { syncGuidelines } = await import("./knowledge/guidelinesSync");
      const result = await syncGuidelines();
      await recordAccess({
        userId: ctx.user.id,
        action: "knowledge.syncGuidelines",
        studyId: null,
        detail: `inserted=${result.inserted}`,
        ipAddress: ctx.req?.ip ?? null,
      });
      return result;
    }),
```

- [ ] **Step 8: Vérifier tests et typage**

```bash
pnpm test server/tools/researchTools.test.ts server/knowledge/guidelinesSync.test.ts
pnpm check
```

Expected: PASS + tsc OK

- [ ] **Step 9: Commit**

```bash
git add server/tools/researchTools.ts server/tools/researchTools.test.ts \
  server/knowledge/guidelinesSync.ts server/knowledge/guidelinesSync.test.ts \
  server/agents/registry.ts server/_core/env.ts server/routers.ts
git commit -m "feat(hermes): pubmedSearch + searchGuidelines + guidelinesSync (Group C)"
```

---

## Task 5: Group D — Outils interaction agent CR

**Files:**

- Create: `server/tools/crTools.ts`
- Create: `server/tools/crTools.test.ts`
- Modify: `server/agents/registry.ts` (ajouter 3 outils)
- Modify: `server/routers.ts` (hermes.listPendingSignatures, hermes.getCRDraft, hermes.requestCRGeneration)

**Interfaces:**

- Consumes: `reports` table (Drizzle), `studies` table, `runAgentOnce` de autoReportAgent.ts
- Note: `reports.status` enum = `["draft", "signed"]` uniquement — "pending_signature" n'existe pas. Les rapports en attente de signature = `status = "draft" AND aiGenerated = true`.
- Produces:
  - `listPendingSignaturesFn(): Promise<{ pending: Array<{ reportId: number; studyId: number; modality: string | null; studyDate: string | null }> }>`
  - `getCRDraftFn(args: { studyId: number }): Promise<{ found: boolean; status?: string; draftText?: string; modality?: string | null; studyDate?: string | null }>`
  - `requestCRGenerationFn(args: { studyId: number }): Promise<{ alreadyExists: boolean; jobStarted: boolean; status?: string; expectedDelaySeconds?: number }>`

- [ ] **Step 1: Écrire le test en échec**

```ts
// server/tools/crTools.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db", () => ({ getDb: vi.fn() }));
vi.mock("../../drizzle/schema", () => ({
  reports: {},
  studies: {},
}));
vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col, val) => ({ col, val })),
  and: vi.fn((...args) => args),
  desc: vi.fn(col => col),
}));
vi.mock("../report/autoReportAgent", () => ({
  runAgentOnce: vi.fn().mockResolvedValue({ generated: 1 }),
}));

import {
  listPendingSignaturesFn,
  getCRDraftFn,
  requestCRGenerationFn,
} from "./crTools";
import { getDb } from "../db";

const makeDb = (reports: any[], joinResult?: any[]) => ({
  select: vi.fn().mockReturnValue({
    from: vi.fn().mockReturnValue({
      innerJoin: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue(joinResult ?? reports),
          }),
          limit: vi.fn().mockResolvedValue(joinResult ?? reports),
        }),
      }),
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(reports),
        orderBy: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(reports),
        }),
      }),
    }),
  }),
});

describe("listPendingSignaturesFn", () => {
  it("retourne les drafts IA en attente de signature", async () => {
    vi.mocked(getDb).mockResolvedValue(
      makeDb(
        [],
        [{ reportId: 1, studyId: 10, modality: "CT", studyDate: "2026-06-24" }]
      ) as any
    );
    const result = await listPendingSignaturesFn();
    expect(result.pending.length).toBe(1);
    expect(result.pending[0].reportId).toBe(1);
    expect(result.pending[0].modality).toBe("CT");
  });

  it("retourne un tableau vide si aucun draft", async () => {
    vi.mocked(getDb).mockResolvedValue(makeDb([], []) as any);
    const result = await listPendingSignaturesFn();
    expect(result.pending).toEqual([]);
  });
});

describe("getCRDraftFn", () => {
  it("retourne found: false si aucun rapport", async () => {
    vi.mocked(getDb).mockResolvedValue(makeDb([]) as any);
    const result = await getCRDraftFn({ studyId: 99 });
    expect(result.found).toBe(false);
  });

  it("retourne le rapport sans PHI patient", async () => {
    vi.mocked(getDb).mockResolvedValue(
      makeDb(
        [],
        [
          {
            id: 5,
            status: "draft",
            resultats: "Résultat normal",
            conclusion: "RAS",
            modality: "IRM",
            studyDate: "2026-06-24",
          },
        ]
      ) as any
    );
    const result = await getCRDraftFn({ studyId: 10 });
    expect(result.found).toBe(true);
    expect(result.draftText).toContain("Résultat normal");
    expect(result.status).toBe("draft");
  });
});

describe("requestCRGenerationFn", () => {
  it("retourne alreadyExists: true si draft existant", async () => {
    vi.mocked(getDb).mockResolvedValue(
      makeDb([{ id: 3, status: "draft" }]) as any
    );
    const result = await requestCRGenerationFn({ studyId: 10 });
    expect(result.alreadyExists).toBe(true);
    expect(result.jobStarted).toBe(false);
  });

  it("déclenche runAgentOnce si pas de draft existant", async () => {
    vi.mocked(getDb).mockResolvedValue(makeDb([]) as any);
    const { runAgentOnce } = await import("../report/autoReportAgent");
    const result = await requestCRGenerationFn({ studyId: 10 });
    expect(result.jobStarted).toBe(true);
    expect(result.alreadyExists).toBe(false);
  });
});
```

- [ ] **Step 2: Vérifier que le test échoue**

```bash
pnpm test server/tools/crTools.test.ts
```

Expected: FAIL — module introuvable

- [ ] **Step 3: Créer `server/tools/crTools.ts`**

```ts
import { eq, and, desc } from "drizzle-orm";
import { getDb } from "../db";
import { reports, studies } from "../../drizzle/schema";

type PendingItem = {
  reportId: number;
  studyId: number;
  modality: string | null;
  studyDate: string | null;
};

export async function listPendingSignaturesFn(): Promise<{
  pending: PendingItem[];
}> {
  const db = await getDb();
  if (!db) return { pending: [] };
  const rows = await db
    .select({
      reportId: reports.id,
      studyId: reports.studyId,
      modality: studies.modality,
      studyDate: studies.studyDate,
    })
    .from(reports)
    .innerJoin(studies, eq(reports.studyId, studies.id))
    .where(and(eq(reports.status, "draft"), eq(reports.aiGenerated, true)))
    .orderBy(desc(reports.createdAt))
    .limit(10);
  return { pending: rows };
}

export async function getCRDraftFn(args: { studyId: number }): Promise<{
  found: boolean;
  status?: string;
  draftText?: string;
  modality?: string | null;
  studyDate?: string | null;
}> {
  const db = await getDb();
  if (!db) return { found: false };
  const rows = await db
    .select({
      id: reports.id,
      status: reports.status,
      resultats: reports.resultats,
      conclusion: reports.conclusion,
      modality: studies.modality,
      studyDate: studies.studyDate,
    })
    .from(reports)
    .innerJoin(studies, eq(reports.studyId, studies.id))
    .where(eq(reports.studyId, args.studyId))
    .orderBy(desc(reports.createdAt))
    .limit(1);
  const r = rows[0];
  if (!r) return { found: false };
  const draftText = [
    r.resultats ? `Résultats : ${r.resultats}` : "",
    r.conclusion ? `Conclusion : ${r.conclusion}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  return {
    found: true,
    status: r.status,
    draftText,
    modality: r.modality,
    studyDate: r.studyDate,
  };
}

export async function requestCRGenerationFn(args: {
  studyId: number;
}): Promise<{
  alreadyExists: boolean;
  jobStarted: boolean;
  status?: string;
  expectedDelaySeconds?: number;
}> {
  const db = await getDb();
  if (!db) return { alreadyExists: false, jobStarted: false };
  const existing = await db
    .select({ id: reports.id, status: reports.status })
    .from(reports)
    .where(eq(reports.studyId, args.studyId))
    .limit(1);
  if (existing[0]) {
    return {
      alreadyExists: true,
      jobStarted: false,
      status: existing[0].status,
    };
  }
  // Déclenche l'agent CR de façon asynchrone (fire-and-forget)
  const { runAgentOnce } = await import("../report/autoReportAgent");
  runAgentOnce().catch(e =>
    console.warn("[crTool] requestCRGeneration failed:", (e as Error)?.message)
  );
  return { alreadyExists: false, jobStarted: true, expectedDelaySeconds: 30 };
}
```

- [ ] **Step 4: Ajouter les 3 outils dans `registry.ts` copilote**

```ts
tools: [
  "searchPatient", "explainReport", "searchVault",
  "getWeather", "getLocalTime", "calendarToday",
  "pubmedSearch", "searchGuidelines",
  "listPendingSignatures", "getCRDraft", "requestCRGeneration",
],
```

- [ ] **Step 5: Ajouter les 3 routes dans `server/routers.ts` (bloc `hermes`)**

```ts
    listPendingSignatures: medicalProcedure.query(async () => {
      const { runAgentTool } = await import("./agents/tools");
      const { listPendingSignaturesFn } = await import("./tools/crTools");
      return runAgentTool("copilote", "listPendingSignatures", () => listPendingSignaturesFn(), null);
    }),
    getCRDraft: medicalProcedure
      .input(z.object({ studyId: z.number().int().positive() }))
      .query(async ({ input }) => {
        const { runAgentTool } = await import("./agents/tools");
        const { getCRDraftFn } = await import("./tools/crTools");
        return runAgentTool("copilote", "getCRDraft", getCRDraftFn, { studyId: input.studyId });
      }),
    requestCRGeneration: medicalProcedure
      .input(z.object({ studyId: z.number().int().positive() }))
      .mutation(async ({ input }) => {
        const { runAgentTool } = await import("./agents/tools");
        const { requestCRGenerationFn } = await import("./tools/crTools");
        return runAgentTool("copilote", "requestCRGeneration", requestCRGenerationFn, { studyId: input.studyId });
      }),
```

- [ ] **Step 6: Vérifier tests et typage**

```bash
pnpm test server/tools/crTools.test.ts
pnpm check
```

Expected: PASS + tsc OK

- [ ] **Step 7: Commit**

```bash
git add server/tools/crTools.ts server/tools/crTools.test.ts \
  server/agents/registry.ts server/routers.ts
git commit -m "feat(hermes): listPendingSignatures + getCRDraft + requestCRGeneration (Group D)"
```

---

## Task 6: Variables d'environnement, .env.example, suite de tests complète

**Files:**

- Modify: `.env.example`

**Interfaces:**

- Consumes: toutes les vars ajoutées dans ENV (Tasks 2-5)

- [ ] **Step 1: Mettre à jour `.env.example`**

Ajouter à la fin du fichier `.env.example` :

```
# ── Hermès outils enrichis ──────────────────────────────────────────────────

# Group A — Vault RAG (mémoire Obsidian)
# Token Bearer pour déclencher la sync vault via HTTP (cron VPS, admin seulement).
# Générer avec : openssl rand -hex 32
VAULT_SYNC_TOKEN=

# Group B — Météo + calendrier
# Coordonnées GPS du cabinet pour la météo Open-Meteo (gratuit, pas de clé).
# Genève : 46.2044 / 6.1432 — Lausanne : 46.5197 / 6.6323
CABINET_LAT=46.2044
CABINET_LNG=6.1432

# Google Calendar (service account). Partager le calendrier du médecin en
# lecture avec l'email du service account. Coller le JSON stringifié ici.
# JAMAIS en clair dans git. PHI-safe (calendrier ne contient pas de PHI).
# GOOGLE_SA_KEY_JSON={"type":"service_account","project_id":"..."}
# ID du calendrier à lire (défaut = "primary"). Peut être une adresse email
# de calendrier partagé : ex. cabinet@exemple.com
# GOOGLE_CALENDAR_ID=primary

# Group C — Veille radiologique PubMed
# Clé API NCBI optionnelle. Sans clé : 3 req/s max. Avec clé : 10 req/s.
# Obtenir sur : https://www.ncbi.nlm.nih.gov/account/
# NCBI_API_KEY=
```

- [ ] **Step 2: Lancer la suite de tests complète**

```bash
cd /Users/mbbssarl/Documents/GitHub/horos-viewer
pnpm test
```

Expected: tous les tests passent (y compris les tests existants non modifiés)

- [ ] **Step 3: Vérifier le typage TypeScript complet**

```bash
pnpm check
```

Expected: 0 erreur

- [ ] **Step 4: Commit final**

```bash
git add .env.example
git commit -m "docs: env.example — documenter les vars hermes enrichissement (A/B/C/D)"
```

---

## Notes de déploiement (hors plan, à faire manuellement)

1. **VPS 72.62.26.49** — après merge + CI build :
   - Ajouter les vars dans `/opt/medical/mediview/.env`
   - `CABINET_LAT=46.2044 CABINET_LNG=6.1432` (Genève)
   - `VAULT_SYNC_TOKEN=<openssl rand -hex 32>`
   - `GOOGLE_SA_KEY_JSON=<json stringifié du service account>` (si Google Calendar souhaité)
   - `NCBI_API_KEY=<clé NCBI>` (optionnel)
   - Redémarrer le conteneur mediview-app

2. **Cron VPS pour guidelines** (optional, après déploiement) :

```bash
echo "0 3 * * * root curl -sf -X POST https://mediview.ch/api/trpc/knowledge.syncGuidelines -H 'Authorization: Bearer $VAULT_SYNC_TOKEN' || true" >> /etc/cron.d/mediview-sync
```

3. **Cron VPS pour vault sync** :

```bash
echo "0 2 * * * root curl -sf -X POST https://mediview.ch/api/trpc/knowledge.syncVaultFromDisk -H 'Authorization: Bearer $VAULT_SYNC_TOKEN' || true" >> /etc/cron.d/mediview-sync
```

Note : les routes `syncVaultFromDisk` et `syncGuidelines` sont `adminProcedure` — le token Bearer doit correspondre à un user admin JWT, pas à `VAULT_SYNC_TOKEN`. Pour les crons automatiques, préférer un script interne Node au lieu d'une requête HTTP externe, ou créer un endpoint dédié avec `VAULT_SYNC_TOKEN` vérification manuelle.
