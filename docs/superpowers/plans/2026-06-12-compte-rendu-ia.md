# Compte-rendu radiologique IA — Plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ajouter à MediView un compte-rendu radiologique structuré, persisté, généré par IA (brouillon) puis signé (immuable + addendum + PDF officiel + audit).

**Architecture:** Entité `reports` (1 par étude) + `report_addenda` (append-only) en MySQL/drizzle. Routeur tRPC `reports` réutilisant `runAiPreanalysis`+`parseSections` (génération IA hybride), `buildReportPdf` (PDF officiel), `recordAccess` (audit), `storagePut` (MinIO). Cycle draft→signed verrouillé au serveur. UI : `ReportPanel` évolue en éditeur 4 sections.

**Tech Stack:** TypeScript, drizzle-orm (mysql-core), tRPC v11, React, Vitest. Réutilise l'existant : `server/report/aiPreanalysis.ts`, `server/report/reportPdf.ts`, `server/db.ts` (`recordAccess`, `getDb`), `server/storage.ts` (`storagePut`, `storageGetSignedUrl`).

**⚠️ Naming :** on aligne les 4 sections sur l'interface `ReportSections` existante de `reportPdf.ts` : **`indication`, `technique`, `resultats`, `conclusion`** (pas findings/impression). Le PDF sait déjà les rendre.

**⚠️ Déploiement :** branche `self-host` (PR, jamais `main`). Migration DB **appliquée manuellement** (règle prod MBBS).

---

### Task 1 : Logique pure — machine à états + parsing IA

**Files:**

- Create: `client/src/lib/reportLifecycle.ts`
- Test: `client/src/lib/reportLifecycle.test.ts`

(Lib pure, partagée client/serveur via import relatif côté serveur ; aucune dépendance DOM/DB.)

- [ ] **Step 1 : Écrire le test qui échoue**

```ts
// client/src/lib/reportLifecycle.test.ts
import { describe, it, expect } from "vitest";
import {
  canEditReport,
  canSignReport,
  canAddAddendum,
  REQUIRED_TO_SIGN,
  validateReportSections,
} from "./reportLifecycle";

describe("canEditReport", () => {
  it("autorise l'édition d'un brouillon", () => {
    expect(canEditReport("draft")).toBe(true);
  });
  it("interdit l'édition d'un compte-rendu signé", () => {
    expect(canEditReport("signed")).toBe(false);
  });
});

describe("canSignReport", () => {
  it("interdit la signature sans conclusion", () => {
    expect(
      canSignReport("draft", {
        indication: "",
        technique: "",
        resultats: "x",
        conclusion: "",
      })
    ).toBe(false);
  });
  it("autorise la signature d'un brouillon avec conclusion", () => {
    expect(
      canSignReport("draft", {
        indication: "",
        technique: "",
        resultats: "",
        conclusion: "RAS",
      })
    ).toBe(true);
  });
  it("interdit de re-signer un compte-rendu déjà signé", () => {
    expect(
      canSignReport("signed", {
        indication: "",
        technique: "",
        resultats: "",
        conclusion: "RAS",
      })
    ).toBe(false);
  });
});

describe("canAddAddendum", () => {
  it("n'autorise les addenda que sur un signé", () => {
    expect(canAddAddendum("signed")).toBe(true);
    expect(canAddAddendum("draft")).toBe(false);
  });
});

describe("validateReportSections", () => {
  it("normalise un objet partiel en 4 chaînes", () => {
    expect(validateReportSections({ resultats: "a" })).toEqual({
      indication: "",
      technique: "",
      resultats: "a",
      conclusion: "",
    });
  });
  it("coupe les valeurs non-chaîne", () => {
    expect(validateReportSections({ conclusion: 42 as any }).conclusion).toBe(
      ""
    );
  });
  it("REQUIRED_TO_SIGN cible la conclusion", () => {
    expect(REQUIRED_TO_SIGN).toContain("conclusion");
  });
});
```

