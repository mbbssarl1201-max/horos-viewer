# MediView — Matrice de conformité CE/MDR (préliminaire)

> **Statut : DOCUMENT DE TRAVAIL / ANALYSE D'ÉCART.** Ce document n'est PAS une
> déclaration de conformité ni un marquage CE. MediView, en l'état, n'est pas un
> dispositif médical certifié. Le marquage CE sous le règlement (UE) 2017/745
> (MDR) — ou l'enregistrement Swissmedic (ODim) en Suisse — exige un processus
> réglementaire complet (SMQ ISO 13485, gestion des risques ISO 14971,
> évaluation clinique, documentation technique, organisme notifié pour les
> classes ≥ IIa). Ce fichier sert de point de départ pour cet effort.

## 1. Destination (intended use) — à formaliser

MediView est un visualiseur d'images DICOM avec outils de mesure, reconstruction
MPR/3D, et aide IA à la rédaction de comptes rendus. **Question réglementaire
clé** : la destination revendiquée détermine la qualification et la classe.

- Si « visualisation/communication d'images sans intention diagnostique »
  → potentiellement hors champ DM ou classe I.
- Si « aide au diagnostic » (mesures cliniques, pré-analyse IA orientant une
  décision) → **logiciel dispositif médical**, vraisemblablement **classe IIa+**
  (règle 11 MDR), avec organisme notifié. **À trancher par un référent
  réglementaire** avant toute revendication clinique.

## 2. Matrice d'écart (exigences générales — extrait)

| Domaine (réf. MDR / normes)          | État actuel MediView                                                                                                      | Écart / à faire                                                     |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| SMQ (ISO 13485)                      | Aucun SMQ formel                                                                                                          | Mettre en place un SMQ                                              |
| Gestion des risques (ISO 14971)      | Garde-fous techniques (IA = brouillon, fail-safe, audit) ; pas d'analyse formelle                                         | Dossier d'analyse de risques                                        |
| Cycle de vie logiciel (IEC 62304)    | Versionné (git/PR), tests unitaires (~210), CI build                                                                      | Classer le niveau de sécurité, doc de développement formelle        |
| Aptitude à l'utilisation (IEC 62366) | UI proche d'Horos, libellés FR                                                                                            | Dossier d'ingénierie de l'aptitude                                  |
| Évaluation clinique                  | Aucune                                                                                                                    | Plan + rapport d'évaluation clinique                                |
| Cybersécurité (MDCG 2019-16)         | RBAC, anonymisation DICOM fail-closed, anti-SSRF AE Titles, audit, révocation session, secrets en .env, Ollama non exposé | Dossier cybersécurité, tests de pénétration                         |
| Données personnelles (nLPD/RGPD)     | PHI hors git ; on-premise = PHI sur LAN ; cloud = egress IA Claude **accepté par le responsable de traitement**           | DPA Anthropic / base légale à formaliser ; registre des traitements |
| Étiquetage / notice                  | `UTILISATION.md` (ébauche)                                                                                                | Notice d'utilisation conforme                                       |
| Traçabilité (UDI, surveillance)      | Journaux d'accès + export d'audit                                                                                         | Système UDI, surveillance après commercialisation                   |

## 3. Mesures techniques déjà en place (à verser au dossier)

- **Sécurité** : RBAC en couches, `strictAdminProcedure` sur les actions
  destructives/audit, anonymisation DICOM **fail-closed**, validation anti-SSRF
  des AE Titles, validation des payloads (zod, ex. annotations bornées),
  journal d'accès + **export d'audit**, **rétention** configurable.
- **IA encadrée** : pré-analyse = **brouillon non signé**, jamais d'écriture
  autonome ; bandeau d'avertissement ; choix backend local (Ollama, PHI-safe) vs
  cloud (Claude, egress assumé).
- **Robustesse** : ~210 tests unitaires, CI (build/typecheck), déploiements
  versionnés, revue de sécurité automatique des commits, healthcheck `/healthz`.
- **Mesures** : calibrées via PixelSpacing (repli ImagerPixelSpacing pour CR/DX).

## 4. Risques résiduels notables (extrait — à formaliser en ISO 14971)

- **Hallucination IA** : un VLM généraliste peut rater/inventer (ex. fracture).
  Mitigation : brouillon obligatoirement validé+signé par un médecin.
- **Calibration des mesures** : dépend des métadonnées DICOM ; un examen sans
  PixelSpacing/ImagerPixelSpacing afficherait des pixels — à signaler.
- **Egress PHI (cloud)** : en mode Claude, des images quittent le périmètre.
  Mitigation : mode on-premise + Ollama local pour usage clinique réel.

## 5. Recommandation

Avant tout usage **diagnostique** revendiqué : faire qualifier la destination par
un référent affaires réglementaires, puis engager le dossier MDR (SMQ, risques,
évaluation clinique). Pour un usage **non diagnostique** (visualisation,
second avis non contraignant, recherche/démonstration), documenter clairement
cette limitation dans la notice et l'UI (déjà fait : bandeaux « à valider »).
