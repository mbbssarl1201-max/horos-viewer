# Parité « feel » viewer Horos — Plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rapprocher le « feel » du viewer MediView de Horos : overlay curseur px/mm/valeur + position patient, règle calibrée en mm, affectation d'outil au bouton droit, dropdowns CLUT + table d'opacité, menu unifié « 2D/3D » regroupant les modes existants.

**Architecture:** Deux modules purs (`viewportOverlay`, `scaleBar`) testés ; `CornerstoneViewer` émet la position curseur, expose `setSecondaryTool`, et dessine la règle sur son canvas overlay ; `Viewer` enrichit les coins, ajoute les dropdowns CLUT/opacité, le contrôle bouton-souris et le menu 2D/3D (qui déclenche les bascules de mode déjà existantes). 100 % client, aucune migration.

**Tech Stack:** React 19 + Vite, Cornerstone3D, TypeScript, Vitest.

**Branche :** `feat/viewer-feel-parity` (déjà créée depuis `self-host`).

---

## Structure des fichiers

| Fichier                                       | Rôle                                                               | Action   |
| --------------------------------------------- | ------------------------------------------------------------------ | -------- |
| `client/src/lib/viewportOverlay.ts`           | formatage overlay (curseur, orientation, infos image) — PUR        | Créer    |
| `client/src/lib/viewportOverlay.test.ts`      | tests purs                                                         | Créer    |
| `client/src/lib/scaleBar.ts`                  | calcul règle calibrée — PUR                                        | Créer    |
| `client/src/lib/scaleBar.test.ts`             | tests purs                                                         | Créer    |
| `client/src/components/CornerstoneViewer.tsx` | `onCursor`, `setSecondaryTool`, dessin règle                       | Modifier |
| `client/src/pages/Viewer.tsx`                 | overlay enrichi, dropdowns CLUT/opacité, bouton souris, menu 2D/3D | Modifier |

---

### Task 1 : `viewportOverlay.ts` (pur)

**Files:**

- Create: `client/src/lib/viewportOverlay.ts`
- Test: `client/src/lib/viewportOverlay.test.ts`

- [ ] **Step 1 : tests (échec attendu)**

```typescript
// client/src/lib/viewportOverlay.test.ts
import { describe, it, expect } from "vitest";
import {
  formatCursorReadout,
  patientOrientationLabels,
  formatImageInfo,
} from "./viewportOverlay";

describe("formatCursorReadout", () => {
  it("px + mm + valeur", () => {
    const s = formatCursorReadout({
      xPx: 2224,
      yPx: 1759,
      xMm: 305.79,
      yMm: 241.9,
      value: 0,
    });
    expect(s).toContain("px (2224, 1759)");
    expect(s).toContain("305.8 mm");
    expect(s).toContain("241.9 mm");
    expect(s).toContain("Val 0");
  });
  it("mm omis si null", () => {
    const s = formatCursorReadout({
      xPx: 10,
      yPx: 20,
      xMm: null,
      yMm: null,
      value: 5,
    });
    expect(s).toContain("px (10, 20)");
    expect(s).not.toContain("mm");
  });
});

describe("patientOrientationLabels", () => {
  it("axial (iop standard) → L/R/A/P", () => {
    const l = patientOrientationLabels([1, 0, 0, 0, 1, 0]);
    expect(l.left).toBe("R");
    expect(l.right).toBe("L");
    expect(l.top).toBe("A");
    expect(l.bottom).toBe("P");
  });
  it("iop null → vides", () => {
    expect(patientOrientationLabels(null)).toEqual({
      top: "",
      bottom: "",
      left: "",
      right: "",
    });
  });
});

describe("formatImageInfo", () => {
  it("compose les lignes présentes", () => {
    const lines = formatImageInfo({
      rows: 512,
      cols: 512,
      zoomPct: 86,
      angleDeg: 0,
    });
    expect(lines.join(" ")).toContain("512");
    expect(lines.join(" ")).toContain("86");
  });
});
```

- [ ] **Step 2 : lancer (échec)**

Run: `pnpm exec vitest run client/src/lib/viewportOverlay.test.ts`
Expected: FAIL — module absent.