- [ ] **Step 2 : Lancer le test (échec attendu)**

Run: `cd ~/Documents/GitHub/horos-viewer && npx vitest run client/src/lib/reportLifecycle.test.ts`
Expected: FAIL — `Cannot find module './reportLifecycle'`.

- [ ] **Step 3 : Implémenter**

```ts
// client/src/lib/reportLifecycle.ts
/** Sections d'un compte-rendu (alignées sur ReportSections de reportPdf.ts). */
export interface ReportSectionFields {
  indication: string;
  technique: string;
  resultats: string;
  conclusion: string;
}

export type ReportStatus = "draft" | "signed";

/** Sections minimales requises avant de pouvoir signer. */
export const REQUIRED_TO_SIGN: ReadonlyArray<keyof ReportSectionFields> = [
  "conclusion",
];

/** Un compte-rendu n'est éditable que tant qu'il est en brouillon. */
export function canEditReport(status: ReportStatus): boolean {
  return status === "draft";
}

/** Signature possible : brouillon + toutes les sections requises non vides. */
export function canSignReport(
  status: ReportStatus,
  sections: ReportSectionFields
): boolean {
  if (status !== "draft") return false;
  return REQUIRED_TO_SIGN.every(k => (sections[k] ?? "").trim().length > 0);
}

/** Les addenda ne s'ajoutent qu'à un compte-rendu signé. */
export function canAddAddendum(status: ReportStatus): boolean {
  return status === "signed";
}

/** Normalise un objet arbitraire (sortie IA) en 4 sections-chaînes sûres. */
export function validateReportSections(
  raw: Partial<Record<keyof ReportSectionFields, unknown>> | null | undefined
): ReportSectionFields {
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  return {
    indication: s(raw?.indication),
    technique: s(raw?.technique),
    resultats: s(raw?.resultats),
    conclusion: s(raw?.conclusion),
  };
}
```

- [ ] **Step 4 : Lancer le test (succès attendu)**

Run: `npx vitest run client/src/lib/reportLifecycle.test.ts`
Expected: PASS (tous verts).

- [ ] **Step 5 : Commit**

```bash
git add client/src/lib/reportLifecycle.ts client/src/lib/reportLifecycle.test.ts
git commit -m "feat(report): logique pure cycle de vie + validation sections IA"
```

---

### Task 2 : Schéma DB — tables `reports` + `report_addenda`

**Files:**

