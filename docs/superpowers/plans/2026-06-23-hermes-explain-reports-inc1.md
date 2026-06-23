# Hermès explique les CR — Incrément 1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement task-by-task. Steps use checkbox (`- [ ]`).

**Goal:** Demander à l'assistant Hermès le CR d'un patient par son nom ; il le retrouve (recherche chiffrée rapide), charge le CR, et explique son raisonnement en citant les critères (RAG). Modèle Gemini-Vertex-UE avec repli local.

**Architecture:** Réutilise l'assistant Hermès existant (`server/report/hermesChat.ts`, `HermesChatPanel`). Ajoute un blind-index `patients.nameSearch` (empreinte déterministe du nom normalisé) pour la recherche, un backend chat Vertex (UE) avec repli Ollama, un enrichissement RAG du contexte, et un endpoint de recherche. Mono-tenant. Lecture seule.

**Tech Stack:** TS, Drizzle/MySQL, tRPC, React, Vitest. Migrations manuelles (retirer `--> statement-breakpoint` avant `mysql`).

---

### Task 1: Migration 0014 + colonne `nameSearch` + écriture à l'upsert

**Files:** `drizzle/schema.ts`, `drizzle/0014_patient_name_index.sql` (create), `server/db.ts`

- [ ] **Step 1: schéma** — dans `drizzle/schema.ts`, table `patients`, ajouter le champ après `sex` :

```ts
    // Blind index : empreinte DÉTERMINISTE du nom normalisé → recherche par nom
    // sans déchiffrer toute la base (le nom reste chiffré dans patientName).
    nameSearch: varchar("nameSearch", { length: 255 }),
```

et dans l'objet d'index (callback `t =>`), ajouter : `nameSearchIdx: index("patients_nameSearch_idx").on(t.nameSearch),`

- [ ] **Step 2: migration** — créer `drizzle/0014_patient_name_index.sql` :

```sql
ALTER TABLE `patients` ADD COLUMN `nameSearch` varchar(255);
CREATE INDEX `patients_nameSearch_idx` ON `patients` (`nameSearch`);
```

- [ ] **Step 3: helpers normalize + clé** — dans `server/db.ts`, ajouter près des helpers agent :

```ts
/** Normalise un nom (casse/espaces/accents/^) pour la recherche. */
export function normalizeName(name?: string | null): string {
  if (!name) return "";
  return name
    .replace(/\^/g, " ")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Empreinte déterministe chiffrée du nom normalisé (blind index). */
export function nameSearchKey(name?: string | null): string | null {
  const n = normalizeName(name);
  if (!n) return null;
  return encryptDeterministic(n);
}
```

(`encryptDeterministic` est déjà importé dans db.ts.)

- [ ] **Step 4: upsertPatient renseigne nameSearch** — dans `upsertPatient`, à l'`insert`, ajouter `nameSearch: nameSearchKey(patientData.patientName),` dans l'objet `.values({...})`.

- [ ] **Step 5: test du helper** — créer `server/db.nameSearch.test.ts` :

```ts
import { describe, it, expect } from "vitest";
import { normalizeName } from "./db";
describe("normalizeName", () => {
  it("normalise casse/accents/espaces/^", () => {
    expect(normalizeName("  POCINCI^Zehra ")).toBe("pocinci zehra");
    expect(normalizeName("Éva  SON")).toBe("eva son");
  });
  it("vide si vide", () => {
    expect(normalizeName(null)).toBe("");
  });
});
```

Run `npx vitest run server/db.nameSearch.test.ts` → PASS. `npx tsc --noEmit` → clean.

- [ ] **Step 6: commit**

```bash
git add drizzle/schema.ts drizzle/0014_patient_name_index.sql server/db.ts server/db.nameSearch.test.ts
git commit -m "feat(hermes): blind index nameSearch + helpers (mig 0014)"
```

---

### Task 2: Backfill `nameSearch` des patients existants

**Files:** `scripts/backfill-name-search.mjs` (create)

