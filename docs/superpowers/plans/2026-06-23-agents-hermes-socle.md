# Agents Hermès — Socle — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement task-by-task. Steps use checkbox (`- [ ]`).

**Goal:** Un registre d'agents Hermès : chaque agent a une fiche métier (rôle/objectifs/tâches/outils/accès/garde-fous) en code, un tool-gate qui impose les outils, des KPIs + santé + journal + mémoire en base, et une boucle d'auto-amélioration (suggestions proposées → validées). Rattache les 3 agents existants.

**Architecture:** Registre EN CODE (`server/agents/`) + tool-gate + tables d'état/journal/notes/suggestions/snapshots + tRPC `agents` + dashboard. Mono-tenant. Outils/accès en code (non éditables par l'UI). Améliorations jamais auto-appliquées.

**Tech Stack:** TS, Drizzle/MySQL, tRPC, React, Vitest. Migrations manuelles (retirer `--> statement-breakpoint` avant `mysql`). `new Date()` autorisé (runtime serveur).

---

### Task 1: Migration 0015 + schéma (5 tables)

**Files:** `drizzle/schema.ts`, `drizzle/0015_agents_socle.sql` (create)

- [ ] **Step 1: schéma** — append à `drizzle/schema.ts` :

```ts
/** État + réglages par agent Hermès (registre des fiches = code). */
export const agentState = mysqlTable("agent_state", {
  agentKey: varchar("agentKey", { length: 64 }).primaryKey(),
  enabled: boolean("enabled").notNull().default(false),
  targetsJson: text("targetsJson"),
  lastRunAt: timestamp("lastRunAt"),
  lastError: varchar("lastError", { length: 512 }),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
});
export type AgentState = typeof agentState.$inferSelect;

/** Journal d'activité par agent (santé + audit). */
export const agentActivity = mysqlTable(
  "agent_activity",
  {
    id: int("id").autoincrement().primaryKey(),
    agentKey: varchar("agentKey", { length: 64 }).notNull(),
    action: varchar("action", { length: 128 }).notNull(),
    studyId: int("studyId"),
    status: mysqlEnum("status", ["ok", "error", "skipped"]).notNull(),
    detail: varchar("detail", { length: 512 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  t => ({ agentIdx: index("agent_activity_agent_idx").on(t.agentKey) })
);
export type AgentActivity = typeof agentActivity.$inferSelect;

/** Mémoire d'agent : notes courtes d'amélioration. */
export const agentNotes = mysqlTable("agent_notes", {
  id: int("id").autoincrement().primaryKey(),
  agentKey: varchar("agentKey", { length: 64 }).notNull(),
  note: text("note").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type AgentNote = typeof agentNotes.$inferSelect;

/** Suggestions d'auto-amélioration (proposées → validées par le gérant). */
export const agentSuggestions = mysqlTable("agent_suggestions", {
  id: int("id").autoincrement().primaryKey(),
  agentKey: varchar("agentKey", { length: 64 }).notNull(),
  kpiKey: varchar("kpiKey", { length: 64 }).notNull(),
  gap: int("gap"),
  suggestion: text("suggestion").notNull(),
  status: mysqlEnum("status", ["open", "approved", "dismissed"])
    .notNull()
    .default("open"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type AgentSuggestion = typeof agentSuggestions.$inferSelect;

/** Snapshot du brouillon IA à la génération (pour mesurer signé-sans-correction). */
export const reportAiSnapshots = mysqlTable("report_ai_snapshots", {
  id: int("id").autoincrement().primaryKey(),
  studyId: int("studyId").notNull().unique(),
  sectionsJson: text("sectionsJson").notNull(),
  model: varchar("model", { length: 128 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type ReportAiSnapshot = typeof reportAiSnapshots.$inferSelect;
```

