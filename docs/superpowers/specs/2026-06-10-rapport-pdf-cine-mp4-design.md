# Spec — Compte rendu PDF structuré + ciné MP4 de la série (envoi confrère)

- **Date** : 2026-06-10
- **Projet** : horos-viewer (visualiseur DICOM, PHI)
- **Statut** : design validé (brainstorming), en attente de relecture utilisateur avant plan
- **Sous-systèmes couverts** : **C** (rapport PDF détaillé) + **B** (export « vidéo » MP4 de toute la série). Le **diagnostic IA (sous-système A)** fera l'objet d'un spec séparé ensuite.

## 1. Problème

Aujourd'hui Horos ne sait envoyer par email qu'**une seule image capturée** (`email.sendReport`). Un médecin doit pouvoir transmettre **à un confrère** (médecin → médecin, pas au patient) un **compte rendu radiologique structuré et précis** accompagné de **toute la série en mouvement**.

## 2. Objectifs (critères de succès)

1. **Composer un compte rendu structuré** dans le viewer et l'exporter en **PDF** : **en-tête fixe Institut de Champel** (blason/logo + coordonnées du cabinet) + identité patient/étude (auto depuis DICOM/DB), sections _Indication / Technique / Résultats / Conclusion_ (saisies par le médecin), **images clés** sélectionnées + **mesures** associées (Length/Angle/ROI/HU reportées en texte), **signature** du médecin.
2. **Générer un MP4** : ciné du défilement de **toute la série** (avec le fenêtrage W/L choisi appliqué).
3. **Envoyer les deux** (PDF + MP4) au confrère par **email**, en étendant l'infrastructure email existante (nodemailer/Mailu).

## 3. Positionnement & cadre réglementaire

- Le compte rendu est **rédigé et signé par un médecin** (aucune IA dans ce spec). Le médecin expéditeur engage sa responsabilité. Audience = un autre médecin.
- Le diagnostic **assisté par IA** (brouillon validé par le médecin avant envoi) est **hors périmètre ici** et sera cadré séparément (dimension dispositif médical MDR/Swissmedic à traiter à ce moment-là).

## 4. Approche retenue

