# Backfill PACS → MediView + rapatriement à la demande — design

Statut : validé (gérant, 2026-08-14). Prêt pour plan d'implémentation.

## Problème

MediView ne reçoit le flux du PACS du cabinet (dcm4chee, `192.168.1.180:11112`,
AET `DCM4CHEE`) que depuis fin juin 2026 (passerelle live). Les demandes SUVA
portent souvent sur des examens **antérieurs** (ex. réel : Uka Jetmir,
CT/CR du 26.08.2025). Ces patients et études ne sont pas dans MediView →
l'agent SUVA répond « patient non identifié / aucune étude », colis vide.

Le PACS contient **6 948 études / 3,8 M images ≈ 1,5-2 To** (2017→2026,
majorité CT). Copier tout dans le cloud est écarté (volume + coût ; le gérant a
choisi « fiches + images à la demande »).

## Contrainte physique (non contournable)

Le PACS est sur le LAN privé du cabinet ; le cloud (VPS72) ne peut pas
l'atteindre. Toute récupération d'image exige une machine **allumée sur le
réseau du cabinet**. Cette machine = la **passerelle actuelle** (le Mac du
gérant : maintenu éveillé par `caffeinate`, joint le PACS, pousse déjà le flux
live). « Sans que le gérant soit présent » est satisfait tant que ce Mac reste
branché. Décision gérant : réutiliser cette passerelle (pas d'achat de matériel).

## Faisabilité prouvée (spikes 2026-08-14)

- **C-FIND StudyRoot** : inventaire complet obtenu (6 948 études).
- **C-GET avec négociation de rôle SCP** : récupération réussie d'une étude MG
  (4 images, 210 Mo, statut `0x0000`). Le PACS renvoie les images sur la MÊME
  association — **pas besoin d'enregistrer une destination C-MOVE**. AE appelant
  accepté : `MEDIVIEWSCU` (le PACS accepte n'importe quel AET, cf.
  [[horos-onprem-pacs]]). Rôle SCP obligatoire (`build_role(..., scp_role=True)`)
  sinon `0xA702` (sous-opérations C-STORE refusées).

## Goals / Non-goals

**Goals** : (1) rendre identifiables TOUS les patients+études historiques dans
MediView (fiches sans pixels) ; (2) rapatrier les images d'un dossier
uniquement quand une demande SUVA en cours le réclame ; (3) ne jamais envoyer
un colis vide ; (4) ne jamais saturer le disque du VPS72.

**Non-goals** : copie de masse des 2 To ; nouvelle UI ; modification de la
passerelle live existante ; anonymisation différente de celle de `dicom.import`.

## Architecture

### A. Serveur MediView (repo horos-viewer, VPS72) — AUCUNE migration DB

Les tables `patients`/`studies`/`series`/`instances` existent déjà. Une étude
« fiche seule » = une étude sans lignes `instances` (compteur d'images à 0).

1. **`dicom.importStudyMeta`** (nouveau, `tRPC`, `importProcedure` = même jeton
   Bearer que `dicom.import`). Input : identité patient (patientId, patientName,
   birthDate, sex) + étude (studyInstanceUid, studyDate, studyTime,
   studyDescription, accessionNumber, referring/performingPhysician,
   institution, modality). Effet : `findOrCreatePatient` + `createStudy`
   (déjà idempotents). Pas de série, pas d'instance, pas de fichier. Renvoie
   `{ patientId, studyId, created }`. Le nom patient suit le chiffrement PHI +
   blind index existants (comme `dicom.import`).

2. **`GET /api/insurer/etudes-a-rapatrier`** (nouveau, `_core/index.ts`, jeton
   Bearer). Renvoie `{ studies: [{ studyInstanceUid, accessionNumber }] }` pour
   toutes les études (a) référencées par une `insurer_requests` en statut non
   terminal (`a_valider`, `prete`, `erreur`) via `studyIds`, ET (b) sans aucune
   ligne `instances`. Borne (ex. 50) pour éviter un rush. Jamais de PHI dans la
   réponse (UID/accession seulement).

3. **Garde anti-colis-vide** (deux niveaux, défense en profondeur) :
   - Dans `traiterDemande` (mailPoller) : après `matchStudies`, si une étude
     retenue a 0 instance → motif « Images en cours de rapatriement du PACS » +
     jamais d'envoi auto (rejoint le mécanisme de motifs existant).
   - Dans `construireColis` (bundle.ts) : si le ZIP ne contient AUCUN `.dcm`,
     LEVER au lieu de produire un colis vide — protège aussi la validation
     manuelle 1-clic.

4. **`matchStudies`** : vérifier qu'il matche bien une étude méta-seule (par
   date + modalité, comme aujourd'hui — les fiches portent date+modalité, donc
   pas de changement attendu ; à couvrir par un test).

### B. Passerelle cabinet (`~/mediview-rapatrieur`, HORS repo, sur le Mac)

Secrets dans un `.env` gitignoré (jeton `DICOM_IMPORT_TOKEN`, hôte/port/AET
PACS, URL MediView). Jamais de PHI ni de secret versionné.

5. **`backfill_meta.py`** (one-shot, relançable) : C-FIND StudyRoot de toutes
   les études (option : borne par année) → pour chacune, C-FIND niveau SERIES/
   IMAGE seulement si besoin des champs manquants (sinon l'étude suffit) →
   POST `dicom.importStudyMeta`. Idempotent (rejouable sans doublon côté
   serveur). Journalise un curseur (dernière étude poussée) pour reprise.

6. **`rapatrieur.py`** (launchd, intervalle 5 min, anti-réentrance par
   lockfile) : GET `etudes-a-rapatrier` → pour chaque UID, C-GET (rôle SCP) →
   pour chaque instance reçue, POST `dicom.import` (endpoint existant, qui
   anonymise + stocke). Logs locaux. En cas d'échec d'un dossier, réessai au
   cycle suivant (borné). Ne traite jamais deux fois le même dossier en
   parallèle.

### C. Garde disque (VPS72 : 46 Go libres / 89 %)

- Le serveur `dicom.import` reste inchangé (déjà borné par requête). Ajouter une
  **sonde d'espace** : `etudes-a-rapatrier` renvoie une liste vide (ou tronquée)
  si l'espace libre passe sous un seuil (ex. 10 Go), pour éviter que le
  rapatrieur ne remplisse le disque. Motif consigné.
- **Purge après envoi** : après l'envoi réussi d'un colis assureur, les
  instances rapatriées pour CETTE demande (études méta-seules devenues pleines
  au seul usage SUVA) peuvent être re-vidées (garder la fiche, supprimer les
  fichiers MinIO + lignes `instances`) selon un TTL court. **Décision** : dans
  une 1re version, NE PAS purger automatiquement (risque de re-télécharger) ;
  poser une sonde + alerte disque et purger manuellement si besoin. La purge
  auto est un fast-follow explicite.

## Flux complet (dossier Uka)

1. `backfill_meta.py` a poussé la fiche « Uka Jetmir + étude CT 26.08.2025 ».
2. Mail SUVA → extraction (déjà OK) → `matchPatient` identifie Uka (fiche
   présente) → `matchStudies` trouve l'étude (date+modalité) mais 0 image →
   motif « Images en cours de rapatriement », statut `a_valider`, pas d'envoi.
3. `rapatrieur.py` (≤5 min) voit l'UID dans `etudes-a-rapatrier` → C-GET →
   `dicom.import` → l'étude se remplit.
4. À la prochaine validation (ou re-traitement), le colis contient les images →
   le gérant valide en 1 clic → envoi à `suva.ouest@suva.ch`.

## Tests

- Serveur : unités sur `importStudyMeta` (création idempotente, fiche à 0
  instance), `etudes-a-rapatrier` (filtre statut + 0 instance + borne + sonde
  disque), garde anti-colis-vide (motif + `construireColis` lève), `matchStudies`
  sur étude méta-seule. Egress/PHI : la réponse `etudes-a-rapatrier` ne contient
  pas de PHI.
- Passerelle : les scripts Python sont hors CI ; validation par exécution réelle
  sur un petit lot (dry-run C-FIND, C-GET d'une étude, contrôle en base).

## Limites de confiance

`importStudyMeta` et `etudes-a-rapatrier` partagent le jeton de `dicom.import`
(déjà restreint à l'IP du cabinet par Traefik, cf.
[[mediview-import-clinique-panne]]). Aucune lecture PHI n'est exposée par ces
routes. La récupération dépend du Mac passerelle allumé au cabinet ; à défaut,
les demandes restent en `a_valider` avec motif clair (aucune perte).