- [ ] **Step 2: migration** — créer `drizzle/0015_agents_socle.sql` (statements complets, AVEC `--> statement-breakpoint` pour la convention drizzle ; ils seront retirés à l'application manuelle en Task 10) :

```sql
CREATE TABLE `agent_state` (
	`agentKey` varchar(64) NOT NULL,
	`enabled` boolean NOT NULL DEFAULT false,
	`targetsJson` text,
	`lastRunAt` timestamp NULL,
	`lastError` varchar(512),
	`updatedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `agent_state_agentKey` PRIMARY KEY(`agentKey`)
);
--> statement-breakpoint
CREATE TABLE `agent_activity` (
	`id` int AUTO_INCREMENT NOT NULL,
	`agentKey` varchar(64) NOT NULL,
	`action` varchar(128) NOT NULL,
	`studyId` int,
	`status` enum('ok','error','skipped') NOT NULL,
	`detail` varchar(512),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `agent_activity_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `agent_activity_agent_idx` ON `agent_activity` (`agentKey`);
--> statement-breakpoint
CREATE TABLE `agent_notes` (
	`id` int AUTO_INCREMENT NOT NULL,
	`agentKey` varchar(64) NOT NULL,
	`note` text NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `agent_notes_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `agent_suggestions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`agentKey` varchar(64) NOT NULL,
	`kpiKey` varchar(64) NOT NULL,
	`gap` int,
	`suggestion` text NOT NULL,
	`status` enum('open','approved','dismissed') NOT NULL DEFAULT 'open',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `agent_suggestions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `report_ai_snapshots` (
	`id` int AUTO_INCREMENT NOT NULL,
	`studyId` int NOT NULL,
	`sectionsJson` text NOT NULL,
	`model` varchar(128),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `report_ai_snapshots_id` PRIMARY KEY(`id`),
	CONSTRAINT `report_ai_snapshots_studyId_unique` UNIQUE(`studyId`)
);
```

- [ ] **Step 3:** `npx tsc --noEmit` → clean.
- [ ] **Step 4: commit**

```bash
git add drizzle/schema.ts drizzle/0015_agents_socle.sql
git commit -m "feat(agents): schéma socle (state/activity/notes/suggestions/snapshots, mig 0015)"
```

---

### Task 2: Registre en code — `server/agents/registry.ts`

**Files:** Create `server/agents/registry.ts`, `server/agents/registry.test.ts`

- [ ] **Step 1: failing test**

```ts
import { describe, it, expect } from "vitest";
import { AGENTS, getAgentSpec } from "./registry";

describe("registre d'agents", () => {
  it("contient les 3 agents existants", () => {
    expect(AGENTS.map(a => a.key).sort()).toEqual([
      "copilote",
      "qualite",
      "redacteur",
    ]);
  });
  it("chaque agent a des outils, accès et au moins un KPI", () => {
    for (const a of AGENTS) {
      expect(a.tools.length).toBeGreaterThan(0);
      expect(a.access.length).toBeGreaterThan(0);
      expect(a.kpis.length).toBeGreaterThan(0);
    }
  });
  it("getAgentSpec renvoie la fiche ou null", () => {
    expect(getAgentSpec("redacteur")?.name).toBeTruthy();
    expect(getAgentSpec("inconnu")).toBeNull();
  });
});
```

Run → FAIL.

- [ ] **Step 2: implémenter** `server/agents/registry.ts`

```ts
export interface AgentKpi {
  key: string;
  label: string;
  target: number;
  unit: string;
  goal: "max" | "min";
}
export interface AgentSpec {
  key: string;
  name: string;
  role: string;
  objectives: string[];
  tasks: string[];
  tools: string[];
  access: string[];
  guardrails: string[];
  kpis: AgentKpi[];
}

export const AGENTS: AgentSpec[] = [
  {
    key: "redacteur",
    name: "Hermès Rédacteur",
    role: "Génère un brouillon de compte rendu à l'arrivée d'une étude.",
    objectives: [
      "Préparer des brouillons exploitables",
      "Faire gagner du temps au médecin",
    ],
    tasks: [
      "Analyser l'étude",
      "Rédiger un brouillon structuré",
      "Le placer dans la file à signer",
    ],
    tools: ["generateDraft"],
    access: ["study.read", "report.write_draft"],
    guardrails: [
      "Jamais de signature",
      "Jamais d'envoi",
      "Brouillon à valider par un médecin",
    ],
    kpis: [
      {
        key: "acceptanceRate",
        label: "Brouillons signés sans correction majeure",
        target: 70,
        unit: "%",
        goal: "max",
      },
      {
        key: "draftsPerDay",
        label: "Brouillons générés / jour",
        target: 10,
        unit: "",
        goal: "max",
      },
    ],
  },
  {
    key: "qualite",
    name: "Hermès Qualité",
    role: "Relit le brouillon (2e lecture) et signale les désaccords.",
    objectives: ["Réduire les erreurs", "Alerter sur les incohérences"],
    tasks: ["Vérifier la cohérence du CR", "Lever un désaccord si besoin"],
    tools: ["verifyDraft"],
    access: ["report.read"],
    guardrails: ["Aucune modification autonome du CR"],
    kpis: [
      {
        key: "disagreementConfirmedRate",
        label: "Désaccords confirmés par le médecin",
        target: 50,
        unit: "%",
        goal: "max",
      },
    ],
  },
  {
    key: "copilote",
    name: "Hermès Copilote",
    role: "Répond aux questions du médecin et explique les comptes rendus.",
    objectives: ["Expliquer le raisonnement", "Retrouver un dossier vite"],
    tasks: ["Chercher un patient", "Expliquer un CR"],
    tools: ["searchPatient", "explainReport"],
    access: ["patient.search", "report.read"],
    guardrails: ["Lecture seule", "Aucune action (signature/envoi/modif)"],
    kpis: [
      {
        key: "conversations",
        label: "Conversations",
        target: 1,
        unit: "",
        goal: "max",
      },
      {
        key: "avgLatencyMs",
        label: "Latence moyenne",
        target: 8000,
        unit: "ms",
        goal: "min",
      },
    ],
  },
];

export function getAgentSpec(key: string): AgentSpec | null {
  return AGENTS.find(a => a.key === key) ?? null;
}
```

Run test → PASS. `npx tsc --noEmit` → clean.

- [ ] **Step 3: commit**

```bash
git add server/agents/registry.ts server/agents/registry.test.ts
git commit -m "feat(agents): registre en code (AgentSpec + 3 fiches métier)"
```

---

### Task 3: Tool-gate — `server/agents/tools.ts`

**Files:** Create `server/agents/tools.ts`, `server/agents/tools.test.ts`

- [ ] **Step 1: failing test**

```ts
import { describe, it, expect } from "vitest";
import { assertToolAllowed } from "./tools";

describe("tool-gate", () => {
  it("autorise un outil déclaré dans la fiche", () => {
    expect(() => assertToolAllowed("redacteur", "generateDraft")).not.toThrow();
  });
  it("refuse un outil hors-fiche", () => {
    expect(() => assertToolAllowed("copilote", "generateDraft")).toThrow(
      /non autorisé/i
    );
  });
  it("refuse un agent inconnu", () => {
    expect(() => assertToolAllowed("inconnu", "x")).toThrow(/inconnu/i);
  });
});
```

Run → FAIL.

- [ ] **Step 2: implémenter** `server/agents/tools.ts`

```ts
import { getAgentSpec } from "./registry";

/** Impose la fiche métier : un agent ne peut utiliser QUE ses outils déclarés. */
export function assertToolAllowed(agentKey: string, toolKey: string): void {
  const spec = getAgentSpec(agentKey);
  if (!spec) throw new Error(`Agent inconnu : ${agentKey}`);
  if (!spec.tools.includes(toolKey)) {
    throw new Error(
      `Outil « ${toolKey} » non autorisé pour l'agent ${agentKey}`
    );
  }
}

export type ToolFn = (args: any) => Promise<any>;

/** Exécute un outil au nom d'un agent, après contrôle de la fiche. */
export async function runAgentTool(
  agentKey: string,
  toolKey: string,
  fn: ToolFn,
  args: any
): Promise<any> {
  assertToolAllowed(agentKey, toolKey);
  return fn(args);
}
```

Run test → PASS. `npx tsc --noEmit` → clean.

- [ ] **Step 3: commit**

```bash
git add server/agents/tools.ts server/agents/tools.test.ts
git commit -m "feat(agents): tool-gate (impose les outils de la fiche)"
```

---

### Task 4: Helpers DB état/journal/notes/snapshot — `server/agents/state.ts`

**Files:** Create `server/agents/state.ts`. Uses `getDb` from `../db` and tables from `../../drizzle/schema`.

- [ ] **Step 1: implémenter** `server/agents/state.ts`

```ts
import { getDb } from "../db";
import {
  agentState,
  agentActivity,
  agentNotes,
  reportAiSnapshots,
} from "../../drizzle/schema";
import { eq, desc } from "drizzle-orm";

export async function getAgentState(agentKey: string) {
  const db = await getDb();
  if (!db) return null;
  const rows = await db
    .select()
    .from(agentState)
    .where(eq(agentState.agentKey, agentKey))
    .limit(1);
  return rows[0] ?? null;
}

export async function setAgentState(
  agentKey: string,
  patch: { enabled?: boolean; targetsJson?: string; lastError?: string | null }
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const existing = await getAgentState(agentKey);
  if (existing) {
    await db
      .update(agentState)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(agentState.agentKey, agentKey));
  } else {
    await db
      .insert(agentState)
      .values({
        agentKey,
        enabled: patch.enabled ?? false,
        targetsJson: patch.targetsJson ?? null,
      });
  }
}