- [ ] **Step 1: script** — créer `scripts/backfill-name-search.mjs` (lancé DANS le conteneur app, `-w /app`, comme les seeds RAG). Il lit chaque patient, déchiffre le nom via le module crypto compilé, calcule la clé, met à jour. PROBLÈME : crypto/normalize sont en TS bundlé. SOLUTION : exposer une procédure admin tRPC plutôt qu'un script hors-bundle.

REMPLACER l'approche script par un endpoint admin (plus simple, réutilise le code en place) :

- [ ] **Step 2: endpoint de backfill** — dans `server/routers.ts`, sous un router `hermes` (créé en Task 3) OU dans `agent`, ajouter une mutation adminProcedure `backfillNameSearch` :

```ts
    backfillNameSearch: adminProcedure.mutation(async () => {
      const { backfillPatientNameSearch } = await import("./db");
      return { updated: await backfillPatientNameSearch() };
    }),
```

- [ ] **Step 3: helper db** — dans `server/db.ts` :

```ts
/** Recalcule nameSearch pour tous les patients (idempotent). */
export async function backfillPatientNameSearch(): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const rows = await db.select().from(patients);
  let updated = 0;
  for (const p of rows) {
    const name = decryptField(p.patientName);
    const key = nameSearchKey(name);
    if (key && key !== p.nameSearch) {
      await db
        .update(patients)
        .set({ nameSearch: key })
        .where(eq(patients.id, p.id));
      updated++;
    }
  }
  return updated;
}
```

- [ ] **Step 4:** `npx tsc --noEmit` clean. Commit :

```bash
git add server/db.ts server/routers.ts
git commit -m "feat(hermes): backfill nameSearch (endpoint admin)"
```

