# Comparatif d'antériorités (côte à côte) — Plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mode comparatif 1×2 dans le viewer 2D : étude courante à gauche, une antériorité choisie à droite, défilement + W/L synchronisés (bascule), sélecteur de série.

**Architecture:** `CornerstoneViewer` est piloté par props (`currentSlice`, `windowWidth/Center`, `imageUrls`, `instances`, `instanceKey`) → la synchro est un simple partage d'état React entre deux instances. Le mode comparatif est une branche de rendu supplémentaire dans `Viewer.tsx` (prioritaire sur les layouts 1x1/mosaïque quand actif), alimentée par les requêtes existantes `series.listByStudy` + `instances.listBySeries` pour l'étude antérieure. Aucune modification de `CornerstoneViewer` ni du serveur.

**Tech Stack:** React 19, tRPC v11, Vitest. Fichiers : `client/src/lib/compareSync.ts` (nouveau, pur), `client/src/pages/Viewer.tsx` (modifié). Aucune migration DB.

**Repo/branche :** `/Users/mbbssarl/Documents/GitHub/horos-viewer`, branche `feat/compare-priors` (contient déjà la spec). Déploiement `self-host` (PR), jamais `main`.

---

### Task 1 : Logique pure — `compareSync.ts` (TDD)

**Files:**

- Create: `client/src/lib/compareSync.ts`
- Test: `client/src/lib/compareSync.test.ts`

- [ ] **Step 1 : Écrire le test qui échoue**

```ts
// client/src/lib/compareSync.test.ts
import { describe, it, expect } from "vitest";
import { clampPriorSlice, pickPriorSeries } from "./compareSync";

describe("clampPriorSlice", () => {
  it("laisse passer un indice valide", () => {
    expect(clampPriorSlice(5, 10)).toBe(5);
  });
  it("borne à la dernière coupe quand l'antériorité est plus courte", () => {
    expect(clampPriorSlice(50, 10)).toBe(9);
  });
  it("borne à 0 les indices négatifs", () => {
    expect(clampPriorSlice(-3, 10)).toBe(0);
  });
  it("renvoie 0 quand l'antériorité est vide ou dégénérée", () => {
    expect(clampPriorSlice(4, 0)).toBe(0);
    expect(clampPriorSlice(4, -2)).toBe(0);
    expect(clampPriorSlice(NaN, 10)).toBe(0);
    expect(clampPriorSlice(2.7, 10)).toBe(2);
  });
});

describe("pickPriorSeries", () => {
  const series = [
    { id: 11, modality: "SC" },
    { id: 12, modality: "CT" },
    { id: 13, modality: "CT" },
  ];
  it("préfère la première série de même modalité que la courante", () => {
    expect(pickPriorSeries(series, "CT")).toBe(12);
  });
  it("est insensible à la casse/espaces sur la modalité", () => {
    expect(pickPriorSeries(series, " ct ")).toBe(12);
  });
  it("replie sur la première série quand aucune ne matche", () => {
    expect(pickPriorSeries(series, "MR")).toBe(11);
  });
  it("replie sur la première série sans modalité courante", () => {
    expect(pickPriorSeries(series, null)).toBe(11);
    expect(pickPriorSeries(series, undefined)).toBe(11);
  });
  it("renvoie null sur liste vide ou absente", () => {
    expect(pickPriorSeries([], "CT")).toBe(null);
    expect(pickPriorSeries(null as any, "CT")).toBe(null);
  });
});
```

- [ ] **Step 2 : Vérifier l'échec**

Run: `cd /Users/mbbssarl/Documents/GitHub/horos-viewer && npx vitest run client/src/lib/compareSync.test.ts`
Expected: FAIL — `Cannot find module './compareSync'`.

- [ ] **Step 3 : Implémenter**

