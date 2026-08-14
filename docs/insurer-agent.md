# Agent SUVA — runbook de mise en production

Spec : `docs/superpowers/specs/2026-08-13-agent-suva-design.md`. Ce document
couvre uniquement la mise en prod : création de la boîte, variables d'env,
migration, déploiement, vérifications post-deploy, test E2E et révocation.

## Fonctionnement (rappel)

Un poller IMAP (`server/insurer/mailPoller.ts`, intervalle 2 min, no-op tant
que `INSURER_IMAP_HOST` est vide) lit la boîte dédiée. Chaque mail est
enregistré (`insurer_requests`, idempotent par `Message-ID`), puis passe le
pipeline : extraction (texte + pièces jointes via le LLM/vision configuré par
`INFOMANIAK_VISION_URL/KEY/MODEL` — depuis le 13.08.2026, en prod ces variables
pointent vers le sidecar `gemini-vision` du VPS72, `http://gemini-vision:11437/v1/chat/completions`,
qui proxifie **Gemini 2.5 Pro sur Vertex AI en régions UE** avec failover
europe-west4→west1→west9 ; l'API Infomaniak d'origine est morte. Jamais un
fournisseur US. Renommage des variables en `VISION_API_*` = dette à traiter)
→ identification patient multi-critère (jamais la DDN seule)
→ recherche des études → colisage (CR PDF + ZIP DICOM sur lien à jeton,
`insurer_bundle_tokens`, haché, expirable, révocable). Le contenu des mails
entrants est traité comme non fiable (parsing pur, jamais d'instructions
exécutées).

L'envoi est **automatique** seulement si les 4 conditions sont TOUTES
réunies (sinon statut `a_valider` + notification au gérant + validation
1 clic sur `/demandes-assureurs`) :

1. expéditeur du mail entrant dans `INSURER_TRUSTED_SENDERS` ;
2. patient identifié de façon unique et exacte (nom + prénom + DDN) ;
3. toutes les études demandées trouvées, à date exacte ;
4. adresse de réponse dans un domaine de `INSURER_AUTO_SEND_DOMAINS`
   (`suva.ch`).

