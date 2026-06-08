# Spec — MPR avancé (reconstruction multiplanaire depuis Orthanc)

- **Date** : 2026-06-08
- **Projet** : horos-viewer (visualiseur DICOM, PHI)
- **Statut** : design validé, en attente de relecture utilisateur avant plan d'implémentation
- **Approche retenue** : A — loader streaming Cornerstone3D + proxy DICOMweb authentifié

## 1. Problème

Le bouton MPR/3D d'Horos route déjà vers un composant `VolumeViewer.tsx` (186 lignes)
qui construit un vrai volume Cornerstone3D et affiche 3 plans orthogonaux — mais à
partir des URLs **locales (MinIO, schéma `wadouri:`)** et **sans** crosshair synchronisé,
W/L synchronisé interactif, plan oblique, ni épaisseur de coupe. On veut un **MPR avancé
réel** alimenté en priorité par **Orthanc/PACS via DICOMweb (WADO-RS)**.

La feature n'est donc pas vierge : c'est une **extension** de l'existant + un **nouveau
proxy serveur**.

## 2. Objectifs (critères de succès)

1. Récupérer une série (CT/IRM) depuis **Orthanc via WADO-RS** et en reconstruire un
   **volume** Cornerstone3D, en **chargement progressif/streaming** (tenir des volumes CT
   de plusieurs centaines de coupes).
2. **3 plans synchronisés** (axial / coronal / sagittal) : crosshair lié, navigation
   scroll/molette, **window/level synchronisé** (réutilise les 7 presets du viewer 2D).
3. **Plan oblique** (rotation libre) dans le 4ᵉ quadrant, piloté par la rotation du crosshair.
4. **Épaisseur de coupe (slab)** : slider mm + modes **MIP / MinIP / Moyenne**
   (`Enums.BlendModes`).
5. Intégré à l'UI viewer existante, en respectant **RBAC + PHI + audit (`recordAccess`)**.

## 3. Hors périmètre (volontaire pour cette version)

- Vrai rendu **3D volumétrique (VR)** poli et **MIP plein écran autonome** → phases suivantes
  (le slab-MIP est inclus ici, lui).
- MPR sur les **études locales MinIO** → phase ultérieure (Orthanc d'abord ; le composant et
  le proxy seront conçus pour que la coexistence reste possible).
- **Mesures cross-plans** dans le MPR → plus tard (les mesures 2D existantes restent sur le
  viewer standard).
- Reformatation curviligne (CPR), comptes-rendus structurés, assistant IA → autres specs.

## 4. Architecture & flux de données

```
Orthanc PACS ──WADO-RS──▶ [Proxy DICOMweb authentifié /api/dicomweb/*]  (serveur)
   (auth Orthanc)              │  JWT + rôle médical + recordAccess + validation UID
                              ▼
        Cornerstone3D loader "wadors:" ◀── même origine, cookie JWT transmis automatiquement
                              ▼
   Volume streaming ──▶ VolumeViewer : 3 plans ortho + oblique + slab + crosshair
```

Le client ne parle **jamais** directement à Orthanc → le PHI reste derrière l'auth de l'app,
l'audit est unifié.

## 5. Composants (unités, responsabilités, interfaces)

### 5.1 Serveur — proxy DICOMweb passthrough _(nouveau)_

- **Fichier** : `server/dicomwebProxy.ts`, monté via `app.use("/api/dicomweb", …)` dans
  `server/_core/index.ts` (sous l'`apiLimiter` existant).
- **Responsabilité** : relayer en **streaming** les réponses WADO-RS d'Orthanc, sans parser.
- **Garde d'accès** : JWT valide + `hasMedicalAccess` (même niveau que les procédures
  médicales tRPC). 401/403 sinon.
- **Routes relayées** (lecture seule) :
  - metadata : `/studies/{study}/series/{series}/metadata`
  - instances/frames/bulkdata : `/studies/{study}/series/{series}/instances/{sop}[/frames/{n}]`
- **Préserve** `Content-Type` (`application/dicom+json`, `multipart/related; type="application/octet-stream"`)
  et **forwarde les requêtes Range**.
- **Validation UID** stricte (regex DICOM UID) sur study/series/sop → anti-SSRF / path-traversal
  (même esprit que `safeAeTitle`).