(L'appel réel se fait après déploiement, en Task 6.)

---

### Task 3: Recherche patient + endpoint `hermes.findPatientReport`

**Files:** `server/db.ts`, `server/routers.ts`

- [ ] **Step 1: helper recherche** — `server/db.ts` :

```ts
/** Recherche patients par nom (blind index exact, mono-cabinet). Lecture seule. */
export async function searchPatientsByName(
  query: string
): Promise<
  {
    patientId: number;
    patientName: string;
    studyId: number | null;
    reportStatus: string | null;
  }[]
> {
  const key = nameSearchKey(query);
  if (!key) return [];
  const db = await getDb();
  if (!db) return [];
  const pts = await db
    .select()
    .from(patients)
    .where(eq(patients.nameSearch, key))
    .limit(10);
  const out: {
    patientId: number;
    patientName: string;
    studyId: number | null;
    reportStatus: string | null;
  }[] = [];
  for (const p of pts) {
    const st = await db
      .select({ id: studies.id })
      .from(studies)
      .where(eq(studies.patientId, p.id))
      .orderBy(desc(studies.createdAt))
      .limit(1);
    const studyId = st[0]?.id ?? null;
    let reportStatus: string | null = null;
    if (studyId) {
      const r = await db
        .select({ status: reports.status })
        .from(reports)
        .where(eq(reports.studyId, studyId))
        .limit(1);
      reportStatus = r[0]?.status ?? null;
    }
    out.push({
      patientId: p.id,
      patientName: decryptField(p.patientName) ?? "",
      studyId,
      reportStatus,
    });
  }
  return out;
}
```

- [ ] **Step 2: router hermes** — dans `server/routers.ts`, ajouter (sibling de `agent`) :

```ts
  hermes: router({
    findPatientReport: medicalProcedure
      .input(z.object({ query: z.string().min(1).max(120) }))
      .query(async ({ input, ctx }) => {
        const { searchPatientsByName } = await import("./db");
        const results = await searchPatientsByName(input.query);
        await recordAccess({
          userId: ctx.user.id,
          action: "hermes.find",
          studyId: null,
          detail: `n=${results.length}`,
          ipAddress: ctx.req?.ip ?? null,
        });
        return { results };
      }),
    backfillNameSearch: adminProcedure.mutation(async () => {
      const { backfillPatientNameSearch } = await import("./db");
      return { updated: await backfillPatientNameSearch() };
    }),
  }),
```

- [ ] **Step 3:** `npx tsc --noEmit` clean. Commit :

```bash
git add server/db.ts server/routers.ts
git commit -m "feat(hermes): recherche patient par nom + findPatientReport"
```

---

### Task 4: Backend Vertex (UE) + modèle chaud + contexte RAG

**Files:** `server/_core/env.ts`, `server/report/hermesChat.ts`

- [ ] **Step 1: ENV** — `server/_core/env.ts`, ajouter :

```ts
  // Backend du chat Hermès : "local" (Ollama, PHI-safe) | "vertex" (Gemini UE) | "claude".
  chatBackend: process.env.CHAT_BACKEND ?? "local",
  geminiVertexProject: process.env.GEMINI_VERTEX_PROJECT ?? "",
  geminiVertexLocation: process.env.GEMINI_VERTEX_LOCATION ?? "europe-west1",
  geminiVertexModel: process.env.GEMINI_VERTEX_MODEL ?? "gemini-2.0-flash",
  geminiVertexToken: process.env.GEMINI_VERTEX_TOKEN ?? "", // jeton OAuth (ou via ADC)
```

- [ ] **Step 2: modèle chaud (Ollama)** — dans `chatViaOllama` (`hermesChat.ts`), remplacer `keep_alive: "30s",` par `keep_alive: -1,` et ajouter `options: { num_thread: 4 },` dans le body JSON.

- [ ] **Step 3: backend Vertex** — dans `hermesChat.ts`, ajouter :

```ts
/** Gemini via Vertex AI UE (conforme nLPD). Repli géré par l'appelant. */
export function vertexConfigured(): boolean {
  return (
    ENV.chatBackend === "vertex" &&
    !!ENV.geminiVertexProject &&
    !!ENV.geminiVertexToken
  );
}

export async function chatViaVertex(messages: ChatMsg[]): Promise<string> {
  const sys = messages.find(m => m.role === "system")?.content ?? "";
  const contents = messages
    .filter(m => m.role !== "system")
    .map(m => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));
  const url = `https://${ENV.geminiVertexLocation}-aiplatform.googleapis.com/v1/projects/${ENV.geminiVertexProject}/locations/${ENV.geminiVertexLocation}/publishers/google/models/${ENV.geminiVertexModel}:generateContent`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ENV.geminiVertexToken}`,
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: sys }] },
      contents,
      generationConfig: { maxOutputTokens: 1200, temperature: 0.2 },
    }),
  });
  if (!resp.ok)
    throw new Error(
      `Vertex HTTP ${resp.status}: ${(await resp.text().catch(() => "")).slice(0, 200)}`
    );
  const data = await resp.json();
  return (
    data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join("") ??
    ""
  );
}
```

- [ ] **Step 4: sélection backend + RAG** — dans `prepareHermesChat` / `runHermesChat`, choisir le backend : si `vertexConfigured()` → `chatViaVertex` ; sinon si Claude configuré et `chatBackend==="claude"` → Claude ; sinon `chatViaOllama`. Enrichir le contexte : avant l'appel, récupérer les fiches RAG (réutiliser `embedText`+`searchSimilar`+`buildKnowledgeBlock` avec une requête = modalité+description+indication) et les injecter comme DONNÉES dans le system prompt (« Référentiels (à citer si pertinent) : … »). Fail-soft (sans RAG si indispo).

- [ ] **Step 5: test sélection backend** — créer `server/report/hermesBackend.test.ts` :

```ts
import { describe, it, expect, vi } from "vitest";
const env = vi.hoisted(() => ({
  chatBackend: "local",
  geminiVertexProject: "",
  geminiVertexToken: "",
})) as any;
vi.mock("../_core/env", () => ({ ENV: env }));
import { vertexConfigured } from "./hermesChat";
describe("backend Vertex", () => {
  it("non configuré par défaut → local", () => {
    expect(vertexConfigured()).toBe(false);
  });
  it("configuré si vertex + project + token", () => {
    env.chatBackend = "vertex";
    env.geminiVertexProject = "p";
    env.geminiVertexToken = "t";
    expect(vertexConfigured()).toBe(true);
  });
});
```

NOTE : `hermesChat.ts` importe d'autres modules (db, etc.) ; si le mock ENV ne suffit pas à isoler, déplacer `vertexConfigured` dans un petit fichier `hermesBackend.ts` importé par `hermesChat.ts` et tester celui-là. Run le test → PASS. `npx tsc --noEmit` clean.

- [ ] **Step 6: commit**

```bash
git add server/_core/env.ts server/report/hermesChat.ts server/report/hermesBackend.test.ts
git commit -m "feat(hermes): backend Vertex UE + modèle chaud + contexte RAG"
```

---

### Task 5: UI — barre « Demander à Hermès : le dossier de… »

**Files:** `client/src/components/HermesChatPanel.tsx` (ou un nouveau `HermesFinder.tsx`), wiring dans `client/src/pages/Home.tsx`

- [ ] **Step 1: explorer** — `grep -n "HermesChatPanel\|findPatientReport\|trpc" client/src/components/HermesChatPanel.tsx client/src/pages/Home.tsx` pour le pattern d'ouverture du chat + import trpc (`@/lib/trpc`).
- [ ] **Step 2: composant finder** — créer `client/src/components/HermesFinder.tsx` : input « le dossier de… » → `trpc.hermes.findPatientReport.useQuery({ query }, { enabled: query.length>1 })` → liste (nom patient + statut CR) → clic ouvre le chat Hermès sur `studyId` (réutiliser le handler `openStudy`/ouverture du panneau Hermès trouvé). Si `studyId` null → afficher « pas encore de CR ».
- [ ] **Step 3: wiring** — monter `HermesFinder` dans la sidebar de Home (à côté de la file à signer), `onOpen={openStudy}`.
- [ ] **Step 4:** `npx tsc --noEmit` clean ; `npm run build` succès. Commit :

```bash
git add -A
git commit -m "feat(hermes): UI recherche patient + ouverture du chat sur son CR"
```

---

### Task 6: Intégration + déploiement

- [ ] **Step 1:** `npx tsc --noEmit && npx vitest run` → clean + tous verts.
- [ ] **Step 2: migration 0014 en prod (manuelle, SANS les marqueurs drizzle)** :

```bash
ssh root@76.13.55.44 'docker exec -i horos-db-1 sh -c "exec mysql -uroot -p\"\$MYSQL_ROOT_PASSWORD\" horos"' <<SQL
ALTER TABLE \`patients\` ADD COLUMN \`nameSearch\` varchar(255);
CREATE INDEX \`patients_nameSearch_idx\` ON \`patients\` (\`nameSearch\`);
SQL
```