- [ ] **Step 3 : implémenter**

```typescript
// client/src/lib/viewportOverlay.ts
export interface CursorData {
  xPx: number;
  yPx: number;
  xMm: number | null;
  yMm: number | null;
  value: number | null;
}

/** Lecture curseur façon Horos : px + mm (si dispo) + valeur du pixel. PUR. */
export function formatCursorReadout(c: CursorData): string {
  const parts: string[] = [`px (${Math.round(c.xPx)}, ${Math.round(c.yPx)})`];
  if (c.xMm != null && c.yMm != null) {
    parts.unshift(`X: ${c.xMm.toFixed(1)} mm Y: ${c.yMm.toFixed(1)} mm`);
  }
  if (c.value != null) parts.push(`Val ${Math.round(c.value)}`);
  return parts.join(" — ");
}

/** Direction dominante d'un vecteur de cosinus directeurs → lettre anatomique. */
function axisLetter(x: number, y: number, z: number): string {
  const ax = Math.abs(x),
    ay = Math.abs(y),
    az = Math.abs(z);
  if (ax >= ay && ax >= az) return x < 0 ? "R" : "L";
  if (ay >= ax && ay >= az) return y < 0 ? "A" : "P";
  return z < 0 ? "F" : "H";
}

/** Étiquettes d'orientation patient à partir d'ImageOrientationPatient (6 val). PUR. */
export function patientOrientationLabels(iop: number[] | null): {
  top: string;
  bottom: string;
  left: string;
  right: string;
} {
  if (!iop || iop.length < 6)
    return { top: "", bottom: "", left: "", right: "" };
  const [rx, ry, rz, cx, cy, cz] = iop;
  const left = axisLetter(rx, ry, rz); // bord gauche = -direction ligne
  const top = axisLetter(cx, cy, cz); // bord haut = -direction colonne
  const opp = (l: string) =>
    ({ L: "R", R: "L", A: "P", P: "A", H: "F", F: "H" })[l] ?? "";
  return { left: opp(left), right: left, top: opp(top), bottom: top };
}

export function formatImageInfo(info: {
  rows?: number;
  cols?: number;
  zoomPct?: number;
  angleDeg?: number;
}): string[] {
  const lines: string[] = [];
  if (info.cols && info.rows) lines.push(`Image: ${info.cols} × ${info.rows}`);
  if (info.zoomPct != null)
    lines.push(
      `Zoom: ${Math.round(info.zoomPct)}%` +
        (info.angleDeg != null ? ` Angle: ${Math.round(info.angleDeg)}` : "")
    );
  return lines;
}
```

- [ ] **Step 4 : lancer (succès)** — `pnpm exec vitest run client/src/lib/viewportOverlay.test.ts`
- [ ] **Step 5 : commit** — `git add client/src/lib/viewportOverlay.* && git commit -m "feat(viewer): viewportOverlay — lecture curseur px/mm/valeur + orientation patient (pur)"`

---

### Task 2 : `scaleBar.ts` (pur)

**Files:**

- Create: `client/src/lib/scaleBar.ts`
- Test: `client/src/lib/scaleBar.test.ts`

- [ ] **Step 1 : tests (échec)**

```typescript
// client/src/lib/scaleBar.test.ts
import { describe, it, expect } from "vitest";
import { computeScaleBar } from "./scaleBar";

describe("computeScaleBar", () => {
  it("spacing null → null", () => {
    expect(computeScaleBar(null, 1, 500)).toBeNull();
  });
  it("zoom ≤ 0 → null", () => {
    expect(computeScaleBar(0.5, 0, 500)).toBeNull();
  });
  it("choisit un pas rond qui tient dans la largeur", () => {
    // 1px = 0.5mm écran ; 200px → 100mm dispo (max 1/4 = 25mm) → pas rond ≤ 25
    const r = computeScaleBar(0.5, 1, 800);
    expect(r).not.toBeNull();
    expect([1, 2, 5, 10, 20, 50, 100, 200]).toContain(r!.labelMm);
    expect(r!.barPx).toBeLessThanOrEqual(800 / 4 + 1);
  });
  it("zoom plus grand → barre plus longue pour le même mm", () => {
    const a = computeScaleBar(0.5, 1, 1000)!;
    const b = computeScaleBar(0.5, 2, 1000)!;
    // à mm égal, la barre est ~2× plus longue ; sinon le label augmente
    expect(b.barPx / b.labelMm).toBeCloseTo((a.barPx / a.labelMm) * 2, 1);
  });
});
```