- **Audit** : `recordAccess({ action: "mpr_volume_view", studyId, userId })` **une seule fois**
  par chargement de volume, déclenché sur la requête metadata (qui identifie l'étude) — pas
  par chunk, pour éviter le spam de logs.
- **Réutilise** `orthancFetch` (auth Orthanc déjà gérée) en mode passthrough.

### 5.2 Client — chargement du volume depuis Orthanc

- **Hook** : `useOrthancVolume(studyUid, seriesUid)` →
  - récupère la metadata via le tRPC existant (`wadoGetStudyMetadata` / `qidoSearchSeries`),
  - dérive les `imageIds` en `wadors:` pointant vers `/api/dicomweb/...`,
  - retourne `{ imageIds, volumeId, loading, error }`.
- **Config loader** : `@cornerstonejs/dicom-image-loader` (wadors) avec la base du proxy ;
  l'auth passe par le **cookie JWT même-origine** (transparent, pas de token à gérer).
- **Volume** : streaming via le loader déjà enregistré par `cornerstone.init()`.

### 5.3 Client — rendu MPR enrichi _(extension de `VolumeViewer.tsx`)_

- **ToolGroup** Cornerstone3D (`@cornerstonejs/tools`, déjà en dépendance) sur les viewports MPR :
  - `CrosshairsTool` (lignes de référence liées + saut au clic + **rotation = oblique**),
  - `WindowLevelTool` + **synchronizer VOI** (W/L cohérent sur les 4 vues),
  - `StackScrollTool`/molette, `PanTool`, `ZoomTool`.
- **4ᵉ quadrant** : viewport **oblique** (`ORTHOGRAPHIC`, normale ajustable) piloté par la
  rotation du crosshair.
- **Slab** : `viewport.setSlabThickness(mm)` + bascule `Enums.BlendModes` (MIP / MinIP / Moyenne).
- **Presets W/L** : réutilise les 7 presets du viewer 2D.

### 5.4 Intégration UI

- `viewMode === "mpr"` (déjà câblé dans `client/src/pages/Viewer.tsx`) :
  - bascule la source de `VolumeViewer` sur le volume Orthanc,
  - ajoute au toolbar, **en mode MPR uniquement** : slider d'épaisseur slab, bascule
    blend-mode, presets W/L.
- Le **viewer 2D stack reste inchangé** (moteur de rendu séparé, comme aujourd'hui).

## 6. Sécurité / PHI / audit

- Tous les octets passent par le **proxy authentifié même-origine** ; le client ne contacte
  jamais Orthanc directement.
- **Rôle médical requis** (`hasMedicalAccess`).
- **`recordAccess`** au chargement (niveau étude), action `mpr_volume_view`.
- **Validation UID** anti-SSRF/path-traversal.
- **Aucun PHI persisté** : le volume vit en mémoire navigateur (GPU) uniquement ; rien sur disque.

## 7. Gestion d'erreurs & performance

- Streaming + indicateur de chargement (existe) ; re-render à la fin du stream (existe).
- **Garde mémoire GPU** : avertissement/limite au-delà d'un nombre d'instances configurable ;
  message clair en cas d'échec (OOM).
- **Cleanup** renforcé au démontage : `engine.destroy()` **+ purge du volume du cache**
  (`cache.removeVolume`) pour éviter les fuites entre changements de série/mode.
- Erreurs lisibles : Orthanc injoignable, série non volumétrique (mono-coupe, espacement
  incohérent), accès refusé.

## 8. Tests

- **Serveur** (Vitest, mock `orthancFetch`) :
  - 401 sans JWT, 403 sans rôle médical,
  - UID invalide → 400 (anti-SSRF),
  - `recordAccess` appelé une fois sur metadata,
  - `Content-Type` et Range relayés correctement.
- **Client** :
  - dérivation des `imageIds` depuis la metadata,
  - setup du ToolGroup (crosshair/W-L/slab) sans collision avec le moteur 2D.
- **E2e** : Playwright non installé → noté en suivi optionnel (non bloquant).

## 9. Questions ouvertes / risques

- **Frames multiframe vs mono-frame** en WADO-RS : le loader wadors gère les deux, mais le
  proxy doit forwarder correctement le chemin `/frames/{n}` et le multipart.
- **Coexistence source locale (wadouri) / Orthanc (wadors)** : conçue pour rester possible
  même si le MPR local est hors périmètre maintenant.
- **Budget mémoire GPU** sur très gros volumes CT : à valider sur du matériel cible réel ;
  prévoir un seuil d'avertissement.

## 10. Fichiers impactés (prévisionnel)

- `server/dicomwebProxy.ts` _(nouveau)_
- `server/_core/index.ts` _(montage de la route)_
- `server/orthanc.ts` _(éventuel helper passthrough streaming)_
- `client/src/components/VolumeViewer.tsx` _(extension : ToolGroup, oblique, slab, source Orthanc)_
- `client/src/hooks/useOrthancVolume.ts` _(nouveau)_
- `client/src/pages/Viewer.tsx` _(contrôles toolbar en mode MPR)_
- tests : `server/dicomwebProxy.test.ts`, test client de dérivation d'imageIds