export async function logAgentActivity(
  agentKey: string,
  action: string,
  status: "ok" | "error" | "skipped",
  opts?: { studyId?: number; detail?: string }
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  try {
    await db.insert(agentActivity).values({
      agentKey,
      action,
      status,
      studyId: opts?.studyId ?? null,
      detail: opts?.detail?.slice(0, 512) ?? null,
    });
    if (status === "error") {
      await setAgentState(agentKey, {
        lastError: opts?.detail?.slice(0, 512) ?? "error",
      });
    }
  } catch {
    /* best-effort */
  }
}

export async function listAgentActivity(
  agentKey: string | undefined,
  limit = 50
) {
  const db = await getDb();
  if (!db) return [];
  const base = db.select().from(agentActivity);
  const rows = agentKey
    ? await base
        .where(eq(agentActivity.agentKey, agentKey))
        .orderBy(desc(agentActivity.createdAt))
        .limit(limit)
    : await base.orderBy(desc(agentActivity.createdAt)).limit(limit);
  return rows;
}

export async function addAgentNote(
  agentKey: string,
  note: string
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.insert(agentNotes).values({ agentKey, note });
}

export async function getAgentNotes(
  agentKey: string,
  limit = 10
): Promise<string[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db
    .select()
    .from(agentNotes)
    .where(eq(agentNotes.agentKey, agentKey))
    .orderBy(desc(agentNotes.createdAt))
    .limit(limit);
  return rows.map(r => r.note);
}