- [ ] **Step 2 : lancer (échec)** — `pnpm exec vitest run client/src/lib/scaleBar.test.ts`

- [ ] **Step 3 : implémenter**

```typescript
// client/src/lib/scaleBar.ts
const NICE_MM = [1, 2, 5, 10, 20, 50, 100, 200, 500];

/**
 * Règle calibrée : choisit un pas « rond » (mm) dont la longueur écran tient dans
 * ~1/4 de `lengthPx`. `pixelSpacingMm` = taille d'un pixel image en mm ; `zoom` =
 * facteur (px écran / px image). PUR. null si non calculable.
 */
export function computeScaleBar(
  pixelSpacingMm: number | null,
  zoom: number,
  lengthPx: number
): { barPx: number; labelMm: number } | null {
  if (!pixelSpacingMm || pixelSpacingMm <= 0 || zoom <= 0 || lengthPx <= 0)
    return null;
  const screenPxPerMm = zoom / pixelSpacingMm; // px écran par mm
  const maxBarPx = lengthPx / 4;
  let chosen = NICE_MM[0];
  for (const mm of NICE_MM) {
    if (mm * screenPxPerMm <= maxBarPx) chosen = mm;
    else break;
  }
  return { barPx: chosen * screenPxPerMm, labelMm: chosen };
}
```

- [ ] **Step 4 : lancer (succès)** — `pnpm exec vitest run client/src/lib/scaleBar.test.ts`
- [ ] **Step 5 : commit** — `git add client/src/lib/scaleBar.* && git commit -m "feat(viewer): scaleBar — règle calibrée en mm (pur)"`

---

### Task 3 : `CornerstoneViewer` — curseur, bouton droit, règle

**Files:**

- Modify: `client/src/components/CornerstoneViewer.tsx`

- [ ] **Step 1 : ajouter la prop `onCursor` + le handle `setSecondaryTool`**

Dans `CornerstoneViewerProps`, ajouter :

```typescript
  /** Émet la position curseur (image px + mm + valeur) au survol ; null à la sortie. */
  onCursor?: (c: import("@/lib/viewportOverlay").CursorData | null) => void;
```

Dans `CornerstoneViewerHandle`, ajouter :

```typescript
  /** Assigne un outil au bouton DROIT (façon « Change the mouse button function »). */
  setSecondaryTool: (toolId: string) => void;
```

- [ ] **Step 2 : W/L par défaut sur le bouton droit + implémenter `setSecondaryTool`**

Dans `applyActiveTool` (après le bloc qui lie `Primary`), ajouter un binding W/L par défaut sur le
bouton droit (ne pas écraser si déjà posé) :

```typescript
try {
  toolGroup.setToolActive(map["wwwl"], {
    bindings: [{ mouseButton: cst.Enums.MouseBindings.Secondary }],
  });
} catch {}
```

Exposer dans `useImperativeHandle` :

```typescript
    setSecondaryTool: (toolId: string) => {
      try {
        const cst = cornerstoneToolsRef.current;
        const tg = toolGroupRef.current;
        if (!cst || !tg) return;
        const map = buildToolMap(cst);
        const name = map[toolId] || map["wwwl"];
        tg.setToolActive(name, {
          bindings: [{ mouseButton: cst.Enums.MouseBindings.Secondary }],
        });
      } catch (e) {
        console.warn("[Cornerstone3D] setSecondaryTool ignoré:", e);
      }
    },
```

> Adapter aux noms de refs réels (`cornerstoneToolsRef`/`toolGroupRef` ou équivalents présents dans le
> fichier). Si `buildToolMap`/refs ne sont pas en portée du handle, mémoriser le toolGroup dans une ref.