Tout envoi (auto ou validé) passe par la garde d'egress
`isAllowedPhiRecipientStrict` (fail-closed) : le destinataire doit être une
adresse UNIQUE (pas de liste séparée par virgule/point-virgule, pas de forme
d'affichage `Nom <a@b.ch>` — cf. audit C1) et être dans
`REPORT_EMAIL_ALLOWED_DOMAINS`, sans quoi l'envoi est bloqué même si les 4
conditions ci-dessus sont remplies. `INSURER_AUTO_SEND_DOMAINS` DOIT donc
toujours être un sous-ensemble de `REPORT_EMAIL_ALLOWED_DOMAINS` — le poller
avertit au démarrage (`console.warn`) si ce n'est pas le cas.

`extraction.adresseReponse` (lue par le LLM dans le corps du mail entrant,
donc non fiable) est normalisée dès l'ingestion (`normaliserAdresseUnique`,
`server/insurer/adresseUnique.ts`) : si elle n'est pas une adresse unique
plausible (smuggling, liste, forme d'affichage…), elle est rejetée — motif
« Adresse de réponse invalide ou multiple » posé, repli sur l'adresse
Reply-To/From du mail (elle-même normalisée), envoi automatique impossible.

### Limites de confiance

L'envoi automatique fait confiance au champ `From` du mail entrant — non
authentifié à ce stade (pas de vérification DKIM/SPF/DMARC applicative).
Les garde-fous actuels sont : les 4 conditions ci-dessus (dont l'expéditeur
dans `INSURER_TRUSTED_SENDERS`) + le fait que la boîte IMAP soit dédiée à cet
usage (surface d'attaque réduite au flux assureur). Durcissement futur
envisagé : vérifier l'en-tête `Authentication-Results` posé par Mailu avant
d'accepter la condition 1 (expéditeur de confiance), pour ne plus se fier au
seul `From` déclaratif.

## 1. Créer la boîte mail dédiée (Mailu, VPS72)

**État courant (2026-08-14)** : la boîte est **`suva@mediview.ch`**. L'option
initiale `suva@mediadmin.ch` (déployée le 13.08) est morte le lendemain :
**le domaine mediadmin.ch a expiré et a été supprimé du registre nic.ch** —
plus aucun mail ne pouvait y être livré. Bascule effectuée :

1. Domaine `mediview.ch` ajouté à Mailu (`flask mailu domain mediview.ch`)
   - boîte `suva@mediview.ch` (`flask mailu user suva mediview.ch <mdp>` ;
     mot de passe : `/root/mediview-suva-imap-pass.txt` sur le 72, et `.env`).
2. DNS Hostinger de `mediview.ch` : `mail` A → 72.62.26.49, MX
   `10 mail.mediview.ch`, SPF `TXT v=spf1 a mx ip4:72.62.26.49 ~all`.
   (Reste à poser : DKIM `dkim._domainkey` via l'admin Mailu + DMARC.)
3. Greylisting rspamd actif : le premier mail d'un expéditeur inconnu est
   retardé de ~1 minute (451 « Try again later ») — les vrais MTA réessaient.
4. Le poller exige un `Message-ID` (idempotence) — les mails de vrais clients
   en ont toujours un.

Noter le mot de passe (gestionnaire de secrets, jamais dans un `.md`
versionné — cf. règle globale secrets), et vérifier la connexion IMAP avant
d'activer le poller.

## 2. Variables d'environnement (`/opt/medical/mediview/.env`)

À ajouter/mettre à jour :

```
INSURER_IMAP_HOST=mailu-imap-1           # Dovecot interne Mailu (réseau mailu_default)
INSURER_IMAP_PORT=143               # Dovecot interne en clair (993/TLS seulement via le front public)
INSURER_IMAP_USER=suva@mediview.ch
INSURER_IMAP_PASS=<mot de passe fort>
INSURER_TRUSTED_SENDERS=institut.med.champel@gmail.com
INSURER_AUTO_SEND_DOMAINS=suva.ch
INSURER_NOTIFY_EMAIL=institut.med.champel@gmail.com
REPORT_EMAIL_ALLOWED_DOMAINS=gmail.com,suva.ch
# Destination unique forcée (décision gérant 2026-08-14) : toutes les réponses
# partent à cette adresse, l'adresse lue dans le courrier est ignorée.
# Retirer la variable pour revenir à la précédence extraite → Reply-To/From.
INSURER_REPLY_TO=suva.ouest@suva.ch
```

`REPORT_EMAIL_ALLOWED_DOMAINS` est actuellement `gmail.com` en prod : il
faut y **ajouter** `suva.ch` (ne pas le remplacer, l'envoi des CR existants
vers `gmail.com` doit continuer à fonctionner). Si le cabinet transfère
depuis d'autres adresses que `institut.med.champel@gmail.com`, les ajouter à
`INSURER_TRUSTED_SENDERS` (séparateur `,`).

`INSURER_IMAP_MAILBOX` (défaut `INBOX`) n'a pas besoin d'être posée sauf cas
particulier.

Ne pas activer `INSURER_IMAP_HOST` avant d'avoir vérifié la connexion IMAP
(étape 1) : tant qu'il est absent, le poller reste no-op (aucun risque).

## 3. Migration SQL manuelle

Fichier : `drizzle/0020_gorgeous_blizzard.sql` (2 `CREATE TABLE` :
`insurer_requests`, `insurer_bundle_tokens`). `__drizzle_migrations` n'est
pas fiable sur cette instance (migrations passées appliquées à la main) —
toujours vérifier l'absence préalable des tables avant d'exécuter :

```sh
docker exec -it mysql-medical mysql -uroot -p horos \
  -e "SHOW TABLES LIKE 'insurer%';"
# doit renvoyer un résultat vide
docker exec -i mysql-medical mysql -uroot -p horos < drizzle/0020_gorgeous_blizzard.sql
docker exec -it mysql-medical mysql -uroot -p horos \
  -e "SHOW TABLES LIKE 'insurer%';"
# doit renvoyer insurer_bundle_tokens + insurer_requests
```

## 4. Déploiement

Procédure standard MediView (build Mac → tgz → VPS76 → VPS72,
`/opt/medical/mediview` = dossier d'artefacts, PAS un checkout git) :

1. `pnpm build` sur le Mac (gate déjà vérifiée : `pnpm vitest run`,
   `pnpm check` et `pnpm build` tout vert — voir rapport Task 10).
2. `COPYFILE_DISABLE=1 tar czf /tmp/mediview-deploy.tgz --exclude='._*' dist drizzle patches package.json pnpm-lock.yaml drizzle.config.ts tsconfig.json`
3. `scp` Mac → VPS76 → `root@72.62.26.49:/tmp/` (pas d'accès SSH direct
   Mac→72), contrôler le `sha256sum` aux deux bouts.
4. Sur le 72, dans `/opt/medical/mediview` : sauvegarder
   `cp -a dist dist.bak-<date>` + `docker tag horos-viewer:depot
horos-viewer:rollback-<date>`, extraire le tgz, `find . -name '._*' -delete`.
5. Appliquer la migration (étape 3 ci-dessus) **avant** de redémarrer le
   conteneur applicatif.
6. `docker build -f Dockerfile.prebuilt -t horos-viewer:depot . && docker compose up -d --force-recreate mediview`.

**Rollback** : `docker tag horos-viewer:rollback-<date> horos-viewer:depot &&
docker compose up -d mediview` (+ restaurer `dist.bak-<date>` si rebuild
nécessaire).

## 5. Vérifications post-déploiement

Pings habituels :

- `/healthz` → 200
- `/login` et `/` → 200
- `/api/export/pdf-report/1` et `/storage/x` sans session → 401
- `/r/bogus` → 410

`docker logs mediview-app` : chercher la ligne positive de démarrage
(`grep "poller IMAP démarré"`) :

```
[insurer] poller IMAP démarré (intervalle 2 min, boîte INBOX)
```

Si elle est absente : soit `INSURER_IMAP_HOST` est resté vide côté conteneur
(vérifier que le `.env` a bien été relu — `--force-recreate`, pas juste
`restart` — auquel cas on voit plutôt `[insurer] poller IMAP désactivé
(INSURER_IMAP_HOST absent)`), soit le poller n'a pas encore atteint cette
ligne de code (erreur avant, peu probable). Vérifier aussi l'absence d'un
`console.warn` `INSURER_AUTO_SEND_DOMAINS contient des domaines absents de
REPORT_EMAIL_ALLOWED_DOMAINS` juste avant (cf. section 2 — sinon l'envoi
automatique échouera toujours pour ces domaines).

Ensuite, laisser passer un cycle (~2 min) et vérifier l'absence d'erreurs
`[insurer] passe boîte échouée` / `[insurer] passe échouée` dans les logs,
ce qui confirme une connexion IMAP correcte.

## 6. Test end-to-end (patient fictif)

1. Transférer un mail au format SUVA réel (texte + pièce jointe si possible)
   vers la boîte dédiée, en utilisant un **patient fictif** existant dans
   MediView (jamais un vrai dossier patient pour un test).
2. Suivre `docker logs -f mediview-app` : la demande doit apparaître en base
   (`recue` → `extraite` → `identifiee`/`a_valider` selon le matching).
3. Aller sur `/demandes-assureurs` : la demande doit apparaître avec le
   statut, l'extraction lue, le patient identifié et les études trouvées.
4. Si `a_valider` : vérifier l'email de notification reçu à
   `INSURER_NOTIFY_EMAIL`, puis valider manuellement sur la page.
5. Vérifier la réception du mail de réponse (CR PDF + lien de
   téléchargement), et que le lien `/dl/...` fonctionne (téléchargement du
   ZIP DICOM).
6. Nettoyage : révoquer le lien (étape 7) après le test.

## 7. Révoquer un lien de téléchargement

Sur `/demandes-assureurs`, ouvrir la demande concernée puis cliquer
« Révoquer le lien » (bouton désactivé s'il n'y a aucun jeton actif ; une
confirmation est demandée). Le jeton est marqué révoqué en base
(`revoqueLe`) : toute tentative de téléchargement ultérieure renvoie 410,
sans possibilité de le réactiver — en cas de besoin, renvoyer un nouveau
colis depuis la même page (`resend`).

### Sémantique réelle du lien `/dl/:token` (I2)

Contrairement au lien `/r/:token` (compte-rendu, usage UNIQUE), le lien de
téléchargement du colis assureur est **multi-téléchargement** pendant sa
fenêtre de validité — décision assumée : l'assureur peut avoir besoin de
retélécharger le colis (échec réseau, changement de poste…) sans repasser
par le cabinet. Bornes :

- **Expiration** : 14 jours après l'émission (`creerJeton`).
- **Plafond** : 10 téléchargements maximum sur la durée de vie du jeton ;
  au-delà, le lien renvoie 410 comme s'il était expiré.
- **Révocable** à tout moment (bouton « Révoquer le lien » ci-dessus),
  sans possibilité de réactivation.
- Le message 410 du lien assureur (« Lien expiré ou révoqué. ») est
  volontairement distinct de celui du lien CR `/r/:token` (« Lien expiré ou
  déjà utilisé. ») pour ne pas laisser croire qu'un seul téléchargement
  suffit à l'invalider.