```ts
// client/src/lib/compareSync.ts
/**
 * Logique PURE du mode comparatif d'antériorités (étude courante + 1 antérieure
 * côte à côte). Sans DOM ni réseau, donc testable :
 *  - `clampPriorSlice` borne l'indice de coupe partagé au total de l'antériorité
 *    (les deux études n'ont pas le même nombre de coupes) ;
 *  - `pickPriorSeries` choisit la série à afficher à droite (même modalité que
 *    la courante si possible, sinon la première).
 */

/** Borne l'indice de coupe dans [0, priorTotal-1]. Dégénéré → 0. */
export function clampPriorSlice(
  currentSlice: number,
  priorTotal: number
): number {
  if (!Number.isFinite(priorTotal) || priorTotal <= 0) return 0;
  if (!Number.isFinite(currentSlice) || currentSlice < 0) return 0;
  return Math.min(Math.floor(currentSlice), priorTotal - 1);
}

export interface PriorSeriesLike {
  id: number;
  modality?: string | null;
}

/**
 * Série de l'antériorité à afficher : première série de MÊME modalité que la
 * courante si elle existe, sinon la première série, sinon null.
 */
export function pickPriorSeries(
  series: readonly PriorSeriesLike[] | null | undefined,
  currentModality?: string | null
): number | null {
  if (!series || series.length === 0) return null;
  const wanted = (currentModality ?? "").trim().toUpperCase();
  if (wanted) {
    const match = series.find(
      s => (s.modality ?? "").trim().toUpperCase() === wanted
    );
    if (match) return match.id;
  }
  return series[0].id;
}
```

- [ ] **Step 4 : Vérifier le succès**

Run: `npx vitest run client/src/lib/compareSync.test.ts`
Expected: PASS (9 tests verts). Puis `npx tsc --noEmit` → 0 erreur.

- [ ] **Step 5 : Commit**

```bash
git add client/src/lib/compareSync.ts client/src/lib/compareSync.test.ts
git commit -m "feat(compare): logique pure du comparatif (clampPriorSlice, pickPriorSeries)"
```

---

### Task 2 : État + données antériorité + bouton « Comparer »

**Files:**

- Modify: `client/src/pages/Viewer.tsx`

- [ ] **Step 1 : Imports**

En tête de `client/src/pages/Viewer.tsx`, près des autres imports `@/lib` :

```ts
import { clampPriorSlice, pickPriorSeries } from "@/lib/compareSync";
```

- [ ] **Step 2 : État du mode comparatif**

Juste après la déclaration `const [priorsOpen, setPriorsOpen] = useState(false);` (~ligne 515), ajouter :

```ts
// ── Mode comparatif d'antériorités (1×2 : courant + antérieure) ───────────
// null = mode inactif. La synchro (défilement + W/L) est ON par défaut ;
// quand elle est OFF, le viewer de droite garde son propre état local.
const [comparePriorStudyId, setComparePriorStudyId] = useState<number | null>(
  null
);
const [comparePriorSeriesId, setComparePriorSeriesId] = useState<number | null>(
  null
);
const [compareSyncOn, setCompareSyncOn] = useState(true);
// État LOCAL du viewer droit (utilisé seulement quand la synchro est OFF).
const [priorSlice, setPriorSlice] = useState(0);
const [priorWindowWidth, setPriorWindowWidth] = useState(400);
const [priorWindowCenter, setPriorWindowCenter] = useState(40);
```

- [ ] **Step 3 : Requêtes des données de l'antériorité + auto-sélection de série**

Après le bloc des requêtes existantes de l'étude courante (`trpc.instances.listBySeries.useQuery` / `cellImageUrls`), ajouter :