- [ ] **Step 3 : émettre la position curseur**

Sur l'élément viewport, ajouter des écouteurs `mousemove`/`mouseleave` (dans l'effet d'init, après
`enableElement`) qui calculent les coords image + mm + valeur et appellent `onCursor` :

```typescript
const emitCursor = (evt: MouseEvent) => {
  try {
    const vp = renderingEngineRef.current?.getViewport(viewportIdRef.current);
    if (!vp || !onCursorRef.current) return;
    const rect = (vp.element as HTMLElement).getBoundingClientRect();
    const canvasPt: [number, number] = [
      evt.clientX - rect.left,
      evt.clientY - rect.top,
    ];
    const world = vp.canvasToWorld(canvasPt);
    const img = vp.worldToIndex ? vp.worldToIndex(world) : null;
    const sp = vp.getImageData?.()?.spacing as number[] | undefined;
    const xPx = img ? img[0] : canvasPt[0];
    const yPx = img ? img[1] : canvasPt[1];
    const xMm = sp ? xPx * sp[0] : null;
    const yMm = sp ? yPx * sp[1] : null;
    let value: number | null = null;
    try {
      const scalars = vp.getImageData?.()?.scalarData;
      const cols = vp.getImageData?.()?.dimensions?.[0];
      if (scalars && cols && img)
        value = scalars[Math.round(img[1]) * cols + Math.round(img[0])];
    } catch {}
    onCursorRef.current({ xPx, yPx, xMm, yMm, value });
  } catch {}
};
const clearCursor = () => onCursorRef.current?.(null);
element.addEventListener("mousemove", emitCursor);
element.addEventListener("mouseleave", clearCursor);
```

Mémoriser `onCursor` dans une ref `onCursorRef` (mise à jour à chaque rendu) pour éviter de relancer
l'effet. Nettoyer les écouteurs au cleanup. **Adapter les API Cornerstone réelles** (`canvasToWorld`,
`getImageData`) à la version utilisée ; si une API manque, dégrader proprement (mm/valeur → null).

- [ ] **Step 4 : dessiner la règle calibrée sur le canvas overlay**

Là où le canvas overlay est (re)dessiné (`drawMaskOverlayRef`/effet de rendu), ajouter le tracé de la
règle via `computeScaleBar(pixelSpacingMm, zoom, height)` le long du bord gauche : une barre verticale

- ticks + label `"<labelMm> mm"`. Récupérer `pixelSpacingMm` depuis `getImageData().spacing[1]` et
  `zoom` depuis `viewport.getZoom?.()` (ou rapport taille). Redessiner sur `CAMERA_MODIFIED` /
  `IMAGE_RENDERED`. Si `computeScaleBar` renvoie null → ne rien dessiner.

* [ ] **Step 5 : compilation** — `pnpm check` (Expected: PASS) ; corriger les noms de refs/API au besoin.
* [ ] **Step 6 : commit** — `git add client/src/components/CornerstoneViewer.tsx && git commit -m "feat(viewer): curseur px/mm/valeur, outil bouton droit, règle calibrée"`

---

### Task 4 : `Viewer` — overlay enrichi, CLUT/opacité, bouton souris, menu 2D/3D

**Files:**

- Modify: `client/src/pages/Viewer.tsx`

- [ ] **Step 1 : état curseur + orientation, alimentés par le viewer**

Ajouter `const [cursor, setCursor] = useState<CursorData | null>(null);` et
`const [iop, setIop] = useState<number[] | null>(null);` (importer `CursorData` depuis
`@/lib/viewportOverlay`). Passer `onCursor={setCursor}` au `CornerstoneViewer`. Mettre à jour `iop` via
`viewerRef.current?.getImageOrientation()` au changement de coupe/série (handle déjà exposé).

- [ ] **Step 2 : overlay coins enrichi**

Là où l'overlay actuel s'affiche (coins patient/WW-WC/coupe/zoom), ajouter, avec
`formatCursorReadout` / `patientOrientationLabels` / `formatImageInfo` :

