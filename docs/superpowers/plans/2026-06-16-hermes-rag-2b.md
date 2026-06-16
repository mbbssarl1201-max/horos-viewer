# Hermès 2b — socle RAG (mémoire vectorielle) — Plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Une base de connaissances radiologiques (non-PHI) ingérée depuis des `.md` (coffre Obsidian) via une page admin, embeddée localement, stockée en MySQL, et interrogeable par similarité cosinus.

**Architecture:** Modules purs `knowledge/chunk.ts` (découpage) + `knowledge/embeddings.ts` (cosinus pur + embedText Ollama local) ; `knowledge/store.ts` (insert + recherche top-k) sur une table MySQL `knowledge_chunks` (migration drizzle 0008) ; routeur tRPC `knowledge` (adminProcedure) ; page admin `KnowledgePage`. PHI-safe (tout local).

**Tech Stack:** React 19 + wouter, tRPC v11, drizzle (MySQL), Ollama `/api/embeddings` (`nomic-embed-text`), Vitest.

**Spec :** `docs/superpowers/specs/2026-06-16-hermes-rag-2b-design.md`

---

### Task 1 : Module pur `chunk.ts` (découpage markdown)

**Files:**

- Create: `server/knowledge/chunk.ts`
- Test: `server/knowledge/chunk.test.ts`

- [ ] **Step 1 : Test qui échoue**

```ts
import { describe, it, expect } from "vitest";
import { chunkMarkdown } from "./chunk";

describe("chunkMarkdown", () => {
  it("découpe par titres et conserve source + heading", () => {
    const md = "# Poumon\nNodule pulmonaire.\n\n# Os\nFracture du radius.";
    const chunks = chunkMarkdown("radio.md", md);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0].source).toBe("radio.md");
    expect(chunks[0].heading).toBe("Poumon");
    expect(chunks[0].content).toMatch(/Nodule/);
    const os = chunks.find(c => c.heading === "Os");
    expect(os?.content).toMatch(/Fracture/);
  });
  it("respecte une borne de taille (maxChars)", () => {
    const md = "# T\n" + "a".repeat(2500);
    const chunks = chunkMarkdown("x.md", md, { maxChars: 1000 });
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const c of chunks) expect(c.content.length).toBeLessThanOrEqual(1000);
  });
  it("markdown vide → []", () => {
    expect(chunkMarkdown("x.md", "   \n\n")).toEqual([]);
  });
});
```

- [ ] **Step 2 : Vérifier l'échec**

Run: `cd /Users/mbbssarl/Documents/GitHub/horos-viewer && npx vitest run server/knowledge/chunk.test.ts`
Expected: FAIL — module introuvable.

- [ ] **Step 3 : Implémenter `server/knowledge/chunk.ts`**

```ts
/**
 * Découpage PUR d'un markdown en chunks pour le RAG : par titres (#…), avec une
 * borne de taille (chevauchement implicite via les paragraphes). Conserve la
 * source (nom de fichier) et le dernier titre rencontré (heading). Sans I/O.
 */
export interface KnowledgeChunk {
  source: string;
  heading: string;
  content: string;
}

export function chunkMarkdown(
  source: string,
  markdown: string,
  opts?: { maxChars?: number }
): KnowledgeChunk[] {
  const maxChars = opts?.maxChars ?? 1000;
  const out: KnowledgeChunk[] = [];
  let heading = "";
  let buf = "";
  const flush = () => {
    const c = buf.trim();
    if (c) out.push({ source, heading, content: c });
    buf = "";
  };
  for (const line of markdown.split("\n")) {
    const h = /^(#{1,6})\s+(.*)$/.exec(line.trim());
    if (h) {
      flush();
      heading = h[2].trim();
      continue;
    }
    // Coupe avant d'ajouter si la ligne ferait dépasser la borne.
    if (buf && buf.length + line.length + 1 > maxChars) flush();
    // Ligne plus longue que la borne : on la tronque en morceaux.
    let rest = line;
    while (rest.length > maxChars) {
      out.push({ source, heading, content: rest.slice(0, maxChars) });
      rest = rest.slice(maxChars);
    }
    buf += (buf ? "\n" : "") + rest;
  }
  flush();
  return out;
}
```

