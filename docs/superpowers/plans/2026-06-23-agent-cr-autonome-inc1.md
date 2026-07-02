# Agent CR autonome — Incrément 1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** À l'arrivée d'une nouvelle étude, MediView génère seul un brouillon de CR, l'affiche dans une « File à signer », et — après signature du médecin — envoie automatiquement le CR par e-mail au médecin référent.

**Architecture:** Worker de fond (démarré au boot) qui scrute les études sans report et génère un brouillon `aiGenerated` via `runAiPreanalysis`. La file et l'envoi réutilisent les rails existants (`reports`, `sign`, `sendStudyReportImpl`). **MediView est MONO-CABINET** (aucun `cabinetId` dans le schéma) → `agent_settings` est une ligne unique (id=1) et `referring_contacts` n'a pas de cabinet ; l'anti-IDOR se limite à l'authentification (`medicalProcedure`).

**Tech Stack:** TypeScript, Node, Drizzle ORM (MySQL), tRPC v11, Vitest, React 19 + Vite. Migrations **manuelles** (convention repo, comme `0011`/`0012` : fichier `.sql` appliqué à la main en prod, pas d'entrée `_journal`).

**Correction du spec :** le spec mentionne un `cabinetId` ; il n'existe pas (mono-tenant). Ignorer toute notion de cabinet — `agent_settings` = singleton, `referring_contacts` = (name, email).

---

### Task 1: Schéma + migration `referring_contacts` et `agent_settings`

**Files:**

- Modify: `drizzle/schema.ts` (après le bloc `aiJobs`)
- Create: `drizzle/0013_agent_cr.sql`

- [ ] **Step 1: Ajouter les tables au schéma drizzle**

Dans `drizzle/schema.ts`, après `export type AiJob = ...`, ajouter :

```ts
/** Correspondance nom de médecin référent → e-mail (mono-cabinet). */
export const referringContacts = mysqlTable(
  "referring_contacts",
  {
    id: int("id").autoincrement().primaryKey(),
    name: varchar("name", { length: 256 }).notNull(),
    email: varchar("email", { length: 256 }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().notNull(),
  },
  t => ({ nameIdx: index("referring_contacts_name_idx").on(t.name) })
);
export type ReferringContact = typeof referringContacts.$inferSelect;

/** Réglages de l'agent CR autonome. Ligne UNIQUE (id=1). */
export const agentSettings = mysqlTable("agent_settings", {
  id: int("id").primaryKey(), // toujours 1
  enabled: boolean("enabled").notNull().default(false),
  enabledAt: timestamp("enabledAt"),
  dailyCap: int("dailyCap").notNull().default(20),
  lastRunAt: timestamp("lastRunAt"),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
});
export type AgentSettings = typeof agentSettings.$inferSelect;
```

- [ ] **Step 2: Écrire la migration SQL**

Créer `drizzle/0013_agent_cr.sql` :

```sql
CREATE TABLE `referring_contacts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(256) NOT NULL,
	`email` varchar(256) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `referring_contacts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `referring_contacts_name_idx` ON `referring_contacts` (`name`);
--> statement-breakpoint
CREATE TABLE `agent_settings` (
	`id` int NOT NULL,
	`enabled` boolean NOT NULL DEFAULT false,
	`enabledAt` timestamp NULL,
	`dailyCap` int NOT NULL DEFAULT 20,
	`lastRunAt` timestamp NULL,
	`updatedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `agent_settings_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
INSERT INTO `agent_settings` (`id`, `enabled`, `dailyCap`) VALUES (1, false, 20);
```

- [ ] **Step 3: Vérifier la compilation**

Run: `npx tsc --noEmit`
Expected: aucune erreur.

- [ ] **Step 4: Commit**

```bash
git add drizzle/schema.ts drizzle/0013_agent_cr.sql
git commit -m "feat(agent): schéma referring_contacts + agent_settings (mig 0013)"
```

---

### Task 2: Helpers DB (réglages, contacts, sélection des études)

**Files:**

- Modify: `server/db.ts` (imports schéma + nouveaux helpers en fin de fichier)
- Test: `server/db.agent.test.ts` (création)

Le `server/db.ts` importe les tables depuis `../drizzle/schema` (bloc d'imports en tête) et expose des helpers `async` qui font `const db = await getDb()`. Suivre ce pattern.

- [ ] **Step 1: Importer les nouvelles tables**

Dans le bloc d'import de `server/db.ts` (`} from "../drizzle/schema";`), ajouter `referringContacts,` et `agentSettings,`.

- [ ] **Step 2: Écrire le test des helpers purs (sélection éligibilité)**

`findStudyIdsNeedingReport` doit exclure les études ayant déjà un report et celles antérieures à `since`. La logique de requête étant en DB, on teste la fonction pure `eligibleStudyFilter` qui calcule les bornes. Créer `server/db.agent.test.ts` :

```ts
import { describe, it, expect } from "vitest";
import { normalizeReferringName } from "./db";

describe("agent helpers — normalisation référent", () => {
  it("normalise casse/espaces/accents pour la clé de recherche", () => {
    expect(normalizeReferringName("  Dr  Éva   SON ")).toBe("dr eva son");
    expect(normalizeReferringName("MARTIN^Jean")).toBe("martin jean");
  });
  it("renvoie une chaîne vide pour une entrée vide", () => {
    expect(normalizeReferringName(undefined)).toBe("");
    expect(normalizeReferringName("")).toBe("");
  });
});
```

- [ ] **Step 3: Lancer le test (échoue : fonction absente)**

Run: `npx vitest run server/db.agent.test.ts`
Expected: FAIL — `normalizeReferringName is not a function` / import manquant.

- [ ] **Step 4: Implémenter les helpers**

À la fin de `server/db.ts`, ajouter :

```ts
// ============ AGENT CR AUTONOME ============

/** Normalise un nom de référent pour servir de clé de correspondance e-mail. */
export function normalizeReferringName(name?: string | null): string {
  if (!name) return "";
  return name
    .replace(/\^/g, " ")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export async function getAgentSettings() {
  const db = await getDb();
  if (!db) return null;
  const rows = await db
    .select()
    .from(agentSettings)
    .where(eq(agentSettings.id, 1))
    .limit(1);
  return rows[0] ?? null;
}

export async function updateAgentSettings(patch: {
  enabled?: boolean;
  dailyCap?: number;
}): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const current = await getAgentSettings();
  const enabledAt =
    patch.enabled && !current?.enabledAt
      ? new Date()
      : (current?.enabledAt ?? null);
  await db
    .update(agentSettings)
    .set({
      enabled: patch.enabled ?? current?.enabled ?? false,
      dailyCap: patch.dailyCap ?? current?.dailyCap ?? 20,
      enabledAt,
      updatedAt: new Date(),
    })
    .where(eq(agentSettings.id, 1));
}

export async function setAgentLastRun(): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db
    .update(agentSettings)
    .set({ lastRunAt: new Date() })
    .where(eq(agentSettings.id, 1));
}

/** Études SANS report, créées après `since`, limitées à `limit`. */
export async function findStudyIdsNeedingReport(
  since: Date,
  limit: number
): Promise<number[]> {
  const db = await getDb();
  if (!db || limit <= 0) return [];
  const rows = await db
    .select({ id: studies.id })
    .from(studies)
    .leftJoin(reports, eq(reports.studyId, studies.id))
    .where(and(isNull(reports.id), gte(studies.createdAt, since)))
    .orderBy(asc(studies.id))
    .limit(limit);
  return rows.map(r => r.id);
}

/** Nombre de reports générés par l'agent depuis minuit (plafond/jour). */
export async function countAiReportsSince(since: Date): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const rows = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(reports)
    .where(and(eq(reports.aiGenerated, true), gte(reports.createdAt, since)));
  return Number(rows[0]?.n ?? 0);
}

export async function resolveReferringEmail(
  name?: string | null
): Promise<string | null> {
  const key = normalizeReferringName(name);
  if (!key) return null;
  const db = await getDb();
  if (!db) return null;
  const rows = await db
    .select()
    .from(referringContacts)
    .where(eq(referringContacts.name, key))
    .limit(1);
  return rows[0]?.email ?? null;
}

export async function upsertReferringEmail(
  name: string,
  email: string
): Promise<void> {
  const key = normalizeReferringName(name);
  if (!key) return;
  const db = await getDb();
  if (!db) return;
  const existing = await db
    .select()
    .from(referringContacts)
    .where(eq(referringContacts.name, key))
    .limit(1);
  if (existing[0]) {
    await db
      .update(referringContacts)
      .set({ email, updatedAt: new Date() })
      .where(eq(referringContacts.id, existing[0].id));
  } else {
    await db.insert(referringContacts).values({ name: key, email });
  }
}
```

Vérifier que `isNull` est importé en tête de `server/db.ts` (`import { eq, desc, and, like, sql, gte, lt, ne, asc, inArray, isNull } from "drizzle-orm";`). Ajouter `isNull` s'il manque.

- [ ] **Step 5: Lancer le test (passe)**

Run: `npx vitest run server/db.agent.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Vérifier tsc + commit**

Run: `npx tsc --noEmit` → aucune erreur.

```bash
git add server/db.ts server/db.agent.test.ts
git commit -m "feat(agent): helpers DB (réglages, contacts référents, éligibilité études)"
```

---

### Task 3: Worker `autoReportAgent.ts` + démarrage au boot

**Files:**

- Create: `server/report/autoReportAgent.ts`
- Modify: `server/_core/index.ts` (démarrage au boot)
- Modify: `server/_core/env.ts` (intervalle configurable)
- Test: `server/report/autoReportAgent.test.ts`

- [ ] **Step 1: Ajouter l'ENV d'intervalle**

Dans `server/_core/env.ts`, à côté des autres réglages, ajouter :

```ts
  // Intervalle (ms) du worker agent CR autonome. Défaut 5 min. 0 = ne pas démarrer.
  agentPollMs: Number(process.env.AGENT_POLL_MS ?? "300000"),
```

- [ ] **Step 2: Écrire le test du calcul de quota (fonction pure)**

Créer `server/report/autoReportAgent.test.ts` :

```ts
import { describe, it, expect } from "vitest";
import { computeBatchSize } from "./autoReportAgent";

describe("agent — taille de lot (plafond/jour)", () => {
  it("limite par le plafond restant du jour", () => {
    expect(computeBatchSize({ dailyCap: 20, generatedToday: 18 })).toBe(2);
  });
  it("zéro si plafond atteint", () => {
    expect(computeBatchSize({ dailyCap: 20, generatedToday: 20 })).toBe(0);
    expect(computeBatchSize({ dailyCap: 20, generatedToday: 25 })).toBe(0);
  });
  it("ne dépasse jamais le plafond de sécurité par passe (10)", () => {
    expect(computeBatchSize({ dailyCap: 1000, generatedToday: 0 })).toBe(10);
  });
});
```

- [ ] **Step 3: Lancer le test (échoue)**

Run: `npx vitest run server/report/autoReportAgent.test.ts`
Expected: FAIL — module/fonction absente.

- [ ] **Step 4: Implémenter le worker**

Créer `server/report/autoReportAgent.ts` :

```ts
import { ENV } from "../_core/env";
import {
  getAgentSettings,
  setAgentLastRun,
  findStudyIdsNeedingReport,
  countAiReportsSince,
  getStudyById,
  listSeriesByStudy,
  getReportByStudy,
  getDb,
} from "../db";

const MAX_PER_RUN = 10; // garde-fou de charge par passe

export function computeBatchSize(opts: {
  dailyCap: number;
  generatedToday: number;
}): number {
  const remaining = Math.max(0, opts.dailyCap - opts.generatedToday);
  return Math.min(MAX_PER_RUN, remaining);
}

function startOfToday(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

/** Génère un brouillon pour une étude (idempotent : skip si report existe). */
async function generateForStudy(studyId: number): Promise<boolean> {
  if (await getReportByStudy(studyId)) return false; // déjà traité
  const series = (await listSeriesByStudy(studyId)) as any[];
  if (!series.length) return false;
  const { runAiPreanalysis } = await import("./aiPreanalysis");
  const study = (await getStudyById(studyId)) as any;
  const res = await runAiPreanalysis(
    {
      studyId,
      seriesId: series[0].id,
      keyImages: [],
      wholeStudy: true,
      deepAnalysis: true,
    } as any,
    { user: { id: 0, name: "Agent CR" } } as any
  );
  // Re-vérifie l'idempotence après l'appel long (course possible).
  if (await getReportByStudy(studyId)) return false;
  const db = await getDb();
  if (!db) return false;
  const { reports } = await import("../../drizzle/schema");
  await db.insert(reports).values({
    studyId,
    status: "draft",
    indication: (res as any).indication ?? "",
    technique: (res as any).technique ?? "",
    resultats: (res as any).resultats ?? "",
    conclusion: (res as any).conclusion ?? "",
    aiGenerated: true,
    aiModel: (res as any).model ?? null,
    createdBy: 0, // 0 = agent système
  });
  void study;
  return true;
}

/** Une passe de l'agent : génère jusqu'au plafond restant du jour. */
export async function runAgentOnce(): Promise<{ generated: number }> {
  const settings = await getAgentSettings();
  if (!settings?.enabled || !settings.enabledAt) return { generated: 0 };
  const generatedToday = await countAiReportsSince(startOfToday());
  const batch = computeBatchSize({
    dailyCap: settings.dailyCap,
    generatedToday,
  });
  if (batch <= 0) {
    await setAgentLastRun();
    return { generated: 0 };
  }
  const ids = await findStudyIdsNeedingReport(settings.enabledAt, batch);
  let generated = 0;
  for (const id of ids) {
    try {
      if (await generateForStudy(id)) generated++;
    } catch (e) {
      console.warn(`[agent] échec étude ${id}:`, (e as Error)?.message);
    }
  }
  await setAgentLastRun();
  return { generated };
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Démarre le worker périodique (fail-soft, jamais throw). */
export function startAutoReportAgent(): void {
  if (timer || ENV.agentPollMs <= 0) return;
  timer = setInterval(() => {
    runAgentOnce().catch(e =>
      console.warn("[agent] passe échouée:", (e as Error)?.message)
    );
  }, ENV.agentPollMs);
  if (typeof timer.unref === "function") timer.unref();
}
```

- [ ] **Step 5: Lancer le test (passe)**

Run: `npx vitest run server/report/autoReportAgent.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Démarrer le worker au boot**

Dans `server/_core/index.ts`, juste après le bloc `void import("../db").then(m => m.recoverStaleAiJobs())...`, ajouter :

```ts
// Agent CR autonome : génère les brouillons des nouvelles études (si activé).
void import("../report/autoReportAgent")
  .then(m => m.startAutoReportAgent())
  .catch(() => {});
```

- [ ] **Step 7: Vérifier tsc + commit**

Run: `npx tsc --noEmit` → aucune erreur.

```bash
git add server/report/autoReportAgent.ts server/report/autoReportAgent.test.ts server/_core/index.ts server/_core/env.ts
git commit -m "feat(agent): worker autoReportAgent (génération brouillons, plafond/jour, boot)"
```

---

### Task 4: tRPC `agent.status` / `agent.configure`

**Files:**

- Modify: `server/routers.ts` (nouveau router `agent`, après le router `detectors`)

- [ ] **Step 1: Ajouter le router `agent`**

Dans `server/routers.ts`, juste après la fermeture du router `detectors: router({ ... })` et avant la fermeture finale `})` de `appRouter`, insérer :

```ts
  // Agent CR autonome : réglages + statut (incrément 1).
  agent: router({
    status: medicalProcedure.query(async () => {
      const {
        getAgentSettings,
        countAiReportsSince,
        countPendingSignatureReports,
      } = await import("./db");
      const s = await getAgentSettings();
      const startOfToday = new Date();
      startOfToday.setHours(0, 0, 0, 0);
      return {
        enabled: s?.enabled ?? false,
        enabledAt: s?.enabledAt ?? null,
        dailyCap: s?.dailyCap ?? 20,
        generatedToday: await countAiReportsSince(startOfToday),
        pendingCount: await countPendingSignatureReports(),
      };
    }),
    configure: adminProcedure
      .input(
        z.object({
          enabled: z.boolean().optional(),
          dailyCap: z.number().int().min(1).max(500).optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const { updateAgentSettings } = await import("./db");
        await updateAgentSettings(input);
        await recordAccess({
          userId: ctx.user.id,
          action: "agent.configure",
          studyId: null,
          detail: `enabled=${input.enabled} cap=${input.dailyCap}`,
          ipAddress: ctx.req?.ip ?? null,
        });
        return { ok: true };
      }),
  }),
```

- [ ] **Step 2: Ajouter `countPendingSignatureReports` dans `server/db.ts`**

```ts
/** Nombre de brouillons IA en attente de signature (file à signer). */
export async function countPendingSignatureReports(): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const rows = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(reports)
    .where(and(eq(reports.aiGenerated, true), eq(reports.status, "draft")));
  return Number(rows[0]?.n ?? 0);
}
```

- [ ] **Step 3: Vérifier tsc**

Run: `npx tsc --noEmit` → aucune erreur.

- [ ] **Step 4: Commit**

```bash
git add server/routers.ts server/db.ts
git commit -m "feat(agent): tRPC agent.status + agent.configure"
```

---

### Task 5: tRPC `reports.pendingSignature` + `referringContacts`

**Files:**

- Modify: `server/routers.ts` (dans le router `reports`, + nouveau router `referringContacts`)
- Modify: `server/db.ts` (`listPendingSignatureReports`)

- [ ] **Step 1: Helper `listPendingSignatureReports` (db.ts)**

```ts
/** File à signer : brouillons IA non signés + infos étude (mono-cabinet). */
export async function listPendingSignatureReports(): Promise<
  {
    reportId: number;
    studyId: number;
    studyDescription: string | null;
    modality: string | null;
    studyDate: string | null;
    referringPhysician: string | null;
    createdAt: Date;
  }[]
> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db
    .select({
      reportId: reports.id,
      studyId: reports.studyId,
      studyDescription: studies.studyDescription,
      modality: studies.modality,
      studyDate: studies.studyDate,
      referringPhysician: studies.referringPhysician,
      createdAt: reports.createdAt,
    })
    .from(reports)
    .innerJoin(studies, eq(studies.id, reports.studyId))
    .where(and(eq(reports.aiGenerated, true), eq(reports.status, "draft")))
    .orderBy(desc(reports.createdAt));
  return rows;
}
```

- [ ] **Step 2: Endpoint `reports.pendingSignature`**

Dans le router `reports`, ajouter :

```ts
    pendingSignature: medicalProcedure.query(async () => {
      const { listPendingSignatureReports } = await import("./db");
      return { items: await listPendingSignatureReports() };
    }),
```

- [ ] **Step 3: Router `referringContacts`**

Après le router `agent`, ajouter :

```ts
  referringContacts: router({
    resolve: medicalProcedure
      .input(z.object({ name: z.string().max(256) }))
      .query(async ({ input }) => {
        const { resolveReferringEmail } = await import("./db");
        return { email: await resolveReferringEmail(input.name) };
      }),
    upsert: adminProcedure
      .input(z.object({ name: z.string().min(1).max(256), email: z.string().email() }))
      .mutation(async ({ input }) => {
        const { upsertReferringEmail } = await import("./db");
        await upsertReferringEmail(input.name, input.email);
        return { ok: true };
      }),
  }),
```

- [ ] **Step 4: Test anti-IDOR / contenu (db.test ou routers.test existant)**

Ajouter dans `server/db.agent.test.ts` un test que `listPendingSignatureReports` ne renvoie QUE des `aiGenerated && draft`. Comme il dépend de la DB, écrire à la place un test de la fonction de filtrage si elle est extraite ; sinon, valider via le test d'intégration de la Task 8. Marquer ce point dans le commit.

- [ ] **Step 5: tsc + commit**

Run: `npx tsc --noEmit` → aucune erreur.

```bash
git add server/routers.ts server/db.ts
git commit -m "feat(agent): reports.pendingSignature + referringContacts resolve/upsert"
```

---

### Task 6: `reports.signAndSend` — signature + envoi auto (garde dure)

**Files:**

- Modify: `server/routers.ts` (router `reports`)
- Test: `server/report/signAndSend.test.ts`

La logique : (1) signer en réutilisant le chemin de `sign` ; (2) résoudre l'e-mail (référent connu ou fourni + mémorisé) ; (3) appeler `sendStudyReportImpl`. **Garde dure** : aucun envoi tant que le report n'est pas `signed`.

- [ ] **Step 1: Extraire la garde dans une fonction pure testable**

Créer `server/report/signAndSend.test.ts` :

```ts
import { describe, it, expect } from "vitest";
import { assertSendable } from "./signAndSend";

describe("garde envoi : pas d'envoi sans signature", () => {
  it("refuse si non signé", () => {
    expect(() => assertSendable("draft", "dr@x.ch")).toThrow(/signé/i);
  });
  it("refuse si e-mail manquant", () => {
    expect(() => assertSendable("signed", null)).toThrow(/e-mail/i);
  });
  it("accepte si signé + e-mail", () => {
    expect(() => assertSendable("signed", "dr@x.ch")).not.toThrow();
  });
});
```

- [ ] **Step 2: Lancer (échoue)**

Run: `npx vitest run server/report/signAndSend.test.ts`
Expected: FAIL — module absent.

- [ ] **Step 3: Implémenter la garde**

Créer `server/report/signAndSend.ts` :

```ts
/** Garde dure : un CR ne part QUE s'il est signé ET qu'on a un e-mail. */
export function assertSendable(status: string, email: string | null): void {
  if (status !== "signed") {
    throw new Error("Envoi refusé : le compte-rendu doit être signé.");
  }
  if (!email) {
    throw new Error("Envoi refusé : e-mail du référent requis.");
  }
}
```

- [ ] **Step 4: Lancer (passe)**

Run: `npx vitest run server/report/signAndSend.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Endpoint `reports.signAndSend`**

Dans le router `reports`, ajouter (réutilise la logique de `sign` : `validateReportSections`, `canSignReport`, `buildReportPdf`, `storagePut`, puis `sendStudyReportImpl`) :

```ts
    signAndSend: adminProcedure
      .input(
        z.object({
          reportId: z.number(),
          recipientEmail: z.string().email().optional(),
          windowCenter: z.number().finite().default(40),
          windowWidth: z.number().finite().default(400),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const { getDb, getStudyById, upsertReferringEmail, resolveReferringEmail } =
          await import("./db");
        const { reports } = await import("../drizzle/schema");
        const { eq } = await import("drizzle-orm");
        const { assertSendable } = await import("./report/signAndSend");
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

        const rows = await db
          .select()
          .from(reports)
          .where(eq(reports.id, input.reportId))
          .limit(1);
        const report = rows[0];
        if (!report) throw new TRPCError({ code: "NOT_FOUND" });
        const sections = validateReportSections(report);
        const study = (await getStudyById(report.studyId)) as any;

        // Résolution e-mail AVANT signature (échoue tôt si introuvable).
        const email =
          input.recipientEmail ??
          (await resolveReferringEmail(study?.referringPhysician));
        if (!email) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "E-mail du référent requis (renseignez-le).",
          });
        }
        if (input.recipientEmail && study?.referringPhysician) {
          await upsertReferringEmail(study.referringPhysician, input.recipientEmail);
        }

        // Signer (si pas déjà signé).
        if (report.status !== "signed") {
          if (!canSignReport(report.status as any, sections)) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "Conclusion requise pour signer.",
            });
          }
          const signedAt = new Date();
          const signature = `Signé par ${ctx.user.name ?? "Dr"} le ${signedAt.toLocaleString("fr-CH")}`;
          const pdf = buildReportPdf({
            study,
            report: sections,
            signature,
            keyImages: [],
            aiAssisted: report.aiGenerated,
          });
          const { key } = await storagePut(
            `reports/${report.studyId}/report-${report.id}.pdf`,
            pdf,
            "application/pdf"
          );
          await db
            .update(reports)
            .set({ status: "signed", signedBy: ctx.user.id, signedAt, pdfStorageKey: key })
            .where(eq(reports.id, report.id));
          await recordAccess({
            userId: ctx.user.id,
            action: "report.sign",
            studyId: report.studyId,
            detail: `report ${report.id} (signAndSend)`,
            ipAddress: ctx.req?.ip ?? null,
          });
        }

        // Garde dure puis envoi via le canal sécurisé existant.
        assertSendable("signed", email);
        const series = await (await import("./db")).listSeriesByStudy(report.studyId);
        const { sendStudyReportImpl } = await import("./report/sendStudyReport");
        await sendStudyReportImpl(
          {
            to: email,
            studyId: report.studyId,
            seriesId: (series as any)[0]?.id ?? 0,
            windowCenter: input.windowCenter,
            windowWidth: input.windowWidth,
            keyImages: [],
            includeVideo: false,
            aiAssisted: report.aiGenerated,
          } as any,
          ctx as any
        );
        return { ok: true, email };
      }),
