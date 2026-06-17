# Thick-slab MIP/MinIP natif en vue 2D — Plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development / executing-plans. Steps en `- [ ]`.

**Goal:** Ajouter un mode « Épaisseur 2D » (thick-slab MIP/MinIP/Moyenne) à la vue 2D, via un viewport volumique mono-plan, sans casser le rendu StackViewport par défaut.

**Architecture:** helper pur `isReconstructable` ; nouveau mode `"slab2d"` dans `VolumeViewer` (1 viewport ORTHOGRAPHIC AXIAL + slab, factorisé depuis le chemin `mpr`) ; toggle `slab2dOn` dans `Viewer` qui monte `VolumeViewer mode="slab2d"` à la place de `CornerstoneViewer` quand actif + série reconstructible, avec repli stack.

**Tech Stack:** React 19, Cornerstone3D (ORTHOGRAPHIC viewport, `setSlabThickness`/`setBlendMode`), Vitest.

**Branche :** `feat/mip-2d-native` (déjà créée depuis `self-host`).

---

### Task 1 : helper pur `isReconstructable`

**Files:** Modify `client/src/lib/slabBlend.ts` (ou nouveau `client/src/lib/volumeReconstruct.ts`) ; Test associé.

- [ ] **Step 1 : test (échec)**

```typescript
// client/src/lib/volumeReconstruct.test.ts
import { describe, it, expect } from "vitest";
import { isReconstructable, clampSlabThickness } from "./volumeReconstruct";

describe("isReconstructable", () => {
  it(">= 2 imageIds → true", () => {
    expect(isReconstructable(["a", "b"])).toBe(true);
  });
  it("< 2 → false", () => {
    expect(isReconstructable(["a"])).toBe(false);
    expect(isReconstructable([])).toBe(false);
    expect(isReconstructable(undefined)).toBe(false);
  });
});

describe("clampSlabThickness", () => {
  it("borne entre 0 et max", () => {
    expect(clampSlabThickness(-5, 100)).toBe(0);
    expect(clampSlabThickness(150, 100)).toBe(100);
    expect(clampSlabThickness(20, 100)).toBe(20);
  });
});
```

- [ ] **Step 2 : lancer (échec)** — `pnpm exec vitest run client/src/lib/volumeReconstruct.test.ts`

- [ ] **Step 3 : implémenter**

```typescript
// client/src/lib/volumeReconstruct.ts
/** Une série est reconstructible en volume si elle a au moins 2 coupes. PUR. */
export function isReconstructable(
  imageIds: readonly string[] | undefined
): boolean {
  return !!imageIds && imageIds.length >= 2;
}

/** Borne l'épaisseur de dalle (mm) dans [0, max]. PUR. */
export function clampSlabThickness(mm: number, max: number): number {
  if (!Number.isFinite(mm)) return 0;
  return Math.max(0, Math.min(max, mm));
}
```

- [ ] **Step 4 : lancer (succès)** — `pnpm exec vitest run client/src/lib/volumeReconstruct.test.ts`
- [ ] **Step 5 : commit** — `git add client/src/lib/volumeReconstruct.* && git commit -m "feat(viewer): helpers isReconstructable + clampSlabThickness (purs)"`

---

### Task 2 : mode `"slab2d"` dans `VolumeViewer`

**Files:** Modify `client/src/components/VolumeViewer.tsx`

- [ ] **Step 1 : élargir le type mode**

`mode: "mpr" | "3d"` → `mode: "mpr" | "3d" | "slab2d"`.

- [ ] **Step 2 : branche d'init `slab2d`**

S'inspirer EXACTEMENT de la branche `mode === "mpr"` (qui crée `MPR_AXIAL` ORTHOGRAPHIC + `setVolumesForViewports` + applique slab). Pour `slab2d`, créer **UN SEUL** viewport ORTHOGRAPHIC `OrientationAxis.AXIAL` (sur le `<div>` racine du composant, pas la grille 3 plans), charger le volume (`volumeId`/`setVolumesForViewports` comme mpr), activer les outils W/L + zoom + pan + stack-scroll molette, puis appliquer le slab :

```typescript
const blendKey = slabModeToBlend(slabMode ?? "mip");
const blend = (Enums as any).BlendModes?.[blendKey];
vp.setSlabThickness(slabThicknessMm || 0.1);
if (blend !== undefined) vp.setBlendMode(blend);
vp.render();
```

