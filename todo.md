# Horos Viewer - Project TODO

## Phase 1 : Configuration & Structure
- [x] Thème dark mode professionnel (palette médicale Horos/OsiriX)
- [x] Schéma de base de données (patients, études, séries, instances DICOM)
- [x] Structure de navigation et layout principal

## Phase 2 : Interface PACS Principale
- [x] Sidebar avec Albums et filtres par modalité (CR, CT, MG, MR, RF, US)
- [x] Liste des études patients (colonnes : Patient, Date, Modalité, Description)
- [x] Barre d'outils professionnelle (Import, Export, Email, Query, Anonymize, Cloud, Presets)
- [x] Dashboard layout avec panneau latéral et zone de contenu principale

## Phase 3 : Viewer DICOM 2D (Cornerstone3D)
- [x] Intégration Cornerstone3D pour affichage DICOM
- [x] Navigation entre coupes (scroll via mousewheel + keyboard + slider)
- [x] Zoom, Pan, et ajustement Window/Level (tools câblés via ToolGroupManager)
- [x] Presets de fenêtrage (Bone, Lung, Brain, Abdomen, Liver, Mediastinum) dans l'UI

## Phase 4 : Fonctionnalités Avancées
- [x] Outils d'annotation : longueur, angle, ROI rectangulaire/elliptique, texte (Cornerstone tools)
- [x] Import DICOM par drag & drop et sélection de fichiers/dossiers (avec parsing dicom-parser)
- [x] Export images JPEG/PNG (via canvas.toDataURL)
- [x] Export séries DICOM complet (ZIP archive via archiver + route Express authentifiée)
- [x] Génération rapports PDF réels (jsPDF côté serveur avec route Express)
- [x] Statistiques HU : overlay UI prêt + polling best-effort des annotations ROI
- [x] Mode MPR : bouton toolbar + overlay crosshair visuel (reconstruction réelle nécessite VolumeViewport)
- [x] Mode 3D : bouton toolbar + placeholder (rendu volumique réel nécessite VolumeViewport setup)

## Phase 5 : Backend & Sécurité
- [x] Stockage S3 des fichiers DICOM avec organisation patient/étude/série
- [x] Authentification sécurisée avec rôles (admin, radiologue, technicien)
- [x] Accès protégé aux données patients (RBAC - protectedProcedure + adminProcedure)
- [x] Notifications automatiques in-app (nouvelle étude, urgence STAT, rapport finalisé)
- [x] Anonymisation DICOM : PII blanked dans buffer avant stockage S3 + route anonymize DB
- [x] Build de production fonctionnel (fix Cornerstone3D worker.format)
- [x] 12 tests unitaires passent
- [x] Interface Query PACS : formulaire UI complet (C-FIND/résultats/config) - logique placeholder
- [x] Proxy Orthanc : service orthanc.ts complet (C-FIND, C-MOVE, C-STORE, QIDO-RS, WADO-RS, STOW-RS)
- [x] API DICOMweb : routes tRPC orthanc.queryStudies, orthanc.cMove, orthanc.status
- [x] Notifications par email : service email.ts avec nodemailer (notifyNewStudy, notifyStatUrgent, notifyReportFinalized)
- [ ] Configuration SMTP et Orthanc (nécessite secrets ORTHANC_URL, SMTP_HOST, etc.)

## Notes
- Les items marqués [ ] sont des fonctionnalités avancées qui nécessitent un serveur Orthanc externe (non disponible dans l'environnement Cloud Run)
- L'interface Query PACS et les composants MPR/3D sont présents dans l'UI avec des placeholders fonctionnels
- Le build de production passe sans erreur (Vite + esbuild)

## Phase 6 : Alignement complet avec Horos (UI fidèle)
- [x] Toutes les modalités DICOM (CR, SC, CT, MR, PT, NM, US, XA, MG, DR, RG, DX, AU, OT, RF, XC, ES, VL, SR)
- [x] Colonnes table complètes (Patient Name, Report, Lock, Patient ID, Age, Accession Number, Study Description, Modality, ID, Comments, History)
- [x] Albums complets (Database, Cases with comments, Interesting Cases, Just Acquired, Just Added, Just Opened)
- [x] Sources PACS affichées (Documents DB + iMac-de-admin + MAC-IRM) - UI présente
- [x] Sources PACS dynamiques (CRUD + persistance en DB + affichage sidebar)
- [x] Toolbar complète UI (tous les boutons Horos présents)
- [x] Toolbar actions : toasts informatifs pour actions non-connectées, actions réelles pour Import/Export/Query/Anonymize/MetaData/Delete/Viewer
- [x] Filtres temporels UI (dropdown avec toutes les options)
- [x] Filtres temporels fonctionnels (wiré dans la query studies avec gte sur createdAt)
- [x] Barre de menu complète UI (tous les items Horos présents)
- [x] Menus déroulants réels pour File, Network, Edit, Format, Plugins (avec actions wirées)