```

- [ ] **Step 6: tsc + lancer la suite ciblée + commit**

Run: `npx tsc --noEmit` → aucune erreur.
Run: `npx vitest run server/report/signAndSend.test.ts` → PASS.

```bash
git add server/routers.ts server/report/signAndSend.ts server/report/signAndSend.test.ts
git commit -m "feat(agent): reports.signAndSend (signature + envoi auto référent, garde dure)"
```

---

### Task 7: UI — File à signer + « Signer & envoyer » + réglages agent

**Files:**

- Create: `client/src/components/PendingSignatureList.tsx`
- Modify: `client/src/components/ReportPanel.tsx` (bouton « Signer & envoyer »)
- Modify: le composant de réglages admin (suivre le pattern existant des réglages PACS/knowledge — repérer via `grep -rn "knowledge.syncVault\|pacsServers" client/src`) pour ajouter un panneau Agent.

- [ ] **Step 1: Liste « File à signer »**

Créer `client/src/components/PendingSignatureList.tsx` : un composant qui appelle `trpc.reports.pendingSignature.useQuery()` et affiche un tableau (patient/étude, modalité, date, référent ou « à renseigner ») ; chaque ligne a un bouton « Ouvrir » qui navigue vers l'étude et ouvre le `ReportPanel` (réutiliser le mécanisme d'ouverture d'étude existant — repérer via `grep -rn "selectedStudy\|openStudy\|setStudyId" client/src`). Badge « Brouillon IA — à valider ».

```tsx
import { trpc } from "../lib/trpc"; // adapter au chemin réel du client trpc

