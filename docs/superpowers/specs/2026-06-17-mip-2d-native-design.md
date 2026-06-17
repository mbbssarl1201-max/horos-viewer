# MediView — thick-slab MIP/MinIP natif en vue 2D — Design

> **Statut** : design validé · **Date** : 2026-06-17 · **Repo** : `horos-viewer` (MediView). 100 % client
> (Cornerstone3D), aucun PHI/serveur/migration. Conception initiale esquissée via **Hermès local (VPS)**
> puis corrigée sur l'API réelle. Cf. [[mediview-horos-parity]] (item « MIP 2D natif »).

## Problème

Le thick-slab MIP/MinIP existe en **MPR** mais pas en **vue 2D simple** : le viewport 2D est un
`StackViewport` Cornerstone, qui n'agrège pas par épaisseur. Horos offre le thick-slab partout. On veut
un **mode « Épaisseur 2D »** dans la vue 2D, sans casser le rendu stack actuel (qui marche bien).

## Objectifs

1. Toggle **« Épaisseur 2D »** dans la barre 2D : bascule la vue courante vers un viewport **volumique
   mono-plan** (orientation **axiale = plan d'acquisition**) avec **slab thickness (mm)** + mode
   **MIP / MinIP / Moyenne** (réutilise `lib/slabBlend.ts`). Toggle off → retour au `StackViewport`.
2. **Repli sûr** : le toggle n'est **actif que si la série est reconstructible** (`useOrthancVolume`
   renvoie ≥ 2 imageIds) ; sinon désactivé + tooltip « série non reconstructible en volume ».
3. **Additif, zéro régression** : le `CornerstoneViewer` (stack) reste le défaut et le chemin par défaut ;
   le mode volumique est une alternative montée à la demande.

## Non-objectifs

- ❌ Remplacer le rendu stack 2D par défaut (on garde le StackViewport).
- ❌ Annotations/segmentation sur le mode épaisseur (lecture/W-L/zoom/scroll seulement en v1).
- ❌ Multi-plan (c'est la MPR, déjà existante) ; ❌ PHI/serveur/migration.

## Architecture

```
client/src/components/VolumeViewer.tsx : nouveau mode "slab2d"
  → UN viewport ORTHOGRAPHIC AXIAL (réutilise le chemin "mpr" mais un seul plan)
  → applique setSlabThickness(slabThicknessMm) + setBlendMode(Enums.BlendModes[slabModeToBlend(slabMode)])
  → volume via useOrthancVolume(seriesId) + setVolumesForViewports (déjà le pattern mpr)

client/src/pages/Viewer.tsx :
  - état `slab2dOn` (toggle) ; volume = useOrthancVolume(selectedSeries) déjà dispo (ou l'instancier)
  - reconstructible = volume.imageIds.length >= 2
  - rendu 2D : si slab2dOn && reconstructible → <VolumeViewer mode="slab2d" slabThicknessMm slabMode/>
               sinon → <CornerstoneViewer> (inchangé)
  - barre 2D : bouton « Épaisseur 2D » (disabled si !reconstructible) + slider mm + select MIP/MinIP/Moyenne
    (réutilise SLAB_MODES ; ces contrôles existent déjà pour la MPR — les exposer aussi en mode slab2d)
```

### Composants

- **`VolumeViewer.tsx`** : étendre `mode: "mpr" | "3d"` → `"mpr" | "3d" | "slab2d"`. Dans la branche
  d'init, `mode === "slab2d"` crée **un** viewport `ORTHOGRAPHIC` `OrientationAxis.AXIAL` (comme
  `MPR_AXIAL`), `setVolumesForViewports`, puis applique `setSlabThickness` + `setBlendMode` (même code que
  la branche mpr, factorisé). Réagit aux changements de `slabThicknessMm`/`slabMode` (déjà des props).
  Outils souris : W/L + zoom + pan + stack-scroll (parcours des coupes le long de l'axe).
- **`Viewer.tsx`** : `const [slab2dOn, setSlab2dOn] = useState(false)`. Réutilise/instancie
  `useOrthancVolume(selectedSeries)` → `reconstructible`. Bouton toggle (icône « Layers ») dans la barre
  2D, `disabled={!reconstructible}`, tooltip explicite. Quand actif, on monte `VolumeViewer mode="slab2d"`
  à la place du `CornerstoneViewer` pour la cellule 2D, en passant `slabThicknessMm`/`slabMode` (états
  existants) + un slider/selecteur visibles en mode slab2d. Désactiver le toggle au changement de série si
  la nouvelle n'est pas reconstructible.

## Gestion d'erreurs

- Série non reconstructible (<2 images, spacing irrégulier → volume échoue) : toggle désactivé ; si le
  volume échoue à se construire alors que le toggle est on, **repli automatique** sur le stack + toast
  discret « épaisseur 2D indisponible pour cette série ».
- `setSlabThickness`/`setBlendMode` absents (version moteur) : dégrade en vue volumique simple (slab 0).

## Tests

- **Pur** : `slabModeToBlend` est déjà testé (2c/VR). Ajouter un test sur un helper
  `clampSlabThickness(mm, max)` (borne 0..N) si introduit. La logique « reconstructible = imageIds≥2 » est
  un helper pur `isReconstructable(imageIds)` testé.
- **UI** (vérif visuelle navigateur) : toggle actif sur une série CT multi-coupes → l'image s'épaissit
  en MIP ; slider mm change l'épaisseur ; MinIP/Moyenne changent le rendu ; série mono-image → toggle grisé.

## Intégration & déploiement

- Aucune migration, aucun modèle. Branche `feat/mip-2d-native`. Gate CI (tsc+tests+audit) → build GHCR →
  compose VPS → healthz 200 + garde 401. Vérif navigateur (compte test) : épaisseur 2D fonctionnelle.
- Réutilise au maximum le chemin MPR existant (DRY) ; le risque est contenu (mode additif, repli stack).