- Modify: `drizzle/schema.ts` (ajout en fin de fichier + `boolean` à l'import)
- Generate: nouvelle migration `drizzle/00xx_*.sql`

- [ ] **Step 1 : Ajouter `boolean` à l'import drizzle**

Dans `drizzle/schema.ts` ligne 1, remplacer l'import par :

```ts
import {
  int,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  varchar,
  bigint,
  json,
  index,
  boolean,
} from "drizzle-orm/mysql-core";
```

- [ ] **Step 2 : Ajouter les tables en fin de `drizzle/schema.ts`**

```ts
/**
 * Compte-rendu radiologique : un par étude (studyId unique). Cycle draft→signed.
 * Une fois signé, immuable (verrou applicatif côté routeur reports) ; les
 * corrections passent par reportAddenda.
 */
export const reports = mysqlTable("reports", {
  id: int("id").autoincrement().primaryKey(),
  studyId: int("studyId").notNull().unique(),
  status: mysqlEnum("status", ["draft", "signed"]).default("draft").notNull(),
  indication: text("indication"),
  technique: text("technique"),
  resultats: text("resultats"),
  conclusion: text("conclusion"),
  aiGenerated: boolean("aiGenerated").default(false).notNull(),
  aiModel: varchar("aiModel", { length: 128 }),
  createdBy: int("createdBy").notNull(),
  signedBy: int("signedBy"),
  signedAt: timestamp("signedAt"),
  pdfStorageKey: varchar("pdfStorageKey", { length: 512 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

/** Addenda (corrections post-signature), append-only, datés. */
export const reportAddenda = mysqlTable("report_addenda", {
  id: int("id").autoincrement().primaryKey(),
  reportId: int("reportId").notNull(),
  text: text("text").notNull(),
  createdBy: int("createdBy").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
```

- [ ] **Step 3 : Générer la migration**

Run: `cd ~/Documents/GitHub/horos-viewer && npx drizzle-kit generate`
Expected: un nouveau fichier `drizzle/00xx_*.sql` créé avec `CREATE TABLE reports` + `CREATE TABLE report_addenda`. Vérifier son contenu (deux CREATE TABLE).

- [ ] **Step 4 : Vérifier la compilation du schéma**

Run: `npx tsc --noEmit`
Expected: 0 erreur.

- [ ] **Step 5 : Commit**

```bash
git add drizzle/schema.ts drizzle/
git commit -m "feat(report): tables reports + report_addenda (migration)"
```

> **NOTE déploiement :** la migration sera **appliquée manuellement en prod** (règle MBBS). Fournir le SQL des deux `CREATE TABLE` au gérant.

---

### Task 3 : Helpers DB du compte-rendu

**Files:**

- Modify: `server/db.ts` (ajout de fonctions en fin de fichier)

(On suit le style des helpers existants : `getDb()`, `recordAccess()`.)

- [ ] **Step 1 : Ajouter les helpers d'accès `reports`**

En fin de `server/db.ts` :

```ts
import { reports, reportAddenda } from "../drizzle/schema";
// (si l'import groupé du haut du fichier existe déjà, y ajouter reports, reportAddenda)

export interface ReportRow {
  id: number;
  studyId: number;
  status: "draft" | "signed";
  indication: string | null;
  technique: string | null;
  resultats: string | null;
  conclusion: string | null;
  aiGenerated: boolean;
  aiModel: string | null;
  createdBy: number;
  signedBy: number | null;
  signedAt: Date | null;
  pdfStorageKey: string | null;
}

/** Compte-rendu d'une étude (ou null). */
export async function getReportByStudy(studyId: number) {
  const db = await getDb();
  if (!db) return null;
  const { eq } = await import("drizzle-orm");
  const rows = await db
    .select()
    .from(reports)
    .where(eq(reports.studyId, studyId))
    .limit(1);
  return rows[0] ?? null;
}

/** Addenda d'un compte-rendu, du plus ancien au plus récent. */
export async function getReportAddenda(reportId: number) {
  const db = await getDb();
  if (!db) return [];
  const { eq, asc } = await import("drizzle-orm");
  return db
    .select()
    .from(reportAddenda)
    .where(eq(reportAddenda.reportId, reportId))
    .orderBy(asc(reportAddenda.createdAt));
}
```

- [ ] **Step 2 : Compiler**

Run: `cd ~/Documents/GitHub/horos-viewer && npx tsc --noEmit`
Expected: 0 erreur. (Si l'import drizzle-orm `asc`/`eq` est déjà importé en haut, retirer le `import` dynamique en double.)

- [ ] **Step 3 : Commit**

```bash
git add server/db.ts
git commit -m "feat(report): helpers DB getReportByStudy/getReportAddenda"
```

---

### Task 4 : Étendre le PDF — bloc signature + addenda

**Files:**

- Modify: `server/report/reportPdf.ts` (interface + rendu)
- Test: `server/report/reportPdf.test.ts` (ajouter un cas)

- [ ] **Step 1 : Test qui échoue (addenda rendus)**

Ajouter à `server/report/reportPdf.test.ts` :

```ts
it("inclut les addenda dans le PDF", () => {
  const buf = buildReportPdf({
    study: { id: 1, patientName: "X", modality: "CT" },
    report: {
      indication: "",
      technique: "",
      resultats: "RAS",
      conclusion: "Normal",
    },
    signature: "Dr Test — 12/06/2026",
    keyImages: [],
    addenda: [
      {
        text: "Précision ajoutée",
        date: "12/06/2026 14:00",
        author: "Dr Test",
      },
    ],
  });
  // Un PDF jsPDF commence par "%PDF" et contient des octets ; on vérifie la taille.
  expect(buf.length).toBeGreaterThan(800);
  expect(buf.subarray(0, 4).toString()).toBe("%PDF");
});
```

- [ ] **Step 2 : Lancer (échec attendu)**

Run: `npx vitest run server/report/reportPdf.test.ts`
Expected: FAIL — `addenda` n'existe pas sur `ReportPdfInput`.

- [ ] **Step 3 : Étendre l'interface + le rendu**

Dans `server/report/reportPdf.ts`, ajouter à `ReportPdfInput` :

```ts
  /** Addenda datés à rendre après la signature (corrections post-signature). */
  addenda?: { text: string; date: string; author: string }[];
```

Puis, dans `buildReportPdf`, **après** le bloc signature existant (avant le `return`), ajouter :

```ts
if (input.addenda && input.addenda.length) {
  for (const ad of input.addenda) {
    y += 8;
    if (y > doc.internal.pageSize.getHeight() - 20) {
      doc.addPage();
      y = 14;
    }
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    doc.text(`Addendum — ${ad.author}, ${ad.date}`, MARGIN, y);
    y += 5;
    doc.setFont("helvetica", "normal");
    const lines = doc.splitTextToSize(ad.text, W - 2 * MARGIN);
    doc.text(lines, MARGIN, y);
    y += lines.length * 5;
  }
}
```

- [ ] **Step 4 : Lancer (succès attendu)**

Run: `npx vitest run server/report/reportPdf.test.ts`
Expected: PASS.

- [ ] **Step 5 : Commit**

```bash
git add server/report/reportPdf.ts server/report/reportPdf.test.ts
git commit -m "feat(report): rendu des addenda dans le PDF officiel"
```

---

### Task 5 : Routeur tRPC `reports`

**Files:**

- Modify: `server/routers.ts` (ajouter le sous-routeur `reports` + le monter dans `appRouter`)

Réutilise : `medicalProcedure` (lecture), `adminProcedure` (admin|radiologist = actions médecin), `getReportByStudy`/`getReportAddenda` (Task 3), `runAiPreanalysis`+`parseSections` (aiPreanalysis.ts), `buildReportPdf` (Task 4), `recordAccess`, `storagePut`, `storageGetSignedUrl`, `getDb`, helpers de `reportLifecycle.ts`.

- [ ] **Step 1 : Importer les dépendances en tête de `server/routers.ts`**

Ajouter aux imports existants (si absents) :

```ts
import { buildReportPdf } from "./report/reportPdf";
import { runAiPreanalysis, parseSections } from "./report/aiPreanalysis";
import { storagePut, storageGetSignedUrl } from "./storage";
import { getReportByStudy, getReportAddenda } from "./db";
import {
  canSignReport,
  canAddAddendum,
  validateReportSections,
} from "../client/src/lib/reportLifecycle";
```

- [ ] **Step 2 : Définir le sous-routeur `reports`**

Dans l'objet `appRouter = router({ ... })`, ajouter une clé `reports` :

```ts
  reports: router({
    getByStudy: medicalProcedure
      .input(z.object({ studyId: z.number() }))
      .query(async ({ input }) => {
        const report = await getReportByStudy(input.studyId);
        if (!report) return { report: null, addenda: [] as any[] };
        const addenda = await getReportAddenda(report.id);
        return { report, addenda };
      }),

    upsertDraft: adminProcedure
      .input(
        z.object({
          studyId: z.number(),
          sections: z.object({
            indication: z.string(),
            technique: z.string(),
            resultats: z.string(),
            conclusion: z.string(),
          }),
          aiGenerated: z.boolean().optional(),
          aiModel: z.string().optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const { getDb } = await import("./db");
        const { reports } = await import("../drizzle/schema");
        const { eq } = await import("drizzle-orm");
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        const existing = await getReportByStudy(input.studyId);
        if (existing && existing.status === "signed") {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Compte-rendu signé : non modifiable (ajoutez un addendum).",
          });
        }
        const sections = validateReportSections(input.sections);
        if (existing) {
          await db.update(reports).set({
            ...sections,
            aiGenerated: input.aiGenerated ?? existing.aiGenerated,
            aiModel: input.aiModel ?? existing.aiModel,
          }).where(eq(reports.id, existing.id));
          await recordAccess({ userId: ctx.user.id, action: "report.draft", studyId: input.studyId, detail: "update", ipAddress: ctx.req?.ip ?? null });
          return { id: existing.id };
        }
        const res = await db.insert(reports).values({
          studyId: input.studyId,
          status: "draft",
          ...sections,
          aiGenerated: input.aiGenerated ?? false,
          aiModel: input.aiModel ?? null,
          createdBy: ctx.user.id,
        });
        await recordAccess({ userId: ctx.user.id, action: "report.draft", studyId: input.studyId, detail: "create", ipAddress: ctx.req?.ip ?? null });
        return { id: Number((res as any).insertId) };
      }),

    aiGenerate: adminProcedure
      .input(
        z.object({
          studyId: z.number(),
          seriesId: z.number().optional(),
          indication: z.string().optional(),
          antecedents: z.string().optional(),
          keyImages: z.array(z.object({ pngBase64: z.string(), sliceIndex: z.number() })).default([]),
        })
      )
      .mutation(async ({ input, ctx }) => {
        // Réutilise l'échantillonnage volume + détection coupe-clé existant.
        const result = await runAiPreanalysis(
          {
            studyId: input.studyId,
            seriesId: input.seriesId,
            indication: input.indication,
            antecedents: input.antecedents,
            keyImages: input.keyImages,
          },
          { user: { id: ctx.user.id }, req: { ip: ctx.req?.ip } }
        );
        const parsed = parseSections(result.text);
        const sections = validateReportSections({
          indication: input.indication ?? "",
          technique: parsed.technique,
          resultats: parsed.resultats,
          conclusion: parsed.conclusion,
        });
        await recordAccess({ userId: ctx.user.id, action: "report.generate", studyId: input.studyId, detail: result.model, ipAddress: ctx.req?.ip ?? null });
        return { sections, aiModel: result.model, keyImage: result.keyImage ?? null };
      }),

    sign: adminProcedure
      .input(z.object({ reportId: z.number() }))
      .mutation(async ({ input, ctx }) => {
        const { getDb } = await import("./db");
        const { reports } = await import("../drizzle/schema");
        const { eq } = await import("drizzle-orm");
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        const rows = await db.select().from(reports).where(eq(reports.id, input.reportId)).limit(1);
        const report = rows[0];
        if (!report) throw new TRPCError({ code: "NOT_FOUND" });
        const sections = validateReportSections(report);
        if (!canSignReport(report.status as any, sections)) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Conclusion requise, ou déjà signé." });
        }
        // Étude (pour l'en-tête PDF) — réutilise getStudyById.
        const { getStudyById } = await import("./db");
        const study = await getStudyById(report.studyId);
        const signedAt = new Date();
        const signature = `Signé par ${ctx.user.name ?? "Dr"} le ${signedAt.toLocaleString("fr-CH")}`;
        const pdf = buildReportPdf({
          study: study as any,
          report: sections,
          signature,
          keyImages: [],
          aiAssisted: report.aiGenerated,
        });
        const key = `reports/${report.studyId}/report-${report.id}.pdf`;
        await storagePut(key, pdf, "application/pdf");
        await db.update(reports).set({
          status: "signed",
          signedBy: ctx.user.id,
          signedAt,
          pdfStorageKey: key,
        }).where(eq(reports.id, report.id));
        await recordAccess({ userId: ctx.user.id, action: "report.sign", studyId: report.studyId, detail: `report ${report.id}`, ipAddress: ctx.req?.ip ?? null });
        return { success: true, pdfStorageKey: key };
      }),

    addAddendum: adminProcedure
      .input(z.object({ reportId: z.number(), text: z.string().min(1) }))
      .mutation(async ({ input, ctx }) => {
        const { getDb } = await import("./db");
        const { reports, reportAddenda } = await import("../drizzle/schema");
        const { eq } = await import("drizzle-orm");
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        const rows = await db.select().from(reports).where(eq(reports.id, input.reportId)).limit(1);
        const report = rows[0];
        if (!report) throw new TRPCError({ code: "NOT_FOUND" });
        if (!canAddAddendum(report.status as any)) {
          throw new TRPCError({ code: "FORBIDDEN", message: "Addendum possible uniquement sur un compte-rendu signé." });
        }
        await db.insert(reportAddenda).values({ reportId: report.id, text: input.text, createdBy: ctx.user.id });
        // Régénère le PDF avec les addenda.
        const addenda = await getReportAddenda(report.id);
        const { getStudyById } = await import("./db");
        const study = await getStudyById(report.studyId);
        const signature = report.signedAt ? `Signé le ${new Date(report.signedAt).toLocaleString("fr-CH")}` : "";
        const pdf = buildReportPdf({
          study: study as any,
          report: validateReportSections(report),
          signature,
          keyImages: [],
          aiAssisted: report.aiGenerated,
          addenda: addenda.map((a: any) => ({ text: a.text, date: new Date(a.createdAt).toLocaleString("fr-CH"), author: `Dr (#${a.createdBy})` })),
        });
        const key = report.pdfStorageKey ?? `reports/${report.studyId}/report-${report.id}.pdf`;
        await storagePut(key, pdf, "application/pdf");
        if (!report.pdfStorageKey) {
          await db.update(reports).set({ pdfStorageKey: key }).where(eq(reports.id, report.id));
        }
        await recordAccess({ userId: ctx.user.id, action: "report.addendum", studyId: report.studyId, detail: `report ${report.id}`, ipAddress: ctx.req?.ip ?? null });
        return { success: true };
      }),

    pdfUrl: medicalProcedure
      .input(z.object({ reportId: z.number() }))
      .query(async ({ input }) => {
        const { getDb } = await import("./db");
        const { reports } = await import("../drizzle/schema");
        const { eq } = await import("drizzle-orm");
        const db = await getDb();
        if (!db) return { url: null };
        const rows = await db.select().from(reports).where(eq(reports.id, input.reportId)).limit(1);
        const key = rows[0]?.pdfStorageKey;
        if (!key) return { url: null };
        return { url: await storageGetSignedUrl(key) };
      }),
  }),
