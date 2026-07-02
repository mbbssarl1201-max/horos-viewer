# Édition couleur de la fonction de transfert (3D) — Plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development / executing-plans. Steps en `- [ ]`.

**Goal:** Permettre d'éditer la couleur du rendu volumique 3D (points couleur appliqués à la RGBTransferFunction), en plus de l'opacité existante.

**Architecture:** modèle pur `ColorPoint` + helpers hex dans `transferFunction.ts` ; `VolumeViewer` applique les points couleur (mirror de l'effet opacité) ; `TransferFunctionEditor` gagne une section « Couleurs » ; `Viewer` ajoute l'état et le câblage. 100% client, additif, aucune migration.

**Tech Stack:** React 19, VTK.js (Cornerstone3D), TypeScript, Vitest.

**Branche :** `feat/tf-color-editing` (déjà créée depuis `self-host`).

---

### Task 1 : modèle pur couleur + helpers hex

**Files:** Modify `client/src/lib/transferFunction.ts` ; Modify `client/src/lib/transferFunction.test.ts`

- [ ] **Step 1 : tests (échec attendu)**

```typescript
// transferFunction.test.ts — AJOUTER
import {
  hexToRgb01,
  rgb01ToHex,
  normalizeColorPoints,
  defaultColorPoints,
} from "./transferFunction";

describe("hexToRgb01 / rgb01ToHex", () => {
  it("#ff0000 → {1,0,0}", () => {
    expect(hexToRgb01("#ff0000")).toEqual({ r: 1, g: 0, b: 0 });
  });
  it("#00ff00 → {0,1,0}", () => {
    expect(hexToRgb01("#00ff00")).toEqual({ r: 0, g: 1, b: 0 });
  });
  it("hex invalide → noir", () => {
    expect(hexToRgb01("nope")).toEqual({ r: 0, g: 0, b: 0 });
  });
  it("round-trip rgb01ToHex(hexToRgb01)", () => {
    expect(
      rgb01ToHex(
        ...(Object.values(hexToRgb01("#3366cc")) as [number, number, number])
      )
    ).toBe("#3366cc");
  });
});

describe("normalizeColorPoints", () => {
  it("trie par value et clampe rgb", () => {
    const out = normalizeColorPoints([
      { value: 100, r: 2, g: -1, b: 0.5 },
      { value: 0, r: 0, g: 0, b: 0 },
    ]);
    expect(out.map(p => p.value)).toEqual([0, 100]);
    expect(out[1]).toEqual({ value: 100, r: 1, g: 0, b: 0.5 });
  });
  it("retire les value non finies", () => {
    expect(normalizeColorPoints([{ value: NaN, r: 0, g: 0, b: 0 }])).toEqual(
      []
    );
  });
});

describe("defaultColorPoints", () => {
  it("noir (lo) → blanc (hi)", () => {
    const p = defaultColorPoints(-1000, 1000);
    expect(p).toEqual([
      { value: -1000, r: 0, g: 0, b: 0 },
      { value: 1000, r: 1, g: 1, b: 1 },
    ]);
  });
});
```

- [ ] **Step 2 : lancer (échec)** — `pnpm exec vitest run client/src/lib/transferFunction.test.ts`

- [ ] **Step 3 : implémenter (ajouter à `transferFunction.ts`)**

```typescript
export interface ColorPoint {
  /** Valeur scalaire (HU pour un CT). */
  value: number;
  /** Composantes [0..1]. */
  r: number;
  g: number;
  b: number;
}

/** "#rrggbb" → {r,g,b} ∈ [0..1] ; entrée invalide → noir. PUR. */
export function hexToRgb01(hex: string): { r: number; g: number; b: number } {
  const m = /^#?([0-9a-fA-F]{6})$/.exec((hex ?? "").trim());
  if (!m) return { r: 0, g: 0, b: 0 };
  const n = parseInt(m[1], 16);
  return {
    r: ((n >> 16) & 255) / 255,
    g: ((n >> 8) & 255) / 255,
    b: (n & 255) / 255,
  };
}

/** {r,g,b}∈[0..1] → "#rrggbb". PUR. */
export function rgb01ToHex(r: number, g: number, b: number): string {
  const h = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v * 255)))
      .toString(16)
      .padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

/** Trie par value, clampe rgb [0..1], retire les value non finies. PUR. */
export function normalizeColorPoints(
  points: readonly ColorPoint[]
): ColorPoint[] {
  return points
    .filter(p => Number.isFinite(p.value))
    .map(p => ({
      value: p.value,
      r: clamp01(p.r),
      g: clamp01(p.g),
      b: clamp01(p.b),
    }))
    .sort((a, b) => a.value - b.value);
}

/** Rampe couleur par défaut : noir (lo) → blanc (hi). PUR. */
export function defaultColorPoints(loHU: number, hiHU: number): ColorPoint[] {
  return [
    { value: loHU, r: 0, g: 0, b: 0 },
    { value: hiHU, r: 1, g: 1, b: 1 },
  ];
}
```

- [ ] **Step 4 : lancer (succès)** — `pnpm exec vitest run client/src/lib/transferFunction.test.ts`
- [ ] **Step 5 : commit** — `git add client/src/lib/transferFunction.ts client/src/lib/transferFunction.test.ts && git commit -m "feat(viewer): modèle couleur tf + helpers hex (purs)"`

---

### Task 2 : `VolumeViewer` applique les points couleur

**Files:** Modify `client/src/components/VolumeViewer.tsx`

- [ ] **Step 1 : import + prop**

Import : ajouter `normalizeColorPoints, type ColorPoint` à l'import depuis `@/lib/transferFunction`. Ajouter la prop `colorPoints?: ColorPoint[];` (à côté de `opacityPoints?`) et la destructurer.

- [ ] **Step 2 : effet d'application (mirror exact de l'opacité, ≈ l.1175-1205)**