- un coin bas-gauche : `cursor && formatCursorReadout(cursor)` ;
- les étiquettes L/R/A/P/H/F aux 4 bords via `patientOrientationLabels(iop)` (petits `<span>` absolus,
  `pointer-events-none`) ;
- les lignes `formatImageInfo({ cols, rows, zoomPct: zoomPercent, angleDeg })` (rows/cols depuis les
  métadonnées déjà chargées, sinon omettre). Garder l'existant.

- [ ] **Step 3 : dropdowns CLUT + Opacité dans la barre 2D**

Dans la barre d'outils 2D, ajouter (réutilise les handles existants) :

```tsx
<select
  className="bg-muted/40 border border-border rounded text-[11px] px-1 py-0.5"
  title="CLUT (palette)"
  onChange={e => viewerRef.current?.setColormap(e.target.value || null)}
  defaultValue=""
>
  <option value="">Aucun CLUT</option>
  {COLORMAPS.map(c => (
    <option key={c.name} value={c.name}>{c.label}</option>
  ))}
</select>
<select
  className="bg-muted/40 border border-border rounded text-[11px] px-1 py-0.5"
  title="Table d'opacité (VOI LUT)"
  onChange={e => viewerRef.current?.setVoiLutFunction(e.target.value as "LINEAR" | "SIGMOID")}
  defaultValue="LINEAR"
>
  <option value="LINEAR">Opacité : Linéaire</option>
  <option value="SIGMOID">Opacité : Sigmoïde</option>
</select>
```

Importer `COLORMAPS` depuis `@/lib/colormaps`.

- [ ] **Step 4 : contrôle « Bouton souris »**

Ajouter un `<select>` « Bouton droit : <outil> » qui appelle `viewerRef.current?.setSecondaryTool(id)`
avec les ids d'outils déjà connus du viewer (`wwwl`, `zoom`, `pan`, `scroll`…). Défaut `wwwl`.

- [ ] **Step 5 : menu unifié « 2D/3D »**

Ajouter un `<select>`/menu « Mode 2D/3D » regroupant les modes **déjà existants** ; chaque option
appelle le setter existant correspondant (l'implémenteur repère les états/handlers actuels :
`viewMode`/MPR/3D/VR/surface/curved/fly-through). N'ajoute AUCUN nouveau mode — ne fait que router vers
l'existant. (Les vignettes d'orientation MPR existent déjà ; les laisser.)

- [ ] **Step 6 : compilation** — `pnpm check` (Expected: PASS).
- [ ] **Step 7 : commit** — `git add client/src/pages/Viewer.tsx && git commit -m "feat(viewer): overlay enrichi + clut/opacité + bouton souris + menu 2d/3d"`

---

### Task 5 : Vérification finale + déploiement

- [ ] **Step 1** : `pnpm check && pnpm exec vitest run` → tout vert.
- [ ] **Step 2** : `git push -u origin feat/viewer-feel-parity` ; puis (appel séparé) `gh pr create --base self-host ...`.
- [ ] **Step 3** : `gh run watch <id> --exit-status` (gate verify+build) ; `gh pr merge <num> --merge --delete-branch`.
- [ ] **Step 4** : déployer l'image du SHA de merge sur `root@76.13.55.44` (`/docker/horos`, sed image → pull → up -d migrate (no-op) → up -d app).
- [ ] **Step 5** : ping — `healthz` 200, garde `/api/audit/export.csv` 401, bonne image.
- [ ] **Step 6** : vérif navigateur (compte de test si dispo) — curseur px/mm/valeur, règle calibrée, clic-droit = W/L, dropdowns CLUT/opacité, menu 2D/3D.
- [ ] **Step 7** : mémoire — `mediview-vr-avance.md` + index `MEMORY.md` (parité feel viewer déployée).

---

## Notes

- 100 % client Cornerstone3D ; aucune migration, aucun modèle, aucun PHI hors VPS.
- Thick-slab MIP 2D natif **hors scope** (StackViewport) — le bouton MIP route vers le volumique existant.
- APIs Cornerstone exactes (`canvasToWorld`, `getImageData`, `getZoom`) à adapter à la version installée ;
  dégrader proprement (mm/valeur/règle → masqués) si une API diffère.