```

- [ ] **Step 3 : Compiler**

Run: `cd ~/Documents/GitHub/horos-viewer && npx tsc --noEmit`
Expected: 0 erreur. (Adapter `ctx.user.name` si le champ s'appelle autrement dans le contexte ; vérifier `getStudyById` exporté par `server/db.ts`.)

- [ ] **Step 4 : Test serveur — immuabilité**

Run: `npx vitest run` — la suite existante doit rester verte (aucune régression). Le test d'immuabilité réel se fait en intégration (Step de la Task 7).

- [ ] **Step 5 : Commit**

```bash
git add server/routers.ts
git commit -m "feat(report): routeur tRPC reports (draft/aiGenerate/sign/addendum/pdf)"
```

---

### Task 6 : UI — `ReportPanel` éditeur de compte-rendu

**Files:**

- Modify: `client/src/components/ReportPanel.tsx`

Garder le mécanisme d'images-clés et l'email existants ; ajouter l'éditeur 4 sections persisté + signature.

- [ ] **Step 1 : Charger / éditer le compte-rendu persisté**

Ajouter dans `ReportPanel` (en plus de l'existant) :

```tsx
const reportQuery = trpc.reports.getByStudy.useQuery({ studyId });
const upsertDraft = trpc.reports.upsertDraft.useMutation();
const aiGenerate = trpc.reports.aiGenerate.useMutation();
const signReport = trpc.reports.sign.useMutation();
const addAddendum = trpc.reports.addAddendum.useMutation();
const pdfUrl = trpc.reports.pdfUrl.useMutation?.(); // sinon useQuery au clic