```typescript
const colorSig = (colorPoints ?? [])
  .map(p => `${p.value}:${p.r}:${p.g}:${p.b}`)
  .join("|");
useEffect(() => {
  if (mode !== "3d") return;
  const pts = normalizeColorPoints(colorPoints ?? []);
  if (pts.length < 2) return; // sinon le preset clinique garde la couleur
  let raf = 0;
  const apply = () => {
    try {
      const vp = engineRef.current?.getViewport?.("VR_3D") as any;
      const actors = vp?.getActors?.();
      const actor =
        actors?.[0]?.actor ?? actors?.[0]?.volumeActor ?? actors?.[0];
      const property = actor?.getProperty?.();
      const cfun = property?.getRGBTransferFunction?.(0);
      if (!cfun?.addRGBPoint) return;
      cfun.removeAllPoints?.();
      for (const p of pts) cfun.addRGBPoint(p.value, p.r, p.g, p.b);
      vp.render?.();
    } catch {
      /* acteur pas prêt / API indispo — ignoré */
    }
  };
  raf = requestAnimationFrame(() => {
    raf = requestAnimationFrame(apply);
  });
  return () => cancelAnimationFrame(raf);
}, [colorSig, mode]);
```

(placer juste après l'effet `opacitySig` existant ; adapter le cleanup au style local.)

- [ ] **Step 3 : compilation** — `pnpm check` (PASS). Vérifier que l'opacité 3D marche toujours.
- [ ] **Step 4 : commit** — `git add client/src/components/VolumeViewer.tsx && git commit -m "feat(viewer): VolumeViewer applique les points couleur (rgbTransferFunction)"`

---

### Task 3 : section « Couleurs » dans l'éditeur + câblage Viewer

**Files:** Modify `client/src/components/TransferFunctionEditor.tsx`, `client/src/pages/Viewer.tsx`

- [ ] **Step 1 : éditeur — props couleur + UI**

Dans `TransferFunctionEditor`, étendre `Props` :

```typescript
interface Props {
  points: OpacityPoint[];
  onChange: (points: OpacityPoint[]) => void;
  colorPoints?: ColorPoint[];
  onColorChange?: (points: ColorPoint[]) => void;
}
```

Importer `ColorPoint, normalizeColorPoints, hexToRgb01, rgb01ToHex, defaultColorPoints` depuis `@/lib/transferFunction`. Sous le canvas d'opacité, ajouter une section « Couleurs » (rendue seulement si `onColorChange` fourni) :

```tsx
{
  onColorChange && (
    <div className="mt-2 border-t border-border pt-1 space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-muted-foreground">Couleurs</span>
        <button
          type="button"
          className="text-[10px] px-1 rounded bg-muted/50 hover:bg-muted"
          onClick={() =>
            onColorChange(
              normalizeColorPoints(
                (colorPoints && colorPoints.length
                  ? colorPoints
                  : defaultColorPoints(-1000, 1000)
                ).concat({ value: 0, r: 1, g: 1, b: 0 })
              )
            )
          }
        >
          + couleur
        </button>
      </div>
      {(colorPoints ?? []).map((cp, i) => (
        <div key={i} className="flex items-center gap-1">
          <input
            type="number"
            className="w-16 bg-muted/40 border border-border rounded text-[10px] px-1"
            value={Math.round(cp.value)}
            onChange={e => {
              const next = (colorPoints ?? []).slice();
              next[i] = { ...cp, value: Number(e.target.value) };
              onColorChange(normalizeColorPoints(next));
            }}
            title="Valeur HU"
          />
          <input
            type="color"
            value={rgb01ToHex(cp.r, cp.g, cp.b)}
            onChange={e => {
              const c = hexToRgb01(e.target.value);
              const next = (colorPoints ?? []).slice();
              next[i] = { value: cp.value, ...c };
              onColorChange(normalizeColorPoints(next));
            }}
          />
          <button
            type="button"
            className="text-[10px] text-destructive"
            onClick={() =>
              onColorChange((colorPoints ?? []).filter((_, j) => j !== i))
            }
            title="Supprimer"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 2 : Viewer — état + câblage**

Importer `type ColorPoint` depuis `@/lib/transferFunction`. Après l'état `opacityPoints` (≈ l.376) :

```typescript
const [colorPoints, setColorPoints] = useState<ColorPoint[]>([]);
```

Passer à l'éditeur `colorPoints={colorPoints} onColorChange={setColorPoints}` (là où `<TransferFunctionEditor points=... onChange=... />` est monté). Passer `colorPoints={colorPoints}` au `<VolumeViewer>` 3D (à côté de `opacityPoints`).

- [ ] **Step 3 : compilation** — `pnpm check` (PASS).
- [ ] **Step 4 : commit** — `git add client/src/components/TransferFunctionEditor.tsx client/src/pages/Viewer.tsx && git commit -m "feat(viewer): ui édition couleur tf + câblage viewer"`

---

### Task 4 : vérification + déploiement

- [ ] **Step 1** — `pnpm check && pnpm exec vitest run` → tout vert.
- [ ] **Step 2** — `git push -u origin feat/tf-color-editing` ; puis (séparé) `gh pr create --base self-host ...`.
- [ ] **Step 3** — `gh run watch <id> --exit-status` ; `gh pr merge <num> --merge --delete-branch`.
- [ ] **Step 4** — déployer le SHA de merge (`/docker/horos` : sed image → pull → `up -d migrate` (no-op) → `up -d app`).
- [ ] **Step 5** — ping : healthz 200, garde 401, bonne image.
- [ ] **Step 6** — mémoire : `mediview-vr-avance.md` (édition couleur TF déployée) + index `MEMORY.md`.

---

## Notes

- Additif : opacité (PR #95) inchangée ; couleur appliquée seulement si ≥ 2 points. 100% client, aucune migration, aucun PHI.
- v1 : liste de stops + color picker (pas de dégradé canvas) ; couleurs non persistées dans les presets localStorage.
