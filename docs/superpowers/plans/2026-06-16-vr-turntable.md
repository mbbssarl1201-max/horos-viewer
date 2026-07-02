# VR avancé — Incrément 1 : export vidéo turntable — Plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ajouter au mode 3D de MediView un bouton « Exporter rotation » qui enregistre une vidéo (WebM) d'un tour complet du rendu volumétrique, encodée 100 % côté client.

**Architecture:** Module pur `lib/turntable.ts` (angles + orbite caméra), branché dans `VolumeViewer` via un effet déclenché par un **nonce** (même pattern que `flyThruNonce` existant) qui pilote la caméra du viewport `VR_3D` et capture son canvas via `MediaRecorder`/`captureStream`. Bouton + état dans `Viewer.tsx`. Aucun serveur, aucun PHI sortant.

**Tech Stack:** React 19, Cornerstone3D (viewport `VR_3D`, engine `horosVolumeEngine`), Web `MediaRecorder` + `HTMLCanvasElement.captureStream`, Vitest.

**Spec :** `docs/superpowers/specs/2026-06-16-vr-avance-design.md`

---

### Task 1 : Module pur `turntable.ts` (angles + orbite caméra)

**Files:**

- Create: `client/src/lib/turntable.ts`
- Test: `client/src/lib/turntable.test.ts`

- [ ] **Step 1 : Écrire les tests qui échouent**

```ts
import { describe, it, expect } from "vitest";
import { turntableAngles, orbitAroundFocalPoint } from "./turntable";

describe("turntableAngles", () => {
  it("répartit `frames` angles sur un tour complet, en commençant à 0", () => {
    const a = turntableAngles(4);
    expect(a).toHaveLength(4);
    expect(a[0]).toBeCloseTo(0, 6);
    expect(a[1]).toBeCloseTo(Math.PI / 2, 6);
    expect(a[3]).toBeCloseTo((3 * Math.PI) / 2, 6);
  });
  it("frames <= 0 → tableau vide", () => {
    expect(turntableAngles(0)).toEqual([]);
    expect(turntableAngles(-5)).toEqual([]);
  });
});

describe("orbitAroundFocalPoint", () => {
  it("tourne la position autour de l'axe viewUp en gardant la distance", () => {
    // (1,0,0) tourné de 90° autour de +Z (centré sur l'origine) → ~(0,1,0)
    const p = orbitAroundFocalPoint(
      [1, 0, 0],
      [0, 0, 0],
      [0, 0, 1],
      Math.PI / 2
    );
    expect(p[0]).toBeCloseTo(0, 6);
    expect(p[1]).toBeCloseTo(1, 6);
    expect(p[2]).toBeCloseTo(0, 6);
  });
  it("angle 0 → position inchangée", () => {
    const p = orbitAroundFocalPoint([3, 1, 2], [0, 0, 0], [0, 0, 1], 0);
    expect(p[0]).toBeCloseTo(3, 6);
    expect(p[1]).toBeCloseTo(1, 6);
    expect(p[2]).toBeCloseTo(2, 6);
  });
  it("préserve la distance au point focal", () => {
    const fp = [5, 5, 5];
    const p = orbitAroundFocalPoint([5, 8, 5], fp, [0, 1, 0], 1.2345);
    const d = Math.hypot(p[0] - fp[0], p[1] - fp[1], p[2] - fp[2]);
    expect(d).toBeCloseTo(3, 6);
  });
});
```

- [ ] **Step 2 : Lancer pour vérifier l'échec**

Run: `cd /Users/mbbssarl/Documents/GitHub/horos-viewer && npx vitest run client/src/lib/turntable.test.ts`
Expected: FAIL — `turntable` introuvable.

- [ ] **Step 3 : Implémenter `client/src/lib/turntable.ts`**