```ts
// Séries puis coupes de l'étude ANTÉRIEURE comparée (mode comparatif).
const { data: priorSeriesList } = trpc.series.listByStudy.useQuery(
  { studyId: comparePriorStudyId! },
  { enabled: !!comparePriorStudyId }
);
// Auto-sélection : même modalité que la courante si possible, sinon 1re série.
useEffect(() => {
  if (!comparePriorStudyId) {
    setComparePriorSeriesId(null);
    return;
  }
  if (comparePriorSeriesId != null) return; // déjà choisie (sélecteur)
  const picked = pickPriorSeries(
    (priorSeriesList ?? []) as any[],
    study?.modality
  );
  if (picked != null) setComparePriorSeriesId(picked);
}, [
  comparePriorStudyId,
  priorSeriesList,
  comparePriorSeriesId,
  study?.modality,
]);

const { data: priorInstancesList } = trpc.instances.listBySeries.useQuery(
  { seriesId: comparePriorSeriesId! },
  { enabled: !!comparePriorSeriesId }
);
const priorImageUrls = useMemo(
  () => (priorInstancesList ?? []).map((inst: any) => inst.storageUrl || ""),
  [priorInstancesList]
);
const priorInstances = useMemo(
  () =>
    (priorInstancesList ?? []).map((inst: any) => ({
      id: inst.id,
      storageUrl: inst.storageUrl,
    })),
  [priorInstancesList]
);
// Métadonnées de l'antériorité pour l'en-tête du viewport droit.
const comparedPrior = useMemo(
  () => priors.find((p: any) => p.id === comparePriorStudyId) ?? null,
  [priors, comparePriorStudyId]
);
```

- [ ] **Step 4 : Bouton « Comparer » dans le dialog Antér.**

Dans le dialog « Antériorités du patient » (~ligne 2453), à côté du bouton « Ouvrir » existant, ajouter un second bouton. Le bloc des deux boutons devient :

```tsx
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={() => {
                    setPriorsOpen(false);
                    navigate(`/viewer/${p.id}`);
                  }}
                >
                  Ouvrir
                </Button>
                <Button
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => {
                    setComparePriorSeriesId(null); // re-sélection auto de série
                    setComparePriorStudyId(p.id);
                    setViewMode("2d"); // le comparatif est 2D uniquement
                    setPriorsOpen(false);
                  }}
                >
                  Comparer
                </Button>
```

- [ ] **Step 5 : Typecheck**

Run: `npx tsc --noEmit`
Expected: 0 erreur. (Note : `setViewMode` existe déjà ; `priors`, `study`, `navigate` aussi.)

- [ ] **Step 6 : Commit**

```bash
git add client/src/pages/Viewer.tsx
git commit -m "feat(compare): état du mode comparatif + données antériorité + bouton Comparer"
```

---

### Task 3 : Rendu 1×2 comparatif + synchro + contrôles

**Files:**

- Modify: `client/src/pages/Viewer.tsx`

- [ ] **Step 1 : Branche de rendu comparatif (prioritaire sur les layouts)**

Dans la zone de rendu (~ligne 2672), le code actuel est :

```tsx
              ) : viewMode === "2d" ? (
                viewportLayout === "1x1" ? (
```

Le transformer en insérant la branche comparatif AVANT le test de layout :