- [ ] **Step 4 : Vérifier le succès** : `npx vitest run server/knowledge/chunk.test.ts` → PASS (3 tests).

- [ ] **Step 5 : Commit**

```bash
git add server/knowledge/chunk.ts server/knowledge/chunk.test.ts
git commit -m "feat(rag): module pur chunkMarkdown"
```

---

### Task 2 : `embeddings.ts` (cosinus pur + embedText Ollama)

**Files:**

- Create: `server/knowledge/embeddings.ts`
- Test: `server/knowledge/embeddings.test.ts`

- [ ] **Step 1 : Test qui échoue**

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { cosineSimilarity } from "./embeddings";

describe("cosineSimilarity", () => {
  it("vecteurs identiques → 1, orthogonaux → 0", () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1, 6);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6);
  });
  it("dimensions différentes ou vide → 0 (garde-fou)", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
  });
});

describe("embedText", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  it("appelle /api/embeddings et renvoie le vecteur", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ embedding: [0.1, 0.2, 0.3] }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { embedText } = await import("./embeddings");
    const v = await embedText("nodule");
    expect(v).toEqual([0.1, 0.2, 0.3]);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
    expect(body.prompt).toBe("nodule");
    expect(typeof body.model).toBe("string");
  });
});
```

- [ ] **Step 2 : Vérifier l'échec** : `npx vitest run server/knowledge/embeddings.test.ts` → FAIL.

- [ ] **Step 3 : Implémenter `server/knowledge/embeddings.ts`**

```ts
import { ENV } from "../_core/env";

/** Similarité cosinus. Dimensions différentes / vide → 0 (garde-fou). PUR. */
export function cosineSimilarity(
  a: readonly number[],
  b: readonly number[]
): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Embedding LOCAL via Ollama (/api/embeddings, modèle `OLLAMA_EMBED_MODEL`,
 * défaut `nomic-embed-text`). PHI-safe. Timeout 60 s.
 */