- [ ] **Step 3:** PR `docs/hermes-explain-reports-inc1` → `self-host`, merge, CI verte, déployer (pull image SHA + sed compose + up -d --force-recreate app), health 200.
- [ ] **Step 4:** appeler `hermes.backfillNameSearch` (admin) UNE fois → remplit `nameSearch` des patients existants. Vérifier `hermes.findPatientReport` renvoie un patient connu.
- [ ] **Step 5:** Gemini reste OFF (chatBackend=local) tant que le gérant n'a pas fourni projet GCP + jeton Vertex UE. Vérifier que l'assistant répond en local.

---

## Self-review

- Couverture spec : blind index+migration (T1), backfill (T2), recherche+endpoint (T3), Vertex+chaud+RAG (T4), UI (T5), intégration/déploiement+migration sans marqueurs (T6). ✅
- Mono-tenant, lecture seule, repli local par défaut (PHI-safe), Vertex UE only. ✅
- Cohérence noms : `normalizeName`, `nameSearchKey`, `backfillPatientNameSearch`, `searchPatientsByName`, `vertexConfigured`, `chatViaVertex`. ✅
- Risque connu : isolation du test ENV pour `vertexConfigured` (Task 4 Step 5 prévoit l'extraction dans `hermesBackend.ts` si besoin).
