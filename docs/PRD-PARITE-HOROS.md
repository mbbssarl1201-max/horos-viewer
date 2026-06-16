# PRD — MediView : recopie à l'identique de Horos 4.0.1

> **Objectif** : reconstruire **toutes** les fonctionnalités de **Horos 4.0.1** (visualiseur
> DICOM de référence, fork OsiriX) dans MediView, mais en **web** (React + Cornerstone3D /
> vtk.js) au lieu de macOS natif (Objective-C/Cocoa), avec en bonus le multi-tenant, le RBAC,
> l'audit et l'IA.
>
> **Source de vérité** : ce PRD est construit par **rétro-ingénierie de l'app réelle**
> installée (`/Applications/Horos.app`, v4.0.1) — arbre de menus extrait du `MainMenu.nib`
> (parsing de l'archive plist), barre d'outils et annotations relevées sur capture d'écran,
> 14 panneaux de préférences. **Rien n'est inventé ou tiré de la mémoire du modèle.**
>
> Date : 2026-06-11 · Repo : `horos-viewer` · Prod : `mediview.mbbssarl.ch` (branche `self-host`)

---

# PARTIE I — RÉFÉRENCE EXHAUSTIVE DE HOROS (le quoi reproduire)

## 1. Arbre de menus complet (extrait du binaire)

> Légende état MediView : ✅ fait · 🟡 partiel · ❌ absent. (raccourci ⌘ entre crochets)

### Menu **Horos / OsiriX**
- About Horos · Preferences… [⌘,] · Check for Updates · Hide / Show All · Quit [⌘Q]

### Menu **File**
- Show Database Window [⌘D] 🟡 · Toggle Albums & Sources drawer ❌ · Toggle History drawer ❌
- New Database Folder… · Open Database Folder… (n/a web — base serveur)
- **Albums** ❌ : Add an album / Add a smart album / Delete selected album / Save albums / Import albums / Create default albums
- **Report** : Open report [⌘O] 🟡 · Delete report · Convert to PDF… ✅ · Convert to DICOM PDF 🟡
- **Import** : Import Files… [⌘O] 🟡 · Import Image from URL… ❌ · Import Raw Data… ❌
- **Export** : Export to DICOM Network Node [⌘S] ✅ · Export to Movie [⌘s] ❌ · Export to JPEG [⌘E] 🟡 · Export to Raw ❌ · Export to TIFF ❌ · **Export to DICOM file(s)** ✅ · Export to Email 🟡 · Export to Photos ❌ · Export Displayed Database List as… ❌
- Burn… (CD/DVD) ❌→équivalent web · **Anonymize…** 🟡 · Copy Linked Files to Database Folder (n/a) · Search [⌘F] 🟡 · Merge Selected Studies ❌ · Delete Selected Exam 🟡 · **Meta-Data…** ❌
- Compress selected DICOM files ❌ · Decompress selected DICOM files ❌
- Rebuild Entire Database / Rebuild SQL Index / Rebuild Selected Thumbnails ✅(serveur)
- Close Window [⌘W] · Page Setup [⌘P] · **Print…** [⌘P] ❌ · **DICOM Print…** [⌘P] ❌

### Menu **Network**
- Export to DICOM Network Node [⌘S] ✅
- **Query / Retrieve Window…** [⌘R] 🟡 · Query Selected Patient from Q&R [⌘R] 🟡
- **Auto Query / Retrieve Window…** ❌ · Auto Query / Retrieve Refresh [⌘A] ❌
- Retrieve selected **PACS On-Demand** studies ❌ · Refresh PACS On-Demand results [⌘Y] ❌
- Abort Incoming DICOM Processes (Store-SCU) ❌ · **Network Logs** 🟡

### Menu **Edit**
- Undo [⌘Z] · Redo [⌘⇧Z] · Cut/Copy/Paste · Select All [⌘A] (standard — 🟡)

### Menu **Format**
- Customize Toolbar… ❌ · Fullscreen [⌘F] 🟡
- **Font** : Show Fonts / Bold / Italic / Bigger / Smaller / Show Colors

### Menu **2D Viewer** (le plus riche)
- Next/Previous **Series** · Next/Previous **Patient** · **Series List** [⌘N] 🟡
- **Convert between BW / RGB** : Red→BW, Green→BW, Blue→BW, RGB→BW, BW→Red/Green/Blue/RGB ❌
- **Reset Image View** [⌘R] 🟡 · Revert series [⌘R] ❌
- **Scale** : No Rescale (100%) / Actual Size / Scale To Fit 🟡
- **Sort By** : Instance Number ↑↓ / Slice Location ↑↓ 🟡
- **Orientation** : Flip Horizontal / Flip Vertical / Rotation 0/90/180° 🟡
- **Calibrate Resolution** ❌ · **3D Position Panel** 🟡 · **Navigator Panel** ❌ · Flip Series ❌
- **Use VOI LUT** ❌ · **Display DICOM Overlays** [⌘O] ❌ · **DICOM Meta-Data** [⌘I] ❌
- **Convert from/to SUV** 🟡 · **Fuse/De-Fuse PET/SPECT-CT** [⌘F] 🟡 · Flatten Fused Image ❌
- **Propagate Settings Between Series** [⌘G] ❌ · Don't Propagate WL&WW · Propagate Settings in Current Series [⌘⇧G] · Propagate Zoom if Planes Parallel
- **Sync Series (Same Study)** : Off / Slice Position-Absolute / Slice ID-Absolute / -Absolute Ratio / -Relative / Limit to Same Study 🟡
- Sync Series (Different Studies) at Current Position ❌
- **Key Image** [⌘K] 🟡 · Mark/Unmark All as Key Images · Mark All ROIs Images · Save as DICOM SC and mark · Find Next/Previous Key Image
- **Subtraction** (angio/DSA) ❌ : Subtract [⌘/] / New Mask / Sharpen / **Pixel Shift** (8 directions + none) / Contrast Down/Default/Up / Brightness Down/Default/Up / Sum Less/No/More
- **Annotations** : None / Graphics Only / Basic (No Name) / Full (Patient Name) / Plugin Only / **Display Cross Reference Lines** 🟡
- **Window Width & Level** ✅ · **Color Look Up Table** ❌ · **CLUT Bar** (Hide All / Original Only / Fused Only / Both) ❌ · **Opacity** ❌
- **Convolution Filters** + Apply on raw data ❌
- **Image Tiling** : 1×1 → **4×4** (16 combinaisons) 🟡(jusqu'à 2×2) · Windows Tiling Rows/Columns 1-9 ❌
- **Workspace State** : Save / Save as DICOM SR / Load / Load DICOM SR / Reset ✅(SR/GSPS)

### Menu **3D Viewer**
- **3D MPR** ✅ · **3D Curved-MPR** 🟡 · **2D Orthogonal MPR** ✅
- **3D MIP** ✅ · **3D Volume Rendering** ✅ · **3D Surface Rendering** 🟡(export only) · **3D Endoscopy** ❌
- Reset to Initial View [⌘R] · Revert Series
- Vues : Coronal / Left Sagittal / Right Sagittal / Axial 🟡
- **FlyThru** : Add Point / Remove Point / Reset Path ❌
- **3D Curved Path** : Load / Save 🟡
- **Scissor Editing** : Save / Load / Delete ❌ (découpe du volume 3D)
- **Select 3D Preset…** · Save Current State as 3D Preset… 🟡

### Menu **ROI**
- Import ROI(s)… ❌ · Save Selected / Save All ROIs of Series… ❌
- Delete All ROIs in Series / Delete All with Same Name 🟡
- Select All / Deselect All in Series ❌
- **ROI Manager…** ❌ · **ROI Info…** [⌘I] 🟡 · ROI Rename… · Set Default ROI Name…
- Display : Info Only when Selected / Info when mouse over / Name Only / **Cobb angle** ✅
- Increase/Decrease Thickness · Increase/Decrease Font Size
- Flip Horizontally / Vertically (ROI)
- **Histogram of Selected ROI…** ❌ · **Create Layer from Selected ROI** ❌
- **ROI Volume** : Compute Volume… / Generate Missing ROIs / Delete Generated ROIs / Erase Content / Restore Content ❌
- **Propagate Selected ROI…** / to Current Thick Slab [⌘S] ❌
- Group / Ungroup [⌘G/⌘U] ❌ · Lock / Unlock ❌ · Make Unselectable / Selectable ❌
- **Set Pixel Values to…** ❌ · **Grow Region (2D/3D Segmentation)…** ❌
- **Brush ROIs** : Erosion / Dilatation / Closing / Opening / Convert Polygon↔Brush / Merge Brush ❌

### Menu **Plugins**
- Image Filters / ROI Tools / Others / Database / Plugins Manager… ❌ (hors scope web)

### Menu **Window**
- Minimize · **Resize Window** (25/50/100/200/300% / iPod Video) 🟡 · **Tile 2D Viewer Windows** [⌘T] · **Tile 3D Viewer Windows** [⌘⇧T] · Close All Viewers [⌘⇧W] ✅ · Bring All to Front

### Menu **Recent Studies** ❌
- Liste dynamique des études récemment ouvertes.

---

## 2. Barre d'outils du visualiseur 2D (relevé capture)

Groupes (gauche→droite), tous **personnalisables** (Customize Toolbar) :

| Groupe | Boutons | MediView |
|---|---|---|
| **Cloud Report** | générer/envoyer compte-rendu | 🟡 |
| **Key Image** | marquer image clé | 🟡 |
| **Database** | retour base | ✅ |
| **Windows** | sélecteur de disposition (grille) | 🟡 |
| **Series** | sélecteur de série (vignette) | ✅ |
| **Annotations** | radio None / Basic / **Graphic** / Full | 🟡 |
| **Patient** | flèches précédent / suivant | 🟡 |
| **Mouse button function** | outil **Left Button** / **Right Button** (WL, pan, zoom, rotate, scroll, longueur…) | 🟡 |
| **WL/WW & CLUT** | preset **WL/WW** (« Default WL & WW ») · **CLUT** (« No CLUT ») · **Opacity** (« Linear Table ») · icône réglage soleil | 🟡 |
| **2D/3D** | 3 presets rendu (cerveau) | 🟡 |
| **Orientation** | vignettes axial / coronal / sagittal | 🟡 |
| **Thick Slab / Mode** | mode (**MIP – Max Intensity Projection**, MinIP, Mean, Volume…) + nb coupes + épaisseur mm (slider) | 🟡 |
| **Movie Export** | export ciné/vidéo | ❌ |

**Modes souris configurables (Left/Right Button)** : WL/WW, Pan, Zoom, **Rotate**, Scroll/Stack,
Length, Angle, ROI…, Magnify (loupe), 3D rotate. → outil par bouton, mémorisé.

---

## 3. Annotations à l'écran (overlay du viewer 2D)

Texte superposé reproduit à l'identique (relevé capture, configurable cf. Custom Annotations) :

- **Coin haut-gauche** : `Image size: 512 x 512` · `View size: WxH` · `WL: 30 WW: 320` ·
  `X: .. px Y: .. px Value: ..` (valeur HU sous curseur) · `X/Y/Z: .. mm` (coord. patient 3D)
- **Coin haut-droit** : ID instance · âge patient · description série (« Genoux ») · n° série
- **Coin bas-gauche** : `Zoom: 299% Angle: 0` · `Im: 62/122 (S → I)` (indice/total + sens) ·
  `Uncompressed` (transfer syntax) · `Thickness: 2.00 mm Location: 592.00 mm`
- **Coin bas-droit** : date/heure acquisition · `Made In Horos`
- **Bords** : **lettres d'orientation** A / P / **R** / **L** (Antérieur/Postérieur/Droite/Gauche, + H/F)
- **Règles graduées** (haut/gauche) calibrées en mm ; barre CLUT optionnelle.

Niveaux d'annotation (radio toolbar) : **None / Graphics Only / Basic (No Name) / Full / Plugin Only**.

---

## 4. Fenêtre Base de données (Database window)

- **Tiroir gauche** : Albums + Smart Albums, Sources (locales / Bonjour / PACS / WADO), Activity.
- **Tableau central** : études — colonnes Name, ID, Age, Date Acquired, Date Added, Modality,
  # series, # images, Comments 1-4, Status, Report, Institution, History, Lock, Sources, Date Opened.
- **Tiroir bas** : vignettes des séries de l'étude sélectionnée (drag→viewer).
- Recherche multi-champs (tous champs / nom / ID / accession / dates / modalité) + intervalle.
- Clic droit étude : ouvrir, ouvrir en 3D/4D, exporter, anonymiser, envoyer, comparer, supprimer.

---

## 5. Visualiseur 2D — comportements

- Empilement (stack scroll molette), W/L (clic-glisser), zoom, pan, rotation, flip.
- Presets WL/WW par modalité (CT poumon/os/tissu mou/cerveau…), CLUT (palettes couleur).
- Slab épais 2D (MIP/MinIP/Mean) avec nb de coupes + épaisseur mm.
- Cross-reference lines (localizer) entre séries perpendiculaires (FrameOfReferenceUID).
- Synchronisation inter-viewports (position/ID absolu/relatif/ratio).
- Soustraction (DSA/angio) : masque + pixel shift + somme.
- VOI LUT, overlays DICOM, inspecteur méta-données (⌘I).
- Calibration manuelle de résolution. Navigator (mini-carte). Images clés.

## 6. Visualiseur 3D — 7 modes

1. **2D Orthogonal MPR** (3 plans + épaisseur) ✅
2. **3D MPR** (plans obliques interactifs) ✅
3. **3D Curved-MPR** (reformatage le long d'une courbe) 🟡
4. **3D MIP** (projection intensité max) ✅
5. **3D Volume Rendering** (presets, opacité, ombrage, cinématique) ✅
6. **3D Surface Rendering** (iso-surface, seuil) 🟡 export seulement
7. **3D Endoscopy** (caméra interne + FlyThru path) ❌
+ **4D Viewer** (séries temporelles : cardiaque/perfusion) ❌
+ **Scissor editing** (découpe volume), presets 3D sauvegardables, vues normalisées.

## 7. ROI Manager & outils ROI

- Types : Length, Angle, **Cobb**, Oval, Rectangle, Polygon, **Pencil/Brush** (peinture),
  **Wand/Grow Region** (segmentation par seuil), Arrow, Text, Point 2D.
- ROI Manager : liste, renommer, grouper, verrouiller, calques, nom par défaut.
- Opérations : **Histogramme**, **Compute Volume (mm³)**, **propagation** sur slab/série,
  **Generate Missing ROIs** (interpolation), **Set Pixel Values**, **morpho** (érosion/dilatation/
  ouverture/fermeture), Convert Polygon↔Brush, Merge Brush, Save/Load/Import/Export, Erase/Restore.

## 8. Préférences (14 panneaux — extraits réels)

| Panneau | Réglages clés |
|---|---|
| **General** | serveur de préférences, comportement global |
| **Viewer** | ordre fenêtres (récent→ancien), cross-reference lines via FrameOfReferenceUID, couleurs labels, tiling |
| **Database** | commentaires/statut sauvés dans DICOM, effacer recherche au changement d'album, âge à l'acquisition |
| **3D** | bouton « Best Rendering », espace colorimétrique, presets |
| **Hanging protocols** | « Display last study if possible », règles d'affichage par modalité |
| **Listener (SCP)** | recevoir C-STORE, JPEG Baseline, AET source/dest dans tags, ajout à la DB par défaut |
| **Locations** | nœuds DICOM (AET/host/port) pour Q/R & Send, WADO, C-MOVE, jeux de caractères |
| **PET** | calcul SUV (AcquisitionTime, décroissance, poids) |
| **Autorouting** | règles d'acheminement automatique des études reçues |
| **CD/DVD** | gravure, mode Scan si pas de DICOM, visualiseur autonome |
| **Web Sharing** | serveur WADO `/wado`, navigation albums, notifications email auto, max frames vidéo portail |
| **DICOM Print** | impression sur film/imprimante DICOM (AYDicomPrint) |
| **HotKeys** | raccourcis clavier configurables |
| **Custom Annotations** | overlay d'écran personnalisable (quels tags aux 4 coins) |

---

# PARTIE II — CADRE PRODUIT

## 9. Personas & user stories
- **Radiologue lecteur** : relire avec les mêmes outils (MPR, fusion, mesures, CR) depuis tout poste, sans install.
- **Manipulateur / secrétaire** : importer, anonymiser, transmettre une étude en quelques clics.
- **Médecin référent externe** : lien sécurisé vers images + CR, sans compte.
- **Administrateur** : gérer accès, audit, nœuds DICOM, hanging protocols.

**Succès global** : un habitué de Horos fait **≥ 90 %** de son flux de lecture courant dans MediView.

## 10. Métriques & définition de « fait »
| Métrique | Cible |
|---|---|
| Couverture vs Horos (cœur lecture) | ≥ 90 % |
| Ouverture étude CT 500 coupes | < 4 s 1re image |
| Exactitude mesures (mm) vs Horos | écart < 1 % |
| Disponibilité prod | ≥ 99,5 % |
| Incidents PHI / fuite cross-tenant | 0 |

**DoD par fonctionnalité** : spec respectée + tests (helpers purs) + revue sécu (anti-IDOR
série∈étude∈tenant, RLS) + vérif live navigateur + doc à jour.

## 11. Analyse d'écart chiffrée (état actuel MediView)
| Module | Couverture | Manques principaux |
|---|---|---|
| Visualiseur 2D | ~40 % | CLUT, convolution, soustraction, localizer, overlays, tag inspector, sync, calibration, navigator |
| Outils ROI | ~45 % | wand/grow, histogramme, volume, propagation, brush+morpho, manager, groupes/verrou |
| 3D | ~55 % | surface interactif, endoscopie/flythru, 4D, scissor, curved final |
| Base / navigateur | ~30 % | albums, smart albums, comparatif/antériorités, colonnes, sources |
| Réseau DICOM | ~50 % | auto-Q/R, PACS on-demand, listener/SCP, autorouting |
| Compte-rendu | ~70 % | modèles de rapport |
| Sorties | ~40 % | movie, compression, print, chiffré, photos, raw/tiff |
| Admin / préférences | ~50 % | 14 panneaux à porter, hotkeys, custom annotations |
| **Global** | **~45 %** | **cible ≥ 90 %** |

## 12. Phasage, dimensionnement & priorité
| Phase | Contenu | Effort | Valeur | Priorité |
|---|---|---|---|---|
| **A** Visualiseur 2D « comme Horos » | CLUT+palettes, convolution, 4×4+sync, scale/orientation, calibration, localizer, overlays, **tag inspector**, navigator, images clés, annotations 4 coins, modes souris L/R | **L** | ⭐⭐⭐ | **P0** |
| **B** ROI complet | brush+morpho, wand/grow, histo, volume, propagation, generate missing, set-pixel, manager, groupes/verrou/calques, save/load | **L** | ⭐⭐⭐ | **P1** |
| **C** Base façon Horos | albums + smart albums, comparatif/antériorités, recherche multi-champs, colonnes, sources, import DICOMDIR | **M** | ⭐⭐ | **P1** |
| **D** 3D complet | curved final, fusion+SUV live, surface interactif, scissor, 4D, endoscopie/flythru | **XL** | ⭐⭐ | **P2** |
| **E** Sorties & réseau | anonymisation par lot, compress/decompress, export movie/jpeg/tiff/raw, export chiffré, partage lien, auto-Q/R, PACS on-demand | **M** | ⭐⭐ | **P2** |
| **F** Admin/prefs | 14 panneaux préférences, hotkeys configurables, custom annotations, hanging avancé | **M** | ⭐ | **P3** |
| **G** (déféré on-prem/matériel) | Listener/SCP, autorouting, DICOM Print, burn CD→ZIP+visualiseur web | **L** | ⭐ | **P3** |

Recommandation : **A d'abord** (effet « comme Horos » immédiat, risque faible), puis B+C en parallèle.

## 13. Spécifications data clés (nouvelles)
- **Albums** : `albums(id, tenant, name, isSmart, predicateJson)` + `album_studies`. Smart =
  prédicat évalué à la requête (réutiliser le builder de filtres). Anti-IDOR tenant.
- **Comparatif** : requête « antériorités du patient » (même PatientID, tenant), ouverture
  multi-viewport synchronisée.
- **CLUT** : tables de palettes (B&W, Hot Iron, PET, Rainbow, Flow…) appliquées en shader.
- **Convolution** : noyaux 3×3/5×5 (sharpen/blur/edge) sur le rendu Cornerstone.
- **Cross-reference lines** : via `FrameOfReferenceUID` (préf. Horos), projeter la position
  d'un viewport sur les autres séries.
- **Nœuds DICOM** : `dicom_nodes(id, tenant, aet, host, port, role, wado)` + test C-ECHO.

## 14. Risques & dépendances
- **Perf 3D web** (endoscopie/4D/surface) : sous-échantillonnage, rendu progressif, gardes mémoire.
- **Labelmap Cornerstone v4** (brush) : init tardive (bug `createAndCacheDerivedLabelmapImages`).
- **PHI / cloisonnement** : réseau (Q/R, listener) reste dans le périmètre on-prem du cabinet ;
  ne **jamais** réutiliser le PACS d'un autre projet (cf. `horos-onprem-pacs`, `keep-projects-separate`).
- **Multi-tenant** : toute nouvelle requête → garde série∈étude∈tenant + RLS + revue sécu.
- **Régulatoire** : MediView reste une **aide**, pas un dispositif certifié (cf. `CONFORMITE-CE-MDR.md`).

## 15. Hors scope / non-objectifs
- Plugins natifs Cocoa (modèle web différent). Gravure CD/DVD physique → ZIP + visualiseur web.
- Souris 3D matérielle (3Dconnexion). Marquage CE/MDR (processus réglementaire).

## 16. Pile technique cible
React 19 + Vite · Cornerstone3D v4 · `@kitware/vtk.js` 34 · tRPC v11 · Drizzle/MySQL · Express ·
MinIO/S3 · dcmjs · jsPDF · archiver · ffmpeg (serveur) · `@anthropic-ai/sdk`. Tests : Vitest + Playwright.

> **Méthode** : chaque phase → `superpowers:brainstorming` → `writing-plans` → exécution
> sous-agents, revue sécu, vérif live. Déploiement branche `self-host` (PR), jamais `main`.