export async function recordReportSnapshot(
  studyId: number,
  sections: {
    indication: string;
    technique: string;
    resultats: string;
    conclusion: string;
  },
  model: string | null
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  try {
    await db.insert(reportAiSnapshots).values({
      studyId,
      sectionsJson: JSON.stringify(sections),
      model,
    });
  } catch {
    /* studyId unique : déjà capturé → ignore */
  }
}

export async function getReportSnapshot(studyId: number) {
  const db = await getDb();
  if (!db) return null;
  const rows = await db
    .select()
    .from(reportAiSnapshots)
    .where(eq(reportAiSnapshots.studyId, studyId))
    .limit(1);
  return rows[0] ?? null;
}
```

- [ ] **Step 2:** `npx tsc --noEmit` → clean.
- [ ] **Step 3: commit**

```bash
git add server/agents/state.ts
git commit -m "feat(agents): helpers état/journal/notes/snapshot"
```

---

### Task 5: Métriques — `server/agents/metrics.ts`

**Files:** Create `server/agents/metrics.ts`, `server/agents/metrics.test.ts`

- [ ] **Step 1: failing test** (fonctions PURES de calcul)

```ts
import { describe, it, expect } from "vitest";
import { acceptanceRate, sectionsChangedSignificantly } from "./metrics";

describe("métriques agents", () => {
  it("acceptanceRate = % signés sans correction majeure", () => {
    expect(acceptanceRate({ signed: 10, changedMajor: 3 })).toBe(70);
    expect(acceptanceRate({ signed: 0, changedMajor: 0 })).toBe(0);
  });
  it("détecte une correction majeure (diff > seuil)", () => {
    const a = {
      indication: "x",
      technique: "y",
      resultats: "long".repeat(50),
      conclusion: "RAS",
    };
    const b = {
      indication: "x",
      technique: "y",
      resultats: "completement different".repeat(50),
      conclusion: "anomalie majeure",
    };
    expect(sectionsChangedSignificantly(a, a)).toBe(false);
    expect(sectionsChangedSignificantly(a, b)).toBe(true);
  });
});
```

Run → FAIL.

- [ ] **Step 2: implémenter** `server/agents/metrics.ts`

```ts
type Sections = {
  indication: string;
  technique: string;
  resultats: string;
  conclusion: string;
};

/** Distance de similarité grossière (ratio de caractères communs début). */
function changeRatio(a: string, b: string): number {
  const x = (a ?? "").trim();
  const y = (b ?? "").trim();
  if (!x && !y) return 0;
  if (!x || !y) return 1;
  const max = Math.max(x.length, y.length);
  let same = 0;
  const min = Math.min(x.length, y.length);
  for (let i = 0; i < min; i++) if (x[i] === y[i]) same++;
  return 1 - same / max;
}

/** Correction MAJEURE si résultats OU conclusion ont changé de plus de 30 %. */
export function sectionsChangedSignificantly(
  draft: Sections,
  signed: Sections
): boolean {
  return (
    changeRatio(draft.resultats, signed.resultats) > 0.3 ||
    changeRatio(draft.conclusion, signed.conclusion) > 0.3
  );
}

export function acceptanceRate(input: {
  signed: number;
  changedMajor: number;
}): number {
  if (input.signed <= 0) return 0;
  return Math.round(((input.signed - input.changedMajor) / input.signed) * 100);
}

export interface AgentKpiValue {
  key: string;
  label: string;
  value: number;
  target: number;
  unit: string;
  goal: "max" | "min";
  onTarget: boolean;
}