export async function embedText(text: string): Promise<number[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  try {
    const resp = await fetch(`${ENV.ollamaUrl}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({ model: ENV.ollamaEmbedModel, prompt: text }),
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      throw new Error(
        `Ollama embeddings HTTP ${resp.status}: ${t.slice(0, 200)}`
      );
    }
    const data = await resp.json();
    const emb = data?.embedding;
    if (!Array.isArray(emb) || emb.length === 0) {
      throw new Error(
        "Embeddings indisponibles — vérifiez `ollama pull nomic-embed-text` sur ollama-hermes."
      );
    }
    return emb as number[];
  } finally {
    clearTimeout(timeout);
  }
}
```

- [ ] **Step 4 : Ajouter l'env** — dans `server/_core/env.ts`, après `ollamaTextModel: …,` :

```ts
  // Modèle d'embeddings Ollama (RAG Hermès). Local, PHI-safe. `ollama pull nomic-embed-text`.
  ollamaEmbedModel: process.env.OLLAMA_EMBED_MODEL ?? "nomic-embed-text",
```

Et `.env.example` (section IA) :

```
# Modèle d'embeddings Ollama pour la base de connaissances Hermès (local, PHI-safe).
OLLAMA_EMBED_MODEL=nomic-embed-text
```

- [ ] **Step 5 : Vérifier le succès** : `npx vitest run server/knowledge/embeddings.test.ts` → PASS (3 tests) ; `npx tsc --noEmit` → 0 erreur.

- [ ] **Step 6 : Commit**

```bash
git add server/knowledge/embeddings.ts server/knowledge/embeddings.test.ts server/_core/env.ts .env.example
git commit -m "feat(rag): cosineSimilarity (pur) + embedText Ollama local"
```

---

### Task 3 : Table `knowledge_chunks` + migration + `store.ts`

**Files:**

- Modify: `drizzle/schema.ts` (table)
- Create: `drizzle/0008_*.sql` (généré)
- Create: `server/knowledge/store.ts`

- [ ] **Step 1 : Ajouter la table à `drizzle/schema.ts`** (à la fin du fichier) :

```ts
// Base de connaissances RAG d'Hermès (NON-PHI). `embedding` = JSON.stringify(number[]).
export const knowledgeChunks = mysqlTable("knowledge_chunks", {
  id: int("id").autoincrement().primaryKey(),
  source: varchar("source", { length: 512 }).notNull(),
  heading: varchar("heading", { length: 512 }),
  content: text("content").notNull(),
  embedding: text("embedding").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
```

- [ ] **Step 2 : Générer la migration**

Run: `cd /Users/mbbssarl/Documents/GitHub/horos-viewer && npx drizzle-kit generate`
Expected: crée `drizzle/0008_*.sql` (CREATE TABLE `knowledge_chunks`) + met à jour `drizzle/meta/_journal.json`. Vérifier le `.sql` produit.

- [ ] **Step 3 : Implémenter `server/knowledge/store.ts`**

```ts
import { getDb } from "../db";
import { knowledgeChunks } from "../../drizzle/schema";
import { eq, sql } from "drizzle-orm";
import { cosineSimilarity } from "./embeddings";

export interface ChunkToInsert {
  source: string;
  heading: string;
  content: string;
  embedding: number[];
}

export async function insertChunks(rows: ChunkToInsert[]): Promise<number> {
  if (rows.length === 0) return 0;
  const db = await getDb();
  if (!db) throw new Error("DB indisponible");
  await db.insert(knowledgeChunks).values(
    rows.map(r => ({
      source: r.source.slice(0, 512),
      heading: (r.heading || "").slice(0, 512),
      content: r.content,
      embedding: JSON.stringify(r.embedding),
    }))
  );
  return rows.length;
}

export interface SimilarChunk {
  source: string;
  heading: string | null;
  content: string;
  score: number;
}

/** Charge les chunks, calcule le cosinus en JS, renvoie le top-k. */
export async function searchSimilar(
  queryEmbedding: number[],
  k = 5
): Promise<SimilarChunk[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db
    .select({
      source: knowledgeChunks.source,
      heading: knowledgeChunks.heading,
      content: knowledgeChunks.content,
      embedding: knowledgeChunks.embedding,
    })
    .from(knowledgeChunks);
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

export async function knowledgeStats(): Promise<{
  chunks: number;
  sources: number;
}> {
  const db = await getDb();
  if (!db) return { chunks: 0, sources: 0 };
  const [c] = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(knowledgeChunks);
  const [s] = await db
    .select({ n: sql<number>`COUNT(DISTINCT ${knowledgeChunks.source})` })
    .from(knowledgeChunks);
  return { chunks: Number(c?.n ?? 0), sources: Number(s?.n ?? 0) };
}

export async function clearKnowledge(source?: string): Promise<void> {
  const db = await getDb();
  if (!db) return;
  if (source) {
    await db.delete(knowledgeChunks).where(eq(knowledgeChunks.source, source));
  } else {
    await db.delete(knowledgeChunks);
  }
}
```

- [ ] **Step 4 : Vérifs** : `npx tsc --noEmit` → 0 erreur ; `npx vitest run server/` → tous PASS (rien ne casse).

- [ ] **Step 5 : Commit**

```bash
git add drizzle/schema.ts drizzle/0008_*.sql drizzle/meta server/knowledge/store.ts
git commit -m "feat(rag): table knowledge_chunks (migration 0008) + store (insert/search/stats/clear)"
```

---

### Task 4 : Routeur tRPC `knowledge` (adminProcedure)

**Files:**

- Modify: `server/routers.ts` (imports + sous-routeur `knowledge`)

- [ ] **Step 1 : Imports** — en tête de `server/routers.ts` :

```ts
import { chunkMarkdown } from "./knowledge/chunk";
import { embedText } from "./knowledge/embeddings";
import {
  insertChunks,
  searchSimilar,
  knowledgeStats,
  clearKnowledge,
} from "./knowledge/store";
```

- [ ] **Step 2 : Ajouter le sous-routeur `knowledge`** dans `appRouter = router({ … })` (à côté de `ai`) :

```ts
  knowledge: router({
    // Ingestion de fichiers .md (coffre Obsidian) → chunks + embeddings locaux + stockage.
    ingest: adminProcedure
      .input(
        z.object({
          files: z
            .array(
              z.object({
                name: z.string().min(1).max(512),
                content: z.string().max(2_000_000),
              })
            )
            .min(1)
            .max(50),
        })
      )
      .mutation(async ({ input }) => {
        let inserted = 0;
        const errors: string[] = [];
        for (const f of input.files) {
          try {
            const chunks = chunkMarkdown(f.name, f.content);
            const rows = [];
            for (const c of chunks) {
              try {
                const embedding = await embedText(
                  `${c.heading}\n${c.content}`.trim()
                );
                rows.push({ ...c, embedding });
              } catch {
                errors.push(`${f.name}: embedding échoué (chunk)`);
              }
            }
            inserted += await insertChunks(rows);
          } catch {
            errors.push(`${f.name}: ingestion échouée`);
          }
        }
        return { inserted, errors };
      }),
    // Recherche par similarité (test/2c).
    search: adminProcedure
      .input(z.object({ query: z.string().min(1).max(2000), k: z.number().int().min(1).max(20).default(5) }))
      .mutation(async ({ input }) => {
        const emb = await embedText(input.query);
        return { results: await searchSimilar(emb, input.k) };
      }),
    stats: adminProcedure.query(async () => knowledgeStats()),
    clear: adminProcedure
      .input(z.object({ source: z.string().max(512).optional() }))
      .mutation(async ({ input }) => {
        await clearKnowledge(input.source);
        return { ok: true };
      }),
  }),
```

- [ ] **Step 3 : Vérifs** : `npx tsc --noEmit && npx vitest run server/` → 0 erreur, tous PASS.

- [ ] **Step 4 : Commit**

```bash
git add server/routers.ts
git commit -m "feat(rag): routeur tRPC knowledge (ingest/search/stats/clear, adminProcedure)"
```

---

### Task 5 : Page admin `KnowledgePage` + route

**Files:**

- Create: `client/src/pages/KnowledgePage.tsx`
- Modify: `client/src/App.tsx` (route)

- [ ] **Step 1 : Créer `client/src/pages/KnowledgePage.tsx`**

```tsx
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";

/**
 * Page admin : base de connaissances Hermès (RAG). Upload de fichiers .md →
 * ingestion (chunks + embeddings locaux). NON-PHI. Accès admin (knowledge.*
 * sont des adminProcedure ; le serveur refuse les non-admins).
 */
export default function KnowledgePage() {
  const stats = trpc.knowledge.stats.useQuery();
  const ingest = trpc.knowledge.ingest.useMutation();
  const clear = trpc.knowledge.clear.useMutation();
  const [msg, setMsg] = useState("");

  const onFiles = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    setMsg("Lecture des fichiers…");
    const files: { name: string; content: string }[] = [];
    for (const f of Array.from(fileList)) {
      files.push({ name: f.name, content: await f.text() });
    }
    setMsg(`Ingestion de ${files.length} fichier(s)…`);
    try {
      const r = await ingest.mutateAsync({ files });
      setMsg(
        `Ingéré : ${r.inserted} chunk(s)` +
          (r.errors.length ? ` — ${r.errors.length} erreur(s)` : "")
      );
      stats.refetch();
    } catch {
      setMsg("Échec de l'ingestion.");
    }
  };

  return (
    <div className="max-w-2xl mx-auto p-6 space-y-4">
      <h1 className="text-xl font-bold">Base de connaissances Hermès</h1>
      <p className="text-sm text-muted-foreground">
        Téléversez des fichiers Markdown (.md) de votre coffre Obsidian. Données
        de connaissances uniquement — <strong>aucune donnée patient</strong>.
      </p>
      <div className="text-sm">
        Base actuelle : <strong>{stats.data?.chunks ?? 0}</strong> chunk(s),{" "}
        <strong>{stats.data?.sources ?? 0}</strong> source(s).
      </div>
      <input
        type="file"
        accept=".md,text/markdown"
        multiple
        onChange={e => void onFiles(e.target.files)}
        disabled={ingest.isPending}
      />
      <div className="flex gap-2">
        <Button
          variant="destructive"
          size="sm"
          disabled={clear.isPending}
          onClick={async () => {
            if (!confirm("Vider toute la base de connaissances ?")) return;
            await clear.mutateAsync({});
            setMsg("Base vidée.");
            stats.refetch();
          }}
        >
          Vider la base
        </Button>
      </div>
      {msg && <div className="text-xs text-cyan-400">{msg}</div>}
    </div>
  );
}
```

- [ ] **Step 2 : Ajouter la route** — dans `client/src/App.tsx`, parmi les `<Route>` (avant le catch-all `<Route component={NotFound} />`) :

```tsx
<Route path={"/admin/knowledge"} component={KnowledgePage} />
```

Et l'import en tête :

```ts
import KnowledgePage from "@/pages/KnowledgePage";
```

- [ ] **Step 3 : Vérifs** : `cd /Users/mbbssarl/Documents/GitHub/horos-viewer && npx tsc --noEmit && npm run build` → 0 erreur, build OK.

- [ ] **Step 4 : Non-régression** : `npx vitest run` → tous PASS (dont chunk + embeddings).

- [ ] **Step 5 : Commit**

```bash
git add client/src/pages/KnowledgePage.tsx client/src/App.tsx
git commit -m "feat(rag): page admin KnowledgePage (upload .md + stats + vider)"
```

---

### Task 6 : PR + déploiement (modèle d'embeddings + migration)

**Files:** aucun.

- [ ] **Step 1 : Pousser la branche SEULE** : `git push origin HEAD:refs/heads/feat/hermes-rag`
- [ ] **Step 2 : Créer la PR** (appel séparé) :

```bash
gh pr create --base self-host --head feat/hermes-rag \
  --title "Hermès 2b — socle RAG (mémoire vectorielle, embeddings locaux)" \
  --body "Incrément 2b. Page admin /admin/knowledge : upload .md → chunkMarkdown → embeddings LOCAUX (Ollama nomic-embed-text) → MySQL knowledge_chunks → recherche cosinus top-k. Modules purs testés (chunkMarkdown, cosineSimilarity). PHI-safe (tout local), adminProcedure. **Migration DB 0008** + prérequis déploiement \`ollama pull nomic-embed-text\`. Pas encore branché sur le chat (=2c)."
```

- [ ] **Step 3 : CI verte (gate verify → build) puis merge** :

```bash
gh run watch "$(gh run list --branch self-host --limit 1 --json databaseId --jq '.[0].databaseId')" --exit-status
gh pr merge <num> --merge --delete-branch=false
```

- [ ] **Step 4 : Pré-déploiement — pull du modèle d'embeddings sur le VPS** :

```bash
ssh root@76.13.55.44 "docker exec ollama-hermes ollama pull nomic-embed-text && docker exec ollama-hermes ollama list | grep -i nomic"
```

- [ ] **Step 5 : Déployer** (image GHCR `:<fullSHA>` → `/docker/horos/docker-compose.yml`, `docker compose pull migrate app`, `up -d migrate`, **vérifier `migrate exit=0`** — la migration 0008 crée `knowledge_chunks`, `up -d app`), puis vérifier healthz 200 + garde 401 + image SHA.

- [ ] **Step 6 : Vérif visuelle** : en admin, `/admin/knowledge` → uploader un petit `.md` → compteur de chunks > 0 ; (optionnel) tester `knowledge.search` via un appel.

---

## Notes

- **Migration DB 0008** (1re table RAG) appliquée par le service `migrate` drizzle. Si le cutover échoue (table déjà créée manuellement), insérer la ligne `__drizzle_migrations` (gotcha connu) — mais ici on laisse `migrate` faire.
- **Modèle d'embeddings** : à `pull` sur `ollama-hermes` AVANT/au déploiement (sinon `ingest`/`search` renvoient une erreur claire « ollama pull nomic-embed-text »).
- Recherche cosinus **en JS** (charge tous les chunks) : OK pour une base perso ; si > ~10k chunks, envisager pgvector (2b-bis).
- **Aucun PHI** dans `knowledge_chunks` (connaissances uniquement). Embeddings **locaux**.
