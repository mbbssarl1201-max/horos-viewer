# MediView — édition couleur de la fonction de transfert (3D) — Design

> **Statut** : design validé · **Date** : 2026-06-19 · **Repo** : `horos-viewer` (MediView). 100 % client
> (VTK.js), aucun PHI/serveur/migration. Étend l'éditeur TF opacité-seule (PR #95).
> Cf. [[mediview-vr-avance]] (« édition couleur reportée »).

## Problème

L'éditeur de fonction de transfert 3D ne gère que l'**opacité** ; la **couleur** vient du preset clinique
et n'est pas éditable. Horos permet d'éditer la couleur (CLUT/transfer). On ajoute l'édition de points
**couleur** appliqués à la `RGBTransferFunction` du volume, en réutilisant la mécanique existante de l'opacité.

## Objectifs

1. Éditer des **points couleur** `{ value:HU, couleur }` : ajouter / supprimer / changer la couleur
   (sélecteur `<input type=color>`) et la valeur HU. Appliqués en direct au rendu 3D.
2. **Additif** : l'opacité (PR #95) reste inchangée ; la couleur ne s'applique **que si ≥ 2 points
   couleur** sont définis (sinon le preset clinique garde la main).
3. Logique **pure et testée** (modèle de points couleur + conversions hex↔rgb), comme l'opacité.

## Non-objectifs

- ❌ Édition couleur sur dégradé canvas riche (gizmo) — liste de stops + color picker en v1.
- ❌ Persistance des couleurs dans les presets localStorage (v1 : opacité seule persistée ; couleur live).
- ❌ Couleur en MPR/2D (3D uniquement). ❌ PHI / serveur / migration.

## Architecture

```
client/src/lib/transferFunction.ts (PUR) :
  + ColorPoint { value:number; r:number; g:number; b:number }   // r/g/b ∈ [0..1]
  + normalizeColorPoints(points) → triés par value, rgb clampés [0..1], value finies
  + hexToRgb01("#rrggbb") → {r,g,b}∈[0..1]  ;  rgb01ToHex(r,g,b) → "#rrggbb"
  + defaultColorPoints(loHU, hiHU) → 2 points (noir→blanc) pour amorcer l'édition

client/src/components/VolumeViewer.tsx :
  + prop colorPoints?: ColorPoint[]
  + colorSig + useEffect (mode "3d") : getRGBTransferFunction(0) → removeAllPoints + addRGBPoint(value,r,g,b)
    (mirror exact de l'effet opacité `getScalarOpacity`/`addPoint`, même rAF post-preset)
    n'applique QUE si normalizeColorPoints(...).length >= 2

client/src/components/TransferFunctionEditor.tsx :
  + props colorPoints + onColorChange ; section « Couleurs » = liste de stops
    (valeur HU + <input type=color> + bouton supprimer) + « + couleur » (defaultColorPoints si vide)

client/src/pages/Viewer.tsx :
  + état colorPoints + passe colorPoints/onColorChange à l'éditeur ET colorPoints au VolumeViewer 3D
```

### Détails

- VTK : `property.getRGBTransferFunction(0)` → `removeAllPoints()` puis `addRGBPoint(value, r, g, b)`
  (r/g/b ∈ [0..1]) pour chaque point trié. Mêmes garde-fous que l'opacité (acteur pas prêt → ignoré).
- `colorSig` = `points.map(p => "v:r:g:b").join("|")` → re-applique au changement (deps de l'effet).
- Application **après** le preset (double `requestAnimationFrame`, comme l'opacité) pour surcharger sa couleur.
- Si l'utilisateur n'a pas défini de couleurs (0/1 point) → on **ne touche pas** la RGBTransferFunction
  (le preset clinique reste).

## Gestion d'erreurs

- API VTK absente / acteur pas prêt → ignoré (try/catch), comme l'opacité.
- Hex invalide → `hexToRgb01` renvoie noir `{0,0,0}` (pas d'exception).
- < 2 points → pas d'application.

## Tests (purs, vitest)

- `hexToRgb01` : `#ff0000` → {1,0,0} ; `#00ff00` → {0,1,0} ; invalide → {0,0,0}. `rgb01ToHex` round-trip.
- `normalizeColorPoints` : tri par value, clamp rgb [0..1], retire value non finies.
- `defaultColorPoints(lo,hi)` : 2 points, noir (lo) → blanc (hi).

## Intégration & déploiement

- Aucune migration, aucun modèle. Branche `feat/tf-color-editing`. Gate CI (tsc+tests+audit) → build GHCR
  → compose VPS → healthz 200 + garde 401. Vérif navigateur (mode 3D) : ajouter 2 couleurs (ex. rouge bas,
  jaune haut) → le volume se colore selon la rampe ; l'opacité continue de fonctionner indépendamment.
- Additif, réutilise l'effet TF existant → risque contenu.