**① Rendu côté serveur** (validé contre l'alternative « capture client »). Le serveur possède déjà les DICOM (MinIO), sait les parser (`dcmjs`) et assembler un PDF (`jsPDF`). Le client n'envoie que des **données de composition** (texte, index de coupes, W/L, PNG d'images clés validés) ; le serveur fait le rendu autoritatif. Cela **respecte la règle de sécurité existante** (le PDF n'est jamais fabriqué côté client — finding HIGH déjà corrigé) et reste fiable pour ~300 coupes indépendamment de la machine du médecin.

Alternative écartée : capture client (MediaRecorder → webm, PDF client) — lente, dépendante du navigateur, et viole la règle « pas de PDF fabriqué client ».

## 5. Architecture & flux de données

```
Viewer (médecin) — panneau "Compte rendu" : sections + images clés + mesures + W/L + signature
        │  tRPC report.sendStudyReport   (medicalProcedure : RBAC + rate-limit + audit)
        ▼
Serveur — recharge l'étude/série/instances de CONFIANCE (DB + MinIO) :
   1) PDF  : jsPDF — en-tête cabinet, identité auto, 4 sections, images clés + mesures, signature, pagination
   2) MP4  : par coupe → dcmjs décode pixels → RescaleSlope/Intercept → W/L → frame 8-bit gris (pngjs)
             → ffmpeg → MP4 H.264 yuv420p (fps réglable, sous-échantillonnage si > N coupes)
   3) Email: sendEmail() — PDF + MP4 en pièces jointes
        ▼
Confrère : compte-rendu-<id>.pdf  +  serie-cine-<id>.mp4
```

Le client ne transmet **jamais** d'identité patient ni de PDF fabriqué : seulement texte borné, index de coupes, W/L, et PNG d'images clés (validés signature+IHDR comme aujourd'hui).

## 6. Composants (unités, responsabilités, interfaces)

### 6.1 Client — panneau « Compte rendu » _(nouveau)_

- **Fichier** : `client/src/components/ReportPanel.tsx`, ouvert depuis le viewer (nouveau bouton « Compte rendu » dans la barre d'outils, à côté d'Email).
- **Responsabilité** : saisir les 4 sections, le destinataire, le nom+signature ; ajouter l'image courante comme image clé (capture le PNG du canvas + les mesures visibles sous forme de texte) ; lister/retirer les images clés ; cocher « inclure la vidéo de la série » ; envoyer.
- **Sortie** : appelle la mutation `report.sendStudyReport`. N'assemble aucun PDF.

### 6.2 Serveur — rastérisation DICOM _(nouveau)_

- **Fichier** : `server/report/dicomRaster.ts`.
- **Fonction** : `renderDicomFrame(dicomBuffer, { windowWidth, windowCenter }) → { png: Buffer, rows, cols }`.
- **Détail** : `dcmjs` parse le dataset ; lit PixelData, Rows, Columns, BitsAllocated, PixelRepresentation, PhotometricInterpretation, RescaleSlope (défaut 1), RescaleIntercept (défaut 0). Applique `valeur = pixel*slope + intercept`, fenêtrage W/L → clamp [0,255], inversion si MONOCHROME1. Encode en PNG niveaux de gris via `pngjs` (pur JS, pas de natif).
- **Dépendances** : `dcmjs` (déjà présent), `pngjs` (nouveau).

### 6.3 Serveur — ciné MP4 _(nouveau)_

- **Fichier** : `server/report/cineVideo.ts`.
- **Fonction** : `buildCineMp4(frames: Buffer[], { fps }) → Buffer`.
- **Détail** : écrit les frames PNG dans un dossier **temporaire éphémère**, invoque **ffmpeg** (spawn, ou `fluent-ffmpeg`) pour produire un MP4 H.264 `yuv420p` (compat large), nettoie le dossier temp. **Sous-échantillonnage** : si la série dépasse un seuil (ex. 300 coupes) ou pour borner la taille, échantillonner les coupes (paramètre) ; `log()` ce qui est échantillonné (pas de troncature silencieuse). Renvoie le buffer MP4.
- **Dépendances** : binaire `ffmpeg` (ajout Docker), éventuellement `fluent-ffmpeg`.

### 6.4 Serveur — PDF structuré _(nouveau)_

- **Fichier** : `server/report/reportPdf.ts`.
- **Fonction** : `buildReportPdf({ study, report, signature, keyImages }) → Buffer`.
- **Détail** : jsPDF — **en-tête fixe Institut de Champel** (blason/logo embarqué + coordonnées du cabinet, indépendant du champ Institution du DICOM ; réutiliser l'asset blason déjà recréé pour les modèles de documents Champel), bloc identité patient/étude (auto), 4 sections titrées (texte échappé, retour à la ligne), images clés (chaque PNG + sa légende/mesures), ligne de signature + date, pagination. Renvoie le buffer PDF.

### 6.5 Serveur — mutation `report.sendStudyReport` _(nouveau, étend l'esprit de `email.sendReport`)_

- **Fichier** : dans `server/routers.ts` (routeur `report` ou extension d'`email`).
- **Garde** : `medicalProcedure`, rate-limit (réutilise `countRecentAccess`, 20/h), audit `recordAccess({ action: "study.email.report", studyId, detail: to })`.
- **Logique** : recharge `getStudyById` + vérifie que `seriesId` appartient à l'étude ; valide les PNG d'images clés (signature+IHDR, cap taille) ; construit le PDF ; si `includeVideo` et série ≥ 2 coupes, construit le MP4 (sinon PDF seul) ; envoie via `sendEmail` avec les pièces jointes ; **fail-closed** (toute erreur de rendu/ffmpeg annule l'envoi — pas d'email partiel) ; nettoie les fichiers temp ; renvoie `{ success: true }`.

### 6.6 Contrat d'entrée (zod)

```ts
report.sendStudyReport({
  to: string.email(),
  studyId: number, seriesId: number,
  report: { indication: string, technique: string, resultats: string, conclusion: string },  // chacun borné (ex. max 5000)
  signature: string,            // nom du médecin signataire, borné
  windowWidth: number, windowCenter: number,  // bornés
  keyImages: Array<{ pngBase64: string, sliceIndex: number, measurements?: string }>,  // PNG validés, cap ~7.5 Mo chacun, max N images
  includeVideo: boolean,
  message?: string (max 500),
})
```

### 6.7 Docker

- Ajouter `RUN apk add --no-cache ffmpeg` au stage **production** du `Dockerfile`. Ajouter `pngjs` (+ `fluent-ffmpeg` si retenu) aux dépendances.

## 7. Sécurité / PHI

- `medicalProcedure` + rechargement serveur de l'étude/série (pas de confiance au client pour identité/contenu).
- Validation : PNG (signature+IHDR, cap) ; textes bornés zod + échappés dans le PDF ; W/L numériques bornés.
- PHI : PDF + MP4 contiennent des données patient ; envoi mail en clair = risque nLPD/RGPD **assumé** (pas de mot de passe — décision utilisateur 2026-06-10). Bandeau « document médical confidentiel ». Audit + rate-limit. Fichiers temporaires (frames/MP4) en dossier **éphémère supprimé** après envoi ; **jamais** dans MinIO ni en git.

## 8. Gestion d'erreurs (fail-closed)

- Décodage d'une coupe ou ffmpeg échoue → **annuler l'envoi**, erreur claire (pas d'email partiel).
- `includeVideo=false` ou série < 2 coupes → PDF seul.
- Export long (~10-30 s pour ~300 coupes) → mutation **synchrone longue** en v1, indicateur « génération en cours » côté client.

## 9. Tests (Vitest)

- `dicomRaster` : DICOM synthétique zéro-PHI (16-bit monochrome, slope/intercept connus) → W/L mappe min/max → 0/255 ; MONOCHROME1 inversé.
- `reportPdf` : sortie commence par `%PDF`, nb de pages/images attendu, texte échappé.
- `cineVideo` : 3 frames factices → MP4 non vide à en-tête valide ; **skip propre** si `ffmpeg` absent (comme les tests DB skipped).
- Mutation : autorisation étude/série, rate-limit (≥20 → 429), audit appelé, PNG invalide → 400, fail-closed si rendu échoue.
- Vérif live finale (Playwright) : composer + envoyer, confirmer réception PDF + MP4.

## 10. Hors-périmètre (non-goals)

Diagnostic/brouillon **IA** (sous-système A — spec suivant) · vidéo embarquée **dans** le PDF (RichMedia) · planche-contact PDF · **mot de passe** PDF · envoi **au patient** · Orthanc/PACS · modifications du MPR · export en **job asynchrone** (évolution v2 si l'export synchrone est trop lent).