/** Calcule les KPIs d'un agent (lecture base). Impur : à appeler côté serveur. */
export async function computeAgentKpis(
  agentKey: string
): Promise<AgentKpiValue[]> {
  const { getAgentSpec } = await import("./registry");
  const spec = getAgentSpec(agentKey);
  if (!spec) return [];
  const { getDb } = await import("../db");
  const db = await getDb();
  const out: AgentKpiValue[] = [];
  for (const k of spec.kpis) {
    let value = 0;
    if (db) {
      try {
        value = await computeOneKpi(db, agentKey, k.key);
      } catch {
        value = 0;
      }
    }
    const onTarget = k.goal === "max" ? value >= k.target : value <= k.target;
    out.push({
      key: k.key,
      label: k.label,
      value,
      target: k.target,
      unit: k.unit,
      goal: k.goal,
      onTarget,
    });
  }
  return out;
}

async function computeOneKpi(
  db: any,
  agentKey: string,
  kpiKey: string
): Promise<number> {
  const { reports, reportAiSnapshots, agentActivity } = await import(
    "../../drizzle/schema"
  );
  const { eq, and, sql } = await import("drizzle-orm");
  if (agentKey === "redacteur" && kpiKey === "acceptanceRate") {
    const signedRows = await db
      .select()
      .from(reports)
      .where(eq(reports.status, "signed"));
    let signed = 0;
    let changedMajor = 0;
    for (const r of signedRows) {
      const snap = await db
        .select()
        .from(reportAiSnapshots)
        .where(eq(reportAiSnapshots.studyId, r.studyId))
        .limit(1);
      if (!snap[0]) continue;
      signed++;
      const draft = JSON.parse(snap[0].sectionsJson);
      if (sectionsChangedSignificantly(draft, r)) changedMajor++;
    }
    return acceptanceRate({ signed, changedMajor });
  }
  if (agentKey === "redacteur" && kpiKey === "draftsPerDay") {
    const since = new Date();
    since.setHours(0, 0, 0, 0);
    const rows = await db
      .select({ n: sql`COUNT(*)` })
      .from(agentActivity)
      .where(
        and(
          eq(agentActivity.agentKey, "redacteur"),
          eq(agentActivity.action, "generateDraft")
        )
      );
    return Number(rows[0]?.n ?? 0);
  }
  if (agentKey === "copilote" && kpiKey === "conversations") {
    const rows = await db
      .select({ n: sql`COUNT(*)` })
      .from(agentActivity)
      .where(
        and(
          eq(agentActivity.agentKey, "copilote"),
          eq(agentActivity.action, "chat")
        )
      );
    return Number(rows[0]?.n ?? 0);
  }
  return 0;
}
```

Run test → PASS (les fonctions pures). `npx tsc --noEmit` → clean.

- [ ] **Step 3: commit**

```bash
git add server/agents/metrics.ts server/agents/metrics.test.ts
git commit -m "feat(agents): métriques KPI (acceptanceRate, diff snapshot↔signé)"
```

---

### Task 6: Boucle d'auto-amélioration — `server/agents/improve.ts`

**Files:** Create `server/agents/improve.ts`, `server/agents/improve.test.ts`

- [ ] **Step 1: failing test**

```ts
import { describe, it, expect } from "vitest";
import { kpiNeedsImprovement } from "./improve";

describe("auto-amélioration", () => {
  it("max sous la cible → à améliorer", () => {
    expect(kpiNeedsImprovement({ value: 55, target: 70, goal: "max" })).toBe(
      true
    );
    expect(kpiNeedsImprovement({ value: 80, target: 70, goal: "max" })).toBe(
      false
    );
  });
  it("min au-dessus de la cible → à améliorer", () => {
    expect(
      kpiNeedsImprovement({ value: 12000, target: 8000, goal: "min" })
    ).toBe(true);
    expect(
      kpiNeedsImprovement({ value: 5000, target: 8000, goal: "min" })
    ).toBe(false);
  });
});
```

Run → FAIL.

- [ ] **Step 2: implémenter** `server/agents/improve.ts`

```ts
export function kpiNeedsImprovement(k: {
  value: number;
  target: number;
  goal: "max" | "min";
}): boolean {
  return k.goal === "max" ? k.value < k.target : k.value > k.target;
}

/** Texte de suggestion par défaut selon l'agent/KPI (sans LLM, déterministe). */
export function defaultSuggestion(agentKey: string, kpiKey: string): string {
  if (agentKey === "redacteur" && kpiKey === "acceptanceRate")
    return "Taux d'acceptation bas : revoir le prompt et les fiches RAG des modalités les plus corrigées ; comparer brouillons↔signés récents.";
  if (agentKey === "copilote" && kpiKey === "avgLatencyMs")
    return "Latence élevée : garder le modèle chaud (keep_alive -1), réduire le contexte injecté, envisager un modèle local plus rapide.";
  return `KPI ${kpiKey} de l'agent ${agentKey} sous l'objectif : analyser les activités récentes et ajuster la configuration.`;
}