```ts
/**
 * Logique PURE de l'export « turntable » (vidéo de rotation du rendu 3D).
 * Sans DOM ni Cornerstone : juste la géométrie, donc testable.
 */

/**
 * `frames` angles répartis uniformément sur un tour complet (2π), à partir de 0.
 * `frames <= 0` → tableau vide.
 */
export function turntableAngles(frames: number): number[] {
  if (!Number.isFinite(frames) || frames <= 0) return [];
  const n = Math.floor(frames);
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push((2 * Math.PI * i) / n);
  return out;
}

/**
 * Fait orbiter `position` autour de l'axe `axis` (typiquement le viewUp de la
 * caméra) passant par `focalPoint`, d'un angle `angleRad` (rotation de Rodrigues).
 * Renvoie la nouvelle position. La distance au point focal est préservée.
 * Si l'axe est dégénéré (norme nulle), renvoie la position inchangée.
 */
export function orbitAroundFocalPoint(
  position: readonly number[],
  focalPoint: readonly number[],
  axis: readonly number[],
  angleRad: number
): [number, number, number] {
  const v = [
    position[0] - focalPoint[0],
    position[1] - focalPoint[1],
    position[2] - focalPoint[2],
  ];
  const an = Math.hypot(axis[0], axis[1], axis[2]);
  if (an === 0) return [position[0], position[1], position[2]];
  const k = [axis[0] / an, axis[1] / an, axis[2] / an];
  const c = Math.cos(angleRad);
  const s = Math.sin(angleRad);
  // Produit vectoriel k × v
  const kxv = [
    k[1] * v[2] - k[2] * v[1],
    k[2] * v[0] - k[0] * v[2],
    k[0] * v[1] - k[1] * v[0],
  ];
  // Produit scalaire k · v
  const kdv = k[0] * v[0] + k[1] * v[1] + k[2] * v[2];
  // v_rot = v·cosθ + (k×v)·sinθ + k·(k·v)·(1-cosθ)
  const r = [
    v[0] * c + kxv[0] * s + k[0] * kdv * (1 - c),
    v[1] * c + kxv[1] * s + k[1] * kdv * (1 - c),
    v[2] * c + kxv[2] * s + k[2] * kdv * (1 - c),
  ];
  return [focalPoint[0] + r[0], focalPoint[1] + r[1], focalPoint[2] + r[2]];
}
```

- [ ] **Step 4 : Lancer pour vérifier le succès**

Run: `npx vitest run client/src/lib/turntable.test.ts`
Expected: PASS (5 assertions, 3 tests).

- [ ] **Step 5 : Commit**

```bash
git add client/src/lib/turntable.ts client/src/lib/turntable.test.ts
git commit -m "feat(vr): module pur turntable (angles + orbite camera)"
```

---

### Task 2 : Brancher la capture turntable dans `VolumeViewer`

**Files:**

- Modify: `client/src/components/VolumeViewer.tsx` (interface props, déstructuration, import, nouvel effet)

Tâche d'intégration (APIs navigateur + Cornerstone3D) — pas de test unitaire (la logique géométrique est couverte en Task 1 ; vérif via tsc/build + visuel). Mirroir exact du pattern `flyThruNonce` existant (effet déclenché par un nonce, accès viewport `VR_3D`, best-effort try/catch).

- [ ] **Step 1 : Ajouter l'import du module pur** (en tête, près de `import { catmullRomSpline } from "@/lib/flyThruPath";`)

```ts
import { turntableAngles, orbitAroundFocalPoint } from "@/lib/turntable";
```

- [ ] **Step 2 : Ajouter le prop `turntableNonce`** — dans l'interface `VolumeViewerProps`, juste après `flyThruNonce?: number;` :

```ts
  /** Mode "3d" : à chaque incrément, exporte une vidéo de rotation (turntable). */
  turntableNonce?: number;
```

Et dans la déstructuration des props (près de `flyThruNonce = 0,`) :

```ts
  turntableNonce = 0,
```

- [ ] **Step 3 : Ajouter l'effet de capture** — juste APRÈS l'effet `flyThruNonce` (le `useEffect(... }, [flyThruNonce, mode]);` qui se termine vers la ligne 835) :

```ts
// Export turntable (« vidéo de rotation » du rendu 3D) : à chaque incrément de
// turntableNonce, on fait orbiter la caméra du viewport VR_3D sur un tour
// complet en capturant son canvas via MediaRecorder, puis on télécharge le
// WebM en local. 100 % client : aucun pixel ne quitte le navigateur.
useEffect(() => {
  if (mode !== "3d" || !turntableNonce) return;
  const vp = engineRef.current?.getViewport?.("VR_3D") as any;
  if (!vp?.getCamera || !vp?.setCamera) return;
  const canvas: HTMLCanvasElement | null =
    vp.getCanvas?.() ?? vr3dRef.current?.querySelector("canvas") ?? null;
  if (
    !canvas ||
    typeof (canvas as any).captureStream !== "function" ||
    typeof MediaRecorder === "undefined"
  ) {
    setError("Export rotation indisponible sur ce navigateur.");
    return;
  }
  let cancelled = false;
  let raf = 0;
  try {
    const cam0 = vp.getCamera();
    const pos0 = cam0.position as number[];
    const fp = cam0.focalPoint as number[];
    const up = cam0.viewUp as number[];
    const FRAMES = 90;
    const FPS = 30;
    const angles = turntableAngles(FRAMES);
    const stream = (canvas as any).captureStream(FPS);
    const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
      ? "video/webm;codecs=vp9"
      : "video/webm";
    const recorder = new MediaRecorder(stream, { mimeType: mime });
    const chunks: Blob[] = [];
    recorder.ondataavailable = e => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    recorder.onstop = () => {
      try {
        const blob = new Blob(chunks, { type: "video/webm" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `rotation-3d-${Date.now()}.webm`;
        a.click();
        URL.revokeObjectURL(a.href);
      } catch {}
    };
    recorder.start();
    let i = 0;
    const step = () => {
      if (cancelled || i >= angles.length) {
        try {
          vp.setCamera(cam0);
          vp.render();
        } catch {}
        try {
          recorder.stop();
        } catch {}
        return;
      }
      try {
        const position = orbitAroundFocalPoint(pos0, fp, up, angles[i]);
        vp.setCamera({ position, focalPoint: fp, viewUp: up });
        vp.render();
      } catch {}
      i++;
      raf = requestAnimationFrame(step);
    };
    step();
  } catch {
    /* caméra/enregistrement indisponible — export ignoré */
  }
  return () => {
    cancelled = true;
    if (raf) cancelAnimationFrame(raf);
  };
}, [turntableNonce, mode]);
```