```tsx
              ) : viewMode === "2d" ? (
                comparePriorStudyId != null ? (
                  // ── Mode comparatif : courant (gauche) + antériorité (droite).
                  // Synchro ON → les 2 viewers partagent currentSlice + W/L (le
                  // viewer droit est borné à son propre total de coupes).
                  // Synchro OFF → le viewer droit a son état local prior*.
                  <div className="absolute inset-0 grid grid-cols-2 gap-0.5 bg-border">
                    <div
                      id="cornerstone-viewport"
                      className="relative bg-black overflow-hidden ring-1 ring-border"
                    >
                      <CornerstoneViewer
                        ref={activeViewerRef}
                        imageUrls={cellImageUrls}
                        currentSlice={currentSlice}
                        onSliceChange={setCurrentSlice}
                        activeTool={activeTool}
                        windowWidth={windowWidth}
                        windowCenter={windowCenter}
                        onWindowLevelChange={(ww, wc) => {
                          setWindowWidth(ww);
                          setWindowCenter(wc);
                        }}
                        onZoomChange={setZoomPercent}
                        instances={cellInstances}
                        savedAnnotations={savedAnnotations}
                        onSaveAnnotation={handleSaveAnnotation}
                        onRoiStats={setHuStats}
                      />
                    </div>
                    <div className="relative bg-black overflow-hidden ring-1 ring-border">
                      {priorImageUrls.length > 0 ? (
                        <CornerstoneViewer
                          instanceKey="priorCompare"
                          imageUrls={priorImageUrls}
                          currentSlice={
                            compareSyncOn
                              ? clampPriorSlice(
                                  currentSlice,
                                  priorImageUrls.length
                                )
                              : clampPriorSlice(
                                  priorSlice,
                                  priorImageUrls.length
                                )
                          }
                          onSliceChange={
                            compareSyncOn ? setCurrentSlice : setPriorSlice
                          }
                          activeTool={activeTool}
                          windowWidth={
                            compareSyncOn ? windowWidth : priorWindowWidth
                          }
                          windowCenter={
                            compareSyncOn ? windowCenter : priorWindowCenter
                          }
                          onWindowLevelChange={(ww, wc) => {
                            if (compareSyncOn) {
                              setWindowWidth(ww);
                              setWindowCenter(wc);
                            } else {
                              setPriorWindowWidth(ww);
                              setPriorWindowCenter(wc);
                            }
                          }}
                          instances={priorInstances}
                        />
                      ) : (
                        <div className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
                          Aucune image dans cette antériorité
                        </div>
                      )}
                      {/* En-tête : quel examen antérieur on regarde + sélecteur de série */}
                      <div className="absolute top-2 left-2 right-2 flex items-center gap-2 text-[10px] font-mono text-amber-300/90 pointer-events-none">
                        <span className="bg-black/60 px-1.5 py-0.5 rounded">
                          ANTÉRIEUR · {comparedPrior?.modality || "?"} ·{" "}
                          {comparedPrior?.studyDate || "date ?"}
                        </span>
                        {(priorSeriesList ?? []).length > 1 && (
                          <select
                            className="pointer-events-auto bg-black/70 border border-border rounded px-1 py-0.5 text-[10px] text-foreground"
                            value={comparePriorSeriesId ?? ""}
                            onChange={e =>
                              setComparePriorSeriesId(Number(e.target.value))
                            }
                          >
                            {(priorSeriesList ?? []).map((s: any) => (
                              <option key={s.id} value={s.id}>
                                {s.seriesDescription || s.modality || `Série ${s.id}`}
                              </option>
                            ))}
                          </select>
                        )}
                      </div>
                    </div>
                  </div>
                ) : viewportLayout === "1x1" ? (
```

(La suite — le rendu 1x1 historique puis la mosaïque — reste strictement inchangée.)

- [ ] **Step 2 : Contrôles barre d'outils (bascule synchro + fermer)**

Dans la barre d'outils, dans le groupe 2D (juste après le bouton « Antér. » existant, qui est dans le bloc `{viewMode === "2d" && (...)}`), ajouter :

```tsx
{
  comparePriorStudyId != null && (
    <>
      <button
        className={`toolbar-btn ${compareSyncOn ? "active" : ""}`}
        title="Lier / délier le défilement et le W/L des deux vues"
        onClick={() => setCompareSyncOn(v => !v)}
      >
        <Layers className="w-4 h-4" />
        <span className="text-[9px]">{compareSyncOn ? "Lié" : "Délié"}</span>
      </button>
      <button
        className="toolbar-btn"
        title="Fermer le mode comparatif"
        onClick={() => {
          setComparePriorStudyId(null);
          setComparePriorSeriesId(null);
        }}
      >
        <Square className="w-4 h-4" />
        <span className="text-[9px]">Fermer comp.</span>
      </button>
    </>
  );
}
```

(`Layers` et `Square` sont déjà importés de lucide-react dans Viewer.tsx.)

- [ ] **Step 3 : Typecheck + build**

Run: `npx tsc --noEmit && npx vite build`
Expected: 0 erreur TS, build OK.

- [ ] **Step 4 : Tests complets (non-régression)**