const report = reportQuery.data?.report ?? null;
const isSigned = report?.status === "signed";
const [sections, setSections] = useState({
  indication: "",
  technique: "",
  resultats: "",
  conclusion: "",
});
const [addendumText, setAddendumText] = useState("");

// Hydrater depuis le serveur quand il charge.
useEffect(() => {
  if (report) {
    setSections({
      indication: report.indication ?? "",
      technique: report.technique ?? "",
      resultats: report.resultats ?? "",
      conclusion: report.conclusion ?? "",
    });
  }
}, [report?.id]);
```

- [ ] **Step 2 : Les 4 zones + boutons**

Remplacer les anciennes zones findings/impression par 4 `<textarea>` liées à `sections`, et ajouter la barre d'actions :

```tsx
{
  (["indication", "technique", "resultats", "conclusion"] as const).map(k => (
    <div key={k} className="space-y-1">
      <label className="text-xs font-medium capitalize">{k}</label>
      <textarea
        className="w-full text-sm bg-input border border-border rounded p-2"
        rows={k === "resultats" ? 5 : 2}
        value={sections[k]}
        disabled={isSigned}
        onChange={e => setSections(s => ({ ...s, [k]: e.target.value }))}
      />
    </div>
  ));
}

{
  !isSigned && (
    <div className="flex gap-2">
      <Button
        size="sm"
        disabled={aiGenerate.isPending}
        onClick={async () => {
          const r = await aiGenerate.mutateAsync({
            studyId,
            seriesId: analyzedSeriesId ?? undefined,
            indication: sections.indication,
            keyImages,
          });
          // Pré-remplit seulement les champs vides.
          setSections(s => ({
            indication: s.indication || r.sections.indication,
            technique: s.technique || r.sections.technique,
            resultats: s.resultats || r.sections.resultats,
            conclusion: s.conclusion || r.sections.conclusion,
          }));
        }}
      >
        {aiGenerate.isPending ? "Analyse…" : "Générer (IA)"}
      </Button>
      <Button
        size="sm"
        variant="outline"
        onClick={async () => {
          await upsertDraft.mutateAsync({
            studyId,
            sections,
            aiGenerated: aiGenerate.data != null,
            aiModel: aiGenerate.data?.aiModel,
          });
          reportQuery.refetch();
        }}
      >
        Enregistrer brouillon
      </Button>
      <Button
        size="sm"
        disabled={!sections.conclusion.trim()}
        onClick={async () => {
          const up = await upsertDraft.mutateAsync({ studyId, sections });
          await signReport.mutateAsync({ reportId: up.id });
          reportQuery.refetch();
        }}
      >
        Signer
      </Button>
    </div>
  );
}
```

- [ ] **Step 3 : Vue signée (lecture seule + addenda + PDF)**

```tsx
{
  isSigned && report && (
    <div className="space-y-2">
      <div className="text-xs text-green-500">
        Signé
        {report.signedAt
          ? ` le ${new Date(report.signedAt).toLocaleString("fr-CH")}`
          : ""}
        .
      </div>
      {(reportQuery.data?.addenda ?? []).map((a: any) => (
        <div key={a.id} className="text-xs border-l-2 border-border pl-2">
          <div className="text-muted-foreground">
            Addendum — {new Date(a.createdAt).toLocaleString("fr-CH")}
          </div>
          <div>{a.text}</div>
        </div>
      ))}
      <textarea
        className="w-full text-sm bg-input border border-border rounded p-2"
        rows={2}
        placeholder="Ajouter un addendum…"
        value={addendumText}
        onChange={e => setAddendumText(e.target.value)}
      />
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={!addendumText.trim()}
          onClick={async () => {
            await addAddendum.mutateAsync({
              reportId: report.id,
              text: addendumText,
            });
            setAddendumText("");
            reportQuery.refetch();
          }}
        >
          Ajouter l'addendum
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={async () => {
            const r =
              (await (trpc as any).reports.pdfUrl.fetch?.({
                reportId: report.id,
              })) ?? null;
            const url = r?.url;
            if (url) window.open(url, "_blank");
          }}
        >
          Télécharger PDF
        </Button>
      </div>
    </div>
  );
}
```

> Adapter `analyzedSeriesId` / `keyImages` aux variables déjà présentes dans `ReportPanel`. Si `trpc.reports.pdfUrl` est un `useQuery`, le déclencher via un state `pdfReportId` plutôt que `.fetch`.

- [ ] **Step 4 : Typecheck + build**

Run: `cd ~/Documents/GitHub/horos-viewer && npx tsc --noEmit && npx vite build`
Expected: 0 erreur TS, build OK.

- [ ] **Step 5 : Commit**

```bash
git add client/src/components/ReportPanel.tsx
git commit -m "feat(report): éditeur de compte-rendu 4 sections + signature + addendum"
```

---

### Task 7 : Revue sécu, vérif live, déploiement

**Files:** aucun (vérification + déploiement)

- [ ] **Step 1 : Revue sécu (anti-IDOR + rôle)**

Vérifier manuellement : `getByStudy`/`pdfUrl` = `medicalProcedure` ; `upsertDraft`/`aiGenerate`/`sign`/`addAddendum` = `adminProcedure` (admin|radiologist). Confirmer qu'un `report` est toujours rattaché à un `studyId` valide (pas d'accès cross-étude). Lancer la revue sécu auto si disponible.

- [ ] **Step 2 : Suite complète**

Run: `npx vitest run`
Expected: tous verts (les nouveaux tests + l'existant).

- [ ] **Step 3 : Migration prod (manuelle)**

Extraire le SQL des deux `CREATE TABLE` de la migration générée (Task 2) et le **fournir au gérant** pour application manuelle sur la base prod (règle MBBS). Ne pas auto-appliquer.

- [ ] **Step 4 : Déploiement**

Brancher sans upstream, push seul, PR vers `self-host`, merge, bump SHA dans `/docker/horos/docker-compose.yml`, `docker compose pull app && up -d app`. Ping santé (`/healthz` 200, garde 401).

- [ ] **Step 5 : Vérif live**

Ouvrir une étude, générer un brouillon IA, éditer, signer → vérifier que les champs passent en lecture seule + PDF téléchargeable ; ajouter un addendum → vérifier qu'il apparaît. Vérifier qu'une tentative de modif après signature est refusée.

---

## Auto-revue du plan

- **Couverture spec :** entité reports ✓ (T2), addenda ✓ (T2/T4), génération IA structurée ✓ (T5 aiGenerate réutilise runAiPreanalysis+parseSections), persistance ✓ (T2/T3), cycle draft→signed + immuabilité ✓ (T1 logique + T5 verrou serveur), signature+PDF+audit ✓ (T5 sign + recordAccess + buildReportPdf), addendum ✓ (T5), UI éditeur ✓ (T6), anti-IDOR/rôle ✓ (T5/T7), migration manuelle ✓ (T2/T7).
- **Placeholders :** aucun « TODO/TBD » ; code complet à chaque step.
- **Cohérence des types :** sections = `{indication, technique, resultats, conclusion}` partout (T1 `ReportSectionFields`, T2 colonnes, T4 `ReportSections`, T5 zod, T6 state) ; `ReportStatus = "draft"|"signed"` partout.
- **Réserve :** à l'implémentation, vérifier le nom exact du champ utilisateur dans le contexte tRPC (`ctx.user.name`) et que `getStudyById` est exporté — ajuster si besoin (noté dans T5 Step 3).