/** Calcule et persiste les suggestions ouvertes pour un agent. */
export async function computeSuggestions(agentKey: string): Promise<number> {
  const { computeAgentKpis } = await import("./metrics");
  const { getDb } = await import("../db");
  const { agentSuggestions } = await import("../../drizzle/schema");
  const { and, eq } = await import("drizzle-orm");
  const kpis = await computeAgentKpis(agentKey);
  const db = await getDb();
  if (!db) return 0;
  let created = 0;
  for (const k of kpis) {
    if (!kpiNeedsImprovement(k)) continue;
    // éviter les doublons ouverts pour le même kpi
    const existing = await db
      .select()
      .from(agentSuggestions)
      .where(
        and(
          eq(agentSuggestions.agentKey, agentKey),
          eq(agentSuggestions.kpiKey, k.key),
          eq(agentSuggestions.status, "open")
        )
      )
      .limit(1);
    if (existing[0]) continue;
    await db.insert(agentSuggestions).values({
      agentKey,
      kpiKey: k.key,
      gap: Math.round(
        k.goal === "max" ? k.target - k.value : k.value - k.target
      ),
      suggestion: defaultSuggestion(agentKey, k.key),
      status: "open",
    });
    created++;
  }
  return created;
}
```

Run test → PASS. `npx tsc --noEmit` → clean.

- [ ] **Step 3: commit**

```bash
git add server/agents/improve.ts server/agents/improve.test.ts
git commit -m "feat(agents): boucle d'auto-amélioration (suggestions proposées)"
```

---

### Task 7: tRPC `agents` router

**Files:** `server/routers.ts`

- [ ] **Step 1:** ajouter un sous-router `agents` (sibling de `hermes`), inséré avant le `});` final de `appRouter` :

```ts
  agentsRegistry: router({
    list: medicalProcedure.query(async () => {
      const { AGENTS } = await import("./agents/registry");
      const { getAgentState } = await import("./agents/state");
      const { computeAgentKpis } = await import("./agents/metrics");
      const out = [];
      for (const spec of AGENTS) {
        const state = await getAgentState(spec.key);
        const kpis = await computeAgentKpis(spec.key);
        out.push({ spec, state, kpis });
      }
      return { agents: out };
    }),
    configure: adminProcedure
      .input(z.object({ agentKey: z.string().max(64), enabled: z.boolean().optional(), targetsJson: z.string().max(4000).optional() }))
      .mutation(async ({ input, ctx }) => {
        const { setAgentState } = await import("./agents/state");
        await setAgentState(input.agentKey, { enabled: input.enabled, targetsJson: input.targetsJson });
        await recordAccess({ userId: ctx.user.id, action: "agents.configure", studyId: null, detail: input.agentKey, ipAddress: ctx.req?.ip ?? null });
        return { ok: true };
      }),
    activity: medicalProcedure
      .input(z.object({ agentKey: z.string().max(64).optional(), limit: z.number().int().min(1).max(200).default(50) }))
      .query(async ({ input }) => {
        const { listAgentActivity } = await import("./agents/state");
        return { items: await listAgentActivity(input.agentKey, input.limit) };
      }),
    suggestions: medicalProcedure.query(async () => {
      const { getDb } = await import("./db");
      const { agentSuggestions } = await import("../drizzle/schema");
      const { eq, desc } = await import("drizzle-orm");
      const db = await getDb();
      if (!db) return { items: [] };
      const items = await db.select().from(agentSuggestions).where(eq(agentSuggestions.status, "open")).orderBy(desc(agentSuggestions.createdAt));
      return { items };
    }),
    refreshSuggestions: adminProcedure.mutation(async () => {
      const { AGENTS } = await import("./agents/registry");
      const { computeSuggestions } = await import("./agents/improve");
      let created = 0;
      for (const a of AGENTS) created += await computeSuggestions(a.key);
      return { created };
    }),
    resolveSuggestion: adminProcedure
      .input(z.object({ id: z.number().int(), action: z.enum(["approved", "dismissed"]) }))
      .mutation(async ({ input, ctx }) => {
        const { getDb } = await import("./db");
        const { agentSuggestions } = await import("../drizzle/schema");
        const { eq } = await import("drizzle-orm");
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        await db.update(agentSuggestions).set({ status: input.action }).where(eq(agentSuggestions.id, input.id));
        await recordAccess({ userId: ctx.user.id, action: "agents.resolveSuggestion", studyId: null, detail: `${input.id}:${input.action}`, ipAddress: ctx.req?.ip ?? null });
        return { ok: true };
      }),
  }),