export function PendingSignatureList({
  onOpen,
}: {
  onOpen: (studyId: number) => void;
}) {
  const q = trpc.reports.pendingSignature.useQuery();
  if (q.isLoading)
    return <p className="text-sm text-muted-foreground">Chargement…</p>;
  const items = q.data?.items ?? [];
  if (!items.length)
    return (
      <p className="text-sm text-muted-foreground">
        Aucun brouillon en attente.
      </p>
    );
  return (
    <div className="space-y-2">
      <h3 className="font-bold text-sm">File à signer ({items.length})</h3>
      <ul className="divide-y divide-border">
        {items.map(it => (
          <li
            key={it.reportId}
            className="flex items-center justify-between gap-2 py-2"
          >
            <div className="text-sm">
              <span className="font-medium">
                {it.studyDescription || `Étude ${it.studyId}`}
              </span>
              <span className="text-muted-foreground">
                {" "}
                · {it.modality || "?"} · {it.studyDate || ""}
              </span>
              <div className="text-[11px] text-amber-500">
                Brouillon IA — à valider · réf.{" "}
                {it.referringPhysician || "à renseigner"}
              </div>
            </div>
            <button
              className="text-[11px] rounded bg-primary/15 text-primary px-2 py-1"
              onClick={() => onOpen(it.studyId)}
            >
              Ouvrir
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 2: Bouton « Signer & envoyer » dans `ReportPanel.tsx`**

À côté du bouton de signature existant, ajouter un bouton qui : pré-remplit l'e-mail référent via `trpc.referringContacts.resolve.useQuery({ name: referringPhysician })`, et appelle `trpc.reports.signAndSend.useMutation()`. Si l'e-mail est absent, afficher le champ « Email du confrère » (déjà présent dans le composant, variable `to`) comme `recipientEmail`. Passer `windowCenter`/`windowWidth` courants.

```tsx
// pseudo-intégration dans ReportPanel (adapter aux hooks/vars existants : reportId, to, windowCenter, windowWidth)
const signAndSend = trpc.reports.signAndSend.useMutation();
// ...
<button
  disabled={!sections.conclusion.trim() || signAndSend.isPending}
  onClick={async () => {
    await signAndSend.mutateAsync({
      reportId,
      recipientEmail: to || undefined,
      windowCenter,
      windowWidth,
    });
  }}
  className="text-[11px] rounded bg-emerald-600/20 text-emerald-400 px-2 py-1 disabled:opacity-50"
>
  Signer & envoyer au référent
</button>;
```

Note : si `signAndSend` renvoie l'erreur « E-mail du référent requis », mettre en évidence le champ e-mail (`to`) et réessayer après saisie.

- [ ] **Step 3: Panneau réglages Agent (admin)**

Dans le composant de réglages admin existant, ajouter une section « Agent CR autonome » : interrupteur ON/OFF (`trpc.agent.configure.useMutation({ enabled })`), champ plafond/jour (`dailyCap`), et affichage `trpc.agent.status.useQuery()` (activé, générés aujourd'hui, en attente). Avertissement visible : « N'envoie jamais sans signature du médecin ».

- [ ] **Step 4: Build client + commit**

Run: `npx tsc --noEmit` → aucune erreur.
Run: `npm run build` (ou la commande de build du repo) → succès.

```bash
git add client/src/components/PendingSignatureList.tsx client/src/components/ReportPanel.tsx <fichier réglages>
git commit -m "feat(agent): UI File à signer + Signer&envoyer + réglages agent"
```

---

### Task 8: Vérification d'intégration + déploiement

**Files:** aucun (procédure)

- [ ] **Step 1: Suite complète**

Run: `npx tsc --noEmit && npx vitest run`
Expected: tsc clean, tous les tests verts (les nouveaux inclus).

- [ ] **Step 2: Appliquer la migration 0013 en prod (manuelle, AVANT le code)**

```bash
scp drizzle/0013_agent_cr.sql root@76.13.55.44:/tmp/
ssh root@76.13.55.44 'docker exec -i horos-db-1 sh -c "exec mysql -uroot -p\"\$MYSQL_ROOT_PASSWORD\" horos" < /tmp/0013_agent_cr.sql'
# vérifier : SHOW TABLES LIKE "agent_settings"; SHOW TABLES LIKE "referring_contacts";
```

- [ ] **Step 3: PR → merge → CI → déploiement**

Merge sur `self-host`, attendre la CI verte, puis sur le VPS : `docker pull` l'image du SHA + `sed` l'image dans `docker-compose.yml` + `docker compose up -d --force-recreate app`, puis vérifier `health 200` et `agent.status` (enabled=false par défaut).

- [ ] **Step 4: Vérification fonctionnelle**

Activer l'agent (`agent.configure { enabled: true, dailyCap: 5 }`), créer/attendre une nouvelle étude, vérifier qu'un brouillon `aiGenerated` apparaît dans `reports.pendingSignature`, l'ouvrir, signer & envoyer vers un e-mail de test, confirmer l'envoi dans l'audit. Désactiver l'agent si on ne veut pas qu'il tourne en continu.

---

## Self-review (effectué)

- **Couverture spec** : migration (T1), worker+plafond+idempotence+boot (T3), agent.status/configure (T4), pendingSignature + referringContacts (T5), signAndSend + garde (T6), UI (T7), tests (T2/T3/T6 + intégration T8). ✅
- **Correction mono-tenant** : pas de `cabinetId` ; `agent_settings` singleton (id=1) ; `referring_contacts` (name,email). Noté en tête. ✅
- **Cohérence des types** : `normalizeReferringName`, `getAgentSettings`, `findStudyIdsNeedingReport`, `countAiReportsSince`, `resolveReferringEmail`, `upsertReferringEmail`, `computeBatchSize`, `runAgentOnce`, `startAutoReportAgent`, `assertSendable`, `listPendingSignatureReports`, `countPendingSignatureReports` — noms cohérents entre tâches. ✅
- **Limites connues** : `reports.pendingSignature` n'a pas de test unitaire pur (dépend de la DB) → couvert par la vérif d'intégration T8 (documenté en T5/Step 4). Les helpers DB qui dépendent de la connexion ne sont pas testés unitairement (pattern du repo : seules les fonctions pures le sont) — `normalizeReferringName`, `computeBatchSize`, `assertSendable` le sont.