- [ ] **Step 4 : Vérifier le typecheck**

Run: `cd /Users/mbbssarl/Documents/GitHub/horos-viewer && npx tsc --noEmit`
Expected: aucune erreur.

- [ ] **Step 5 : Commit**

```bash
git add client/src/components/VolumeViewer.tsx
git commit -m "feat(vr): capture turntable dans VolumeViewer (nonce + MediaRecorder)"
```

---

### Task 3 : Bouton « Exporter rotation » dans `Viewer.tsx`

**Files:**

- Modify: `client/src/pages/Viewer.tsx` (état `turntableNonce`, bouton dans la barre 3D, passage du prop)

- [ ] **Step 1 : Ajouter l'état** — près des autres états 3D (vers ligne 343-349, après `const [surface3d, setSurface3d] = useState<boolean>(false);`) :

```ts
const [turntableNonce, setTurntableNonce] = useState(0);
```

- [ ] **Step 2 : Ajouter le bouton dans le bloc 3D** — dans `{viewMode === "3d" && ( … )}` (vers ligne 2170-2214, après la case `surface3d`), insérer :

```tsx
<button
  type="button"
  onClick={() => setTurntableNonce(n => n + 1)}
  className="toolbar-btn"
  title="Exporter une vidéo de rotation (WebM) du volume 3D"
>
  Exporter rotation
</button>
```

(Adapter le wrapper si les contrôles 3D sont dans un conteneur flex précis — placer le bouton à côté des cases « réaliste » / « surface ».)

- [ ] **Step 3 : Passer le prop à `VolumeViewer`** — dans le `<VolumeViewer … />` (vers ligne 2977), ajouter parmi les props 3D (près de `surface3d={surface3d}`) :

```tsx
turntableNonce = { turntableNonce };
```

- [ ] **Step 4 : Vérifier typecheck + build**

Run: `cd /Users/mbbssarl/Documents/GitHub/horos-viewer && npx tsc --noEmit && npm run build`
Expected: aucune erreur, build OK.

- [ ] **Step 5 : Lancer toute la suite (non-régression)**

Run: `npx vitest run`
Expected: tous PASS (dont `turntable.test.ts`).

- [ ] **Step 6 : Commit**

```bash
git add client/src/pages/Viewer.tsx
git commit -m "feat(vr): bouton Exporter rotation (turntable) en mode 3D"
```

---

### Task 4 : PR + déploiement

**Files:** aucun (intégration / déploiement).

- [ ] **Step 1 : Pousser la branche SEULE**

```bash
git push origin HEAD:refs/heads/feat/vr-avance
```

- [ ] **Step 2 : Créer la PR** (appel séparé)

```bash
gh pr create --base self-host --head feat/vr-avance \
  --title "VR avancé 1/4 — export vidéo turntable (rotation 3D)" \
  --body "Incrément 1 de l'épopée VR avancé (spec 2026-06-16-vr-avance-design). Bouton « Exporter rotation » en mode 3D : enregistre une vidéo WebM d'un tour complet du rendu volumétrique, 100 % client (MediaRecorder + captureStream), aucun pixel envoyé au serveur. Module pur testé (turntableAngles + orbitAroundFocalPoint). Pattern nonce calqué sur flyThru. Aucun serveur/PHI/migration."
```

- [ ] **Step 3 : Vérifier la CI verte** (gate verify → build) puis merger

```bash
gh run watch "$(gh run list --branch self-host --limit 1 --json databaseId --jq '.[0].databaseId')" --exit-status
gh pr merge <num> --merge --delete-branch=false
```

- [ ] **Step 4 : Déployer sur le VPS** (image GHCR `:<fullSHA>` du merge → `/docker/horos/docker-compose.yml`, `docker compose pull app && up -d`) puis vérifier healthz 200 + garde 401 + image SHA, et **vérif visuelle** : mode 3D → « Exporter rotation » → un `.webm` de rotation se télécharge.

---

## Notes

- **Aucune migration DB, aucun changement serveur.** Tout est client (`client/src/`).
- Repli navigateur : si `MediaRecorder`/`captureStream` indispo → message « Export rotation indisponible sur ce navigateur » (pas de crash).
- Le `VR_3D` doit être monté (mode 3D actif, volume chargé) pour que l'export fonctionne — le bouton n'est visible qu'en mode 3D.