```

(router nommé `agentsRegistry` pour ne pas entrer en collision avec le router `agent` existant de l'agent CR.)

- [ ] **Step 2:** `npx tsc --noEmit` → clean.
- [ ] **Step 3: commit**

```bash
git add server/routers.ts
git commit -m "feat(agents): tRPC agentsRegistry (list/configure/activity/suggestions)"
```

---

### Task 8: Rattacher les agents existants (logs + snapshot)

**Files:** `server/report/autoReportAgent.ts`, `server/report/hermesChat.ts`

- [ ] **Step 1: Rédacteur** — dans `server/report/autoReportAgent.ts`, fonction `generateForStudy`, après l'`insert` réussi du report, ajouter :

```ts
const { logAgentActivity, recordReportSnapshot } = await import(
  "../agents/state"
);
await recordReportSnapshot(
  studyId,
  {
    indication: (res as any).indication ?? "",
    technique: (res as any).technique ?? "",
    resultats: (res as any).resultats ?? "",
    conclusion: (res as any).conclusion ?? "",
  },
  (res as any).model ?? null
);
await logAgentActivity("redacteur", "generateDraft", "ok", { studyId });
```

Et dans le `catch` de `runAgentOnce` (échec étude), ajouter `await (await import("../agents/state")).logAgentActivity("redacteur", "generateDraft", "error", { studyId: id, detail: (e as Error)?.message });`

- [ ] **Step 2: Copilote** — dans `server/report/hermesChat.ts`, fonction `runHermesChat`, juste avant le `return`, ajouter (fail-soft) :

```ts
try {
  const { logAgentActivity } = await import("../agents/state");
  await logAgentActivity("copilote", "chat", "ok", {
    studyId: (input as any).studyId,
  });
} catch {
  /* best-effort */
}
```

- [ ] **Step 3:** `npx tsc --noEmit` → clean. Lancer les tests existants des deux modules : `npx vitest run server/report/autoReportAgent.test.ts server/report/hermesChat.test.ts` → PASS.

- [ ] **Step 4: commit**

```bash
git add server/report/autoReportAgent.ts server/report/hermesChat.ts
git commit -m "feat(agents): rattachement Rédacteur (snapshot+log) et Copilote (log)"
```

---

### Task 9: UI — `AgentsDashboard.tsx`

**Files:** Create `client/src/components/AgentsDashboard.tsx`, wire dans `client/src/pages/Home.tsx`

- [ ] **Step 1: explorer** — `grep -n "AgentCrSettings\|@/lib/trpc\|Separator" client/src/pages/Home.tsx` pour le pattern d'import trpc + emplacement réglages.
- [ ] **Step 2: composant** — créer `client/src/components/AgentsDashboard.tsx` :

```tsx
import { trpc } from "@/lib/trpc";

