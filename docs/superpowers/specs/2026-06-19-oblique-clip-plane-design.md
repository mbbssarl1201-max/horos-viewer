# MediView — plan de coupe oblique (clipping 3D) — Design

> **Statut** : design validé · **Date** : 2026-06-19 · **Repo** : `horos-viewer` (MediView). 100 % client
> (VTK.js via Cornerstone3D), aucun PHI/serveur/migration. Étend le clipping par axe (PR #94).
> Cf. [[mediview-vr-avance]] (« Oblique reporté »), [[mediview-horos-parity]].

## Problème

Le clipping 3D existant n'offre que 3 plans **alignés sur les axes** (Sagittal X / Coronal Y / Axial Z).
Horos permet un **plan de coupe oblique** librement orientable. On l'ajoute, en réutilisant la mécanique
de clipping existante (`vtkPlane` + `addClippingPlane`, passe unique).

## Objectifs

1. Un **plan de coupe oblique** supplémentaire en mode 3D : activable, orienté par **azimut** (0–360°)
   - **élévation** (−90..90°), positionné le long de sa normale (slider 0–1), avec **inversion** du
     demi-espace conservé.
2. **Additif** : les 3 plans par axe restent inchangés ; l'oblique s'ajoute dans la **même passe** de
   clipping (un seul `removeAllClippingPlanes`, puis tous les plans actifs).
3. Logique **pure et testée** (calcul normale/origine sans VTK/DOM), comme `axisClipPlane`.

## Non-objectifs

- ❌ Manipulation interactive 3D du plan à la souris (gizmo) — contrôle par sliders en v1.
- ❌ Plusieurs plans obliques (un seul) ; ❌ clipping en MPR/2D (3D uniquement, comme l'existant).
- ❌ PHI / serveur / migration.

## Architecture

```
client/src/lib/clipPlanes.ts (PUR) :
  + ObliqueClipConfig { enabled, azimuthDeg, elevationDeg, position, invert }
  + obliqueClipPlane(bounds, azimuthDeg, elevationDeg, position01, invert) → ClipPlaneSpec
      normale = sphérique(az,el) normalisée ; origine = centre + normale·((pos-0.5)·diagonale)
  + buildObliqueClipPlane(bounds, config) → ClipPlaneSpec | null  (null si !enabled / bounds invalides)

client/src/components/VolumeViewer.tsx :
  + prop obliqueClip?: ObliqueClipConfig
  dans la passe de clipping (≈ l.1069-1129) : après les plans par axe, si oblique → addClippingPlane
  inclure obliqueClip dans la signature `clipSig` (re-applique au changement)

client/src/pages/Viewer.tsx :
  + état obliqueClip (enabled:false, azimuthDeg:0, elevationDeg:0, position:0.5, invert:false)
  + ligne UI dans le bloc clipping 3D (≈ l.2427) : case Oblique + sliders azimut/élévation/position + invert
  + passe obliqueClip={obliqueClip} au VolumeViewer
```

### Détails

- **Normale** : `el = elevationDeg·π/180`, `az = azimuthDeg·π/180` →
  `n = [cos(el)·cos(az), cos(el)·sin(az), sin(el)]` (unitaire) ; `invert` → `n = -n`.
- **Origine** : `c = centre du volume` ; `diag = ‖(xmax-xmin, ymax-ymin, zmax-zmin)‖` ;
  `origin = c + n·((position01-0.5)·diag)` → le slider fait coulisser le plan d'un bord à l'autre.
- **`buildObliqueClipPlane`** renvoie `null` si `!enabled` ou `bounds` < 6 → VolumeViewer n'ajoute rien.
- VTK : même usage que l'existant (`vtkPlane.newInstance()` + `setOrigin`/`setNormal` +
  `mapper.addClippingPlane(pl)`), dans la passe unique déjà en place.

## Gestion d'erreurs

- `bounds` invalide / oblique désactivé → aucun plan ajouté (pas d'erreur).
- Angles hors borne → `clamp` (azimut mod 360 ; élévation bornée [−90,90]) côté pur.
- API VTK absente → la passe existante ignore déjà proprement (try/catch en place).

## Tests (purs, vitest)

- `obliqueClipPlane` : az=0/el=0 → normale ≈ [1,0,0] ; az=90/el=0 → ≈ [0,1,0] ; el=90 → ≈ [0,0,1] ;
  `invert` → normale opposée ; position=0.5 → origine = centre du volume.
- `buildObliqueClipPlane` : désactivé → null ; bounds invalides → null ; activé → spec non nulle.
- (les tests `axisClipPlane`/`buildClipPlanes` existants restent verts.)

## Intégration & déploiement

- Aucune migration, aucun modèle. Branche `feat/oblique-clip-plane`. Gate CI (tsc+tests+audit) → build
  GHCR → compose VPS → healthz 200 + garde 401. Vérif navigateur (mode 3D) : activer l'oblique →
  le volume est coupé selon le plan ; azimut/élévation/position le réorientent ; invert bascule le côté.
- Mode **additif**, réutilise la passe de clipping existante → risque contenu.