Réutiliser l'effet existant qui réagit aux changements de `slabThicknessMm`/`slabMode` (le même que mpr) — étendre sa condition pour inclure `slab2d`. **Factoriser** la fonction d'application du slab si elle est dupliquée (DRY) — un helper local `applySlab(vp, thicknessMm, mode, Enums)`.

- [ ] **Step 3 : layout**

En `slab2d`, n'afficher qu'un conteneur plein (pas la grille axial/sagittal/coronal de mpr). Garde un `ref` dédié (`slab2dRef`) ou réutilise `axialRef` selon la structure JSX du composant (l'implémenteur choisit le plus simple sans casser mpr/3d).

- [ ] **Step 4 : compilation** — `pnpm check` (PASS). Vérifier que `mode="mpr"` et `mode="3d"` ne sont pas affectés.
- [ ] **Step 5 : commit** — `git add client/src/components/VolumeViewer.tsx && git commit -m "feat(viewer): mode slab2d (viewport volumique mono-plan + thick-slab)"`

---

### Task 3 : toggle « Épaisseur 2D » dans `Viewer`

**Files:** Modify `client/src/pages/Viewer.tsx`

- [ ] **Step 1 : volume + reconstructibilité de la série courante**

Si `useOrthancVolume` n'est pas déjà appelé pour la 2D, l'instancier pour `selectedSeries` (mirror du wiring MPR existant). Calculer
`const reconstructable = isReconstructable(volume.imageIds)` (importer `isReconstructable` de `@/lib/volumeReconstruct`). Ajouter `const [slab2dOn, setSlab2dOn] = useState(false);`.

- [ ] **Step 2 : désactiver au changement de série non reconstructible**

`useEffect(() => { if (!reconstructable && slab2dOn) setSlab2dOn(false); }, [reconstructable, slab2dOn]);`

- [ ] **Step 3 : bouton toggle + contrôles slab en 2D**

Dans la barre d'outils 2D (près des boutons 2D/MPR/3D), ajouter un bouton « Épaisseur 2D » (icône `Layers`),
`disabled={!reconstructable}`, `title` explicite (« série non reconstructible » si désactivé), `onClick={() => setSlab2dOn(v => !v)}`, classe active si `slab2dOn`. Rendre les contrôles slab (slider `slabThicknessMm` + `<select>` `SLAB_MODES`) **aussi** visibles quand `viewMode === "2d" && slab2dOn` (aujourd'hui ils ne s'affichent que pour `viewMode === "mpr"` — étendre la condition).

- [ ] **Step 4 : rendu conditionnel de la cellule 2D**

Là où la 2D rend `<CornerstoneViewer>` (cellule 1x1) : si `slab2dOn && reconstructable`, monter
`<VolumeViewer mode="slab2d" volumeId={volume.volumeId} slabThicknessMm={slabThicknessMm} slabMode={slabMode} />`
à la place ; sinon `<CornerstoneViewer>` (inchangé). (En grille multi-cellules, garder le stack — slab2d en 1x1 seulement pour la v1.) Repli : si le `VolumeViewer` slab2d signale une erreur de volume, revenir au stack (`setSlab2dOn(false)` + toast) — réutiliser un `onError`/try existant si présent, sinon laisser le repli au changement de série.

- [ ] **Step 5 : compilation** — `pnpm check` (PASS).
- [ ] **Step 6 : commit** — `git add client/src/pages/Viewer.tsx && git commit -m "feat(viewer): toggle épaisseur 2d (mip/minip) avec repli stack"`

---

### Task 4 : vérification + déploiement

- [ ] **Step 1** — `pnpm check && pnpm exec vitest run` → tout vert.
- [ ] **Step 2** — `git push -u origin feat/mip-2d-native` ; puis (séparé) `gh pr create --base self-host ...`.
- [ ] **Step 3** — `gh run watch <id> --exit-status` (gate verify+build) ; `gh pr merge <num> --merge --delete-branch`.
- [ ] **Step 4** — déployer le SHA de merge (`/docker/horos` : sed image → pull → `up -d migrate` (no-op) → `up -d app`).
- [ ] **Step 5** — ping : healthz 200, garde 401, bonne image.
- [ ] **Step 6** — mémoire : `mediview-horos-parity.md` (MIP 2D natif déployé) + index `MEMORY.md`.

---

## Notes

- Mode **additif** : le StackViewport 2D par défaut est inchangé → risque de régression contenu.
- Réutilise le chemin volumique MPR existant (volume + slab) → DRY.
- v1 : slab2d en 1x1, lecture/W-L/zoom/scroll (pas d'annotations/seg). Aucune migration, aucun PHI.