export function AgentsDashboard() {
  const list = trpc.agentsRegistry.list.useQuery();
  const suggestions = trpc.agentsRegistry.suggestions.useQuery();
  const configure = trpc.agentsRegistry.configure.useMutation({
    onSuccess: () => list.refetch(),
  });
  const refresh = trpc.agentsRegistry.refreshSuggestions.useMutation({
    onSuccess: () => suggestions.refetch(),
  });
  const resolve = trpc.agentsRegistry.resolveSuggestion.useMutation({
    onSuccess: () => suggestions.refetch(),
  });
  const agents = list.data?.agents ?? [];
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="font-bold text-sm">Agents Hermès</h3>
        <button
          className="text-[11px] rounded bg-muted/50 px-2 py-1"
          onClick={() => refresh.mutate()}
        >
          Analyser
        </button>
      </div>
      {agents.map(a => (
        <div
          key={a.spec.key}
          className="rounded border border-border p-2 space-y-1"
        >
          <div className="flex items-center justify-between">
            <span className="font-medium text-sm">{a.spec.name}</span>
            <label className="text-[11px] flex items-center gap-1">
              <input
                type="checkbox"
                checked={a.state?.enabled ?? false}
                onChange={e =>
                  configure.mutate({
                    agentKey: a.spec.key,
                    enabled: e.target.checked,
                  })
                }
              />
              actif
            </label>
          </div>
          <p className="text-[11px] text-muted-foreground">{a.spec.role}</p>
          <div className="text-[11px]">
            Outils : {a.spec.tools.join(", ")} · Accès :{" "}
            {a.spec.access.join(", ")}
          </div>
          <div className="flex flex-wrap gap-2">
            {a.kpis.map(k => (
              <span
                key={k.key}
                className={`text-[11px] rounded px-1.5 py-0.5 ${k.onTarget ? "bg-emerald-500/15 text-emerald-400" : "bg-amber-500/15 text-amber-500"}`}
              >
                {k.label} : {k.value}
                {k.unit} / {k.target}
                {k.unit}
              </span>
            ))}
          </div>
          <ul className="text-[10px] text-muted-foreground list-disc pl-4">
            {a.spec.guardrails.map(g => (
              <li key={g}>{g}</li>
            ))}
          </ul>
        </div>
      ))}
      {(suggestions.data?.items ?? []).length > 0 && (
        <div className="space-y-1">
          <h4 className="text-xs font-semibold">Suggestions d'amélioration</h4>
          {(suggestions.data?.items ?? []).map((s: any) => (
            <div
              key={s.id}
              className="rounded border border-amber-500/40 p-2 text-[11px] space-y-1"
            >
              <div>{s.suggestion}</div>
              <div className="flex gap-2">
                <button
                  className="rounded bg-emerald-500/15 text-emerald-400 px-2 py-0.5"
                  onClick={() =>
                    resolve.mutate({ id: s.id, action: "approved" })
                  }
                >
                  Approuver
                </button>
                <button
                  className="rounded bg-muted/50 px-2 py-0.5"
                  onClick={() =>
                    resolve.mutate({ id: s.id, action: "dismissed" })
                  }
                >
                  Ignorer
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: wiring** — dans `client/src/pages/Home.tsx`, importer et rendre `<AgentsDashboard />` dans la sidebar admin, à côté de `<AgentCrSettings />` (avec un `<Separator />`).
- [ ] **Step 4:** `npx tsc --noEmit` clean ; `npm run build` succès. Commit :

```bash
git add -A
git commit -m "feat(agents): dashboard agents (fiches + KPIs + santé + suggestions)"
```

---

### Task 10: Intégration + migration + déploiement

- [ ] **Step 1:** `npx tsc --noEmit && npx vitest run` → clean + tous verts.
- [ ] **Step 2: migration 0015 en prod (SANS les marqueurs drizzle)** — exécuter les 5 `CREATE TABLE` + l'index, sans les lignes `--> statement-breakpoint` :

```bash
ssh root@76.13.55.44 'docker exec -i horos-db-1 sh -c "exec mysql -uroot -p\"\$MYSQL_ROOT_PASSWORD\" horos"' <<'SQL'
<coller les CREATE TABLE/INDEX du fichier 0015, marqueurs retirés>
SQL
```

Vérifier `SHOW TABLES LIKE "agent_%"` et `report_ai_snapshots`.

- [ ] **Step 3:** PR `docs/agents-hermes-socle` → `self-host`, merge, CI verte, déployer (pull image SHA + sed compose + up -d --force-recreate app), health 200.
- [ ] **Step 4: vérification fonctionnelle** : `agentsRegistry.list` renvoie 3 agents avec fiches + KPIs ; `refreshSuggestions` ne crée des suggestions que pour les KPIs sous cible ; le tool-gate refuse un outil hors-fiche (déjà prouvé en test). Le dashboard s'affiche dans Home.

---

## Self-review

- Couverture spec : registre code (T2), tool-gate imposé (T3), tables état/journal/notes/suggestions/snapshots (T1), métriques+capture (T5/T8), boucle proposée→validée (T6/T7), dashboard santé+KPIs+suggestions (T9), rattachement 3 agents (T8 — Qualité est déjà tracé via la double-lecture du Rédacteur ; log explicite Qualité = optionnel, noté), mémoire d'agent (T4 addAgentNote/getAgentNotes ; réinjection contexte = utilisée par les sous-projets agents). ✅
- Non-objectifs respectés : pas d'auto-application (suggestions open→approved/dismissed), outils/accès en code, mono-tenant, garde-fous intacts. ✅
- Cohérence noms : `AgentSpec/getAgentSpec`, `assertToolAllowed/runAgentTool`, `getAgentState/setAgentState/logAgentActivity/recordReportSnapshot/addAgentNote`, `computeAgentKpis/acceptanceRate/sectionsChangedSignificantly`, `kpiNeedsImprovement/computeSuggestions`, router `agentsRegistry`. ✅
- Limite connue : router nommé `agentsRegistry` (et pas `agents`) pour éviter la collision avec le router `agent` existant — UI utilise `trpc.agentsRegistry.*`. Mémoire d'agent (notes) câblée au socle mais sa réinjection dans les prompts est exploitée par les sous-projets agents (Apprentissage). KPI `disagreementConfirmedRate` (Qualité) et `avgLatencyMs` (Copilote) renvoient 0 tant que la capture dédiée n'est pas ajoutée — affichés mais non bloquants ; `computeOneKpi` retourne 0 par défaut (documenté).