Run: `npx vitest run`
Expected: toute la suite verte (>1300 tests).

- [ ] **Step 5 : Commit**

```bash
git add client/src/pages/Viewer.tsx
git commit -m "feat(compare): rendu 1×2 comparatif + synchro défilement/W-L + contrôles"
```

---

### Task 4 : Déploiement + vérification live

**Files:** aucun (PR + déploiement + vérif)

- [ ] **Step 1 : Push (seul, contrainte hook agent-guard) puis PR puis merge — commandes SÉPARÉES**

```bash
git push origin HEAD:refs/heads/feat/compare-priors
```

puis :

```bash
gh pr create --base self-host --head feat/compare-priors --title "Comparatif d'antériorités côte à côte" --body "Mode 1×2 : étude courante + antériorité, synchro défilement/W-L (bascule), sélecteur de série. Spec : docs/superpowers/specs/2026-06-12-comparatif-anteriorites-design.md. Aucune migration DB."
```

puis :

```bash
gh pr merge <numéro> --merge
```

- [ ] **Step 2 : Attendre le build CI (image GHCR) puis déployer**

```bash
git fetch origin self-host && NEW=$(git rev-parse origin/self-host)
ssh root@76.13.55.44 "cd /docker/horos && OLD=\$(grep -oE 'horos-viewer:[0-9a-f]+' docker-compose.yml | head -1 | cut -d: -f2) && sed -i \"s/\$OLD/$NEW/g\" docker-compose.yml && docker compose pull app && docker compose up -d app"
```

- [ ] **Step 3 : Santé**

```bash
curl -s -o /dev/null -w "healthz=%{http_code}\n" https://mediview.mbbssarl.ch/healthz   # 200
curl -s -o /dev/null -w "guard=%{http_code}\n" https://mediview.mbbssarl.ch/api/audit/export.csv  # 401
```

- [ ] **Step 4 : Vérification live (Playwright)**

Sur `https://mediview.mbbssarl.ch/viewer/4` (étude « Unknown Patient », qui a 1 antériorité) :

1. cliquer « Antér. (1) » → le dialog liste l'antériorité avec les boutons **Ouvrir** ET **Comparer** ;
2. cliquer « Comparer » → la grille 1×2 apparaît (2 viewports, en-tête « ANTÉRIEUR · … » à droite) ;
3. vérifier la présence des boutons « Lié » et « Fermer comp. » dans la barre ;
4. cliquer « Fermer comp. » → retour au rendu 1×1 historique.

Critère : 0 erreur console, les 4 étapes passent.

---

## Auto-revue du plan

- **Couverture spec :** mode 1×2 ✓ (T3), antériorité chargée + série sélectionnable ✓ (T2/T3), synchro défilement+W/L avec bascule ✓ (T3, partage d'état + état local prior\*), entrer/sortir + choisir l'antériorité ✓ (T2 bouton Comparer, T3 Fermer comp.), bornage `clampPriorSlice` ✓ (T1/T3), erreur « aucune image » fail-soft ✓ (T3), tests logique pure ✓ (T1), aucune migration ✓, anti-IDOR via procédures existantes ✓.
- **Placeholders :** aucun ; code complet à chaque étape.
- **Cohérence des types :** `clampPriorSlice(currentSlice, priorTotal)` et `pickPriorSeries(series, modality)` identiques entre T1 (définition) et T2/T3 (usage) ; états `comparePriorStudyId/comparePriorSeriesId/compareSyncOn/priorSlice/priorWindowWidth/priorWindowCenter` définis en T2 et consommés en T3.
- **Réserves d'implémentation :** vérifier à l'exécution que `Layers`/`Square` sont bien importés (sinon les ajouter à l'import lucide-react) ; l'ancre exacte du bouton « Antér. » dans la barre ; le viewer droit n'a pas de `savedAnnotations`/`onSaveAnnotation` (délibéré : pas de persistance d'annotations sur l'antériorité en mode comparatif).
