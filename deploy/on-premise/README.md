# MediView — Installation ON-PREMISE (cabinet)

Déploiement auto-hébergé sur une machine dédiée du cabinet. **Toutes les données
patients restent sur le réseau local** : stockage, base, IA d'analyse — rien ne
sort vers Internet. Le seul flux externe possible est l'envoi facultatif d'un
compte rendu par email au confrère (à activer explicitement).

```
   Postes du cabinet ──HTTPS(LAN)──▶ Caddy ──▶ app ──┬─▶ MySQL (dossiers/comptes)
                                                      ├─▶ MinIO (DICOM, captures)
                                                      ├─▶ Ollama (IA vision, LOCAL)
                                                      └─▶ Orthanc ──DIMSE/DICOMweb──▶ dcm4chee (PACS cabinet)
```

---

## 1. Prérequis machine

| Élément | Minimum                      | Recommandé                                                                         |
| ------- | ---------------------------- | ---------------------------------------------------------------------------------- |
| OS      | Linux (Ubuntu/Debian server) | idem, à jour                                                                       |
| Docker  | Docker Engine + Compose v2   | idem                                                                               |
| RAM     | 16 Go                        | 32 Go                                                                              |
| Disque  | 500 Go SSD                   | ≥ 1 To SSD (séries CT ~150 Mo pièce)                                               |
| **GPU** | — (CPU possible mais lent)   | **NVIDIA ~16 Go VRAM** (ex. RTX 4060 Ti 16 Go / 4070) + `nvidia-container-toolkit` |

> **Pourquoi le GPU ?** L'analyse IA tourne en local. Sur CPU : ~1–2 min/analyse
> et modèle réduit (qualité faible). Sur GPU : quelques secondes + modèle
> `qwen2.5vl:7b` (qualité proche de Claude, sans cloud).
> **Sans GPU** : dans `docker-compose.yml`, commenter le bloc `deploy:` du
> service `ollama`, et mettre `OLLAMA_VISION_MODEL=qwen2.5vl:3b` dans `.env`.

Vérifier le GPU (si présent) : `docker run --rm --gpus all nvidia/cuda:12.4.0-base-ubuntu22.04 nvidia-smi`

---

## 2. Réseau & PACS

- La machine doit être sur le **même LAN** que le PACS `dcm4chee`
  (`192.168.1.180:11112`, déjà validé en C-ECHO/C-FIND).
- Sur le **dcm4chee**, déclarer Orthanc comme destination C-MOVE :
  - **AE Title** : `MEDIVIEW`
  - **Hôte** : l'IP LAN de cette machine
  - **Port** : `4242`
  - (dcm4chee accepte tout AE appelant ici, donc aucune autre autorisation requise.)
- Donner à la machine une **IP fixe** sur le LAN.

---

## 3. Installation

```bash
# Récupérer ce dossier sur la machine (deploy/on-premise) puis :
cd deploy/on-premise

# (Optionnel) adapter les coordonnées PACS / le modèle avant génération :
#   export DCM4CHEE_HOST=192.168.1.180 OLLAMA_VISION_MODEL=qwen2.5vl:7b
./setup.sh                       # génère .env (secrets) + orthanc/orthanc.json

# Authentification au registre d'images (lecture seule) :
docker login ghcr.io             # user GitHub + token PAT scope read:packages

docker compose pull
docker compose up -d

# Télécharger le modèle IA (une seule fois ; long la 1re fois) :
docker compose exec ollama ollama pull qwen2.5vl:7b   # ou :3b en CPU
```

Vérifier : `docker compose ps` → tous `Up` (sauf `migrate`/`createbucket` en
`Exited 0`, c'est normal, ce sont des one-shots).

> **Image privée ?** Si le pull GHCR est refusé, c'est que le paquet est privé :
> créer un PAT GitHub (`read:packages`) et refaire `docker login ghcr.io`.
> Alternative : construire l'image sur place avec `docker build` depuis les
> sources du dépôt (voir le `Dockerfile` à la racine).

---

## 4. Accès clinique & HTTPS interne

1. Faire résoudre `mediview.cabinet.local` (valeur `MEDIVIEW_HOSTNAME`) vers l'IP
   LAN de la machine — via le DNS local du cabinet, **ou** le fichier `hosts` de
   chaque poste :
   - Windows : `C:\Windows\System32\drivers\etc\hosts`
   - macOS/Linux : `/etc/hosts`
   ```
   192.168.1.50   mediview.cabinet.local
   ```
2. Ouvrir `https://mediview.cabinet.local`. Caddy sert un certificat signé par sa
   **CA interne**. Pour supprimer l'avertissement du navigateur, installer la CA
   racine de Caddy comme approuvée sur les postes :
   ```bash
   docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt ./mediview-root-CA.crt
   ```
   Importer `mediview-root-CA.crt` dans le magasin « Autorités de certification
   racine de confiance » des postes (ou accepter l'exception, LAN uniquement).

---

## 5. Premier compte (médecin/admin)

Le **premier compte enregistré devient administrateur** (mode `local`).

1. Sur `https://mediview.cabinet.local`, page d'inscription → créer le compte du
   médecin responsable. Il obtient le rôle `admin`.
2. Créer ensuite les comptes du personnel (rôles standards).
3. **Sécurité** : sur LAN privé, l'inscription reste ouverte ; si le réseau est
   partagé, demander à fermer l'inscription après création des comptes (option à
   activer côté app / ou filtrage réseau).

---

## 6. Utilisation : du PACS au compte rendu

1. **Configurer le PACS dans l'app** (menu PACS) : Orthanc est déjà câblé sur le
   dcm4chee ; l'app interroge via `orthanc.queryStudies` / C-FIND.
2. **Rechercher** une étude (nom patient / date / accession) → **récupérer**
   (C-MOVE : dcm4chee renvoie les images à Orthanc) → **ouvrir** dans le viewer.
3. Mesures (mm/HU calibrés), MPR/3D, captures d'images clés.
4. **Compte rendu** : génération automatique (IA locale) + relecture par le
   médecin → PDF, et envoi facultatif au confrère par email.

---

## 7. Sauvegardes

```bash
./backup.sh          # dump MySQL + miroir MinIO dans ./backups/<horodatage>
```

Planifier en cron (ex. quotidien) et **copier les sauvegardes sur un support
chiffré hors-machine** (NAS interne / disque chiffré). Les sauvegardes
contiennent des données patients → rester dans le périmètre de confiance, jamais
dans un cloud en clair.

---

## 8. Mises à jour

```bash
# Mettre à jour l'image (épingler un SHA dans .env = MEDIVIEW_IMAGE_TAG, conseillé) :
docker compose pull app migrate
docker compose up -d            # migrate rejoue les migrations DB au besoin
```

---

## 9. Sécurité & conformité (nLPD / secret médical)

- **Aucune donnée patient ne sort** : IA locale (Ollama), stockage local
  (MinIO/MySQL), PACS sur le LAN. `AI_BACKEND=ollama` est imposé par ce compose.
- Secrets dans `.env` (chmod 600, gitignoré). DICOM servi via proxy authentifié,
  jamais d'URL présignée exposée au navigateur.
- Orthanc REST/DICOMweb n'est **pas** publié sur le LAN (réseau Docker interne) ;
  seul le port DICOM 4242 est exposé (pour le C-MOVE entrant du dcm4chee).
- Disque hôte **chiffré** recommandé (les volumes Docker contiennent du PHI).

---

## 10. Dépannage

| Symptôme             | Piste                                                                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `app` ne démarre pas | `docker compose logs app` ; vérifier `JWT_SECRET` ≥ 32, `DATABASE_URL`.                                                                                      |
| Recherche PACS vide  | `docker compose logs orthanc` ; tester `docker compose exec orthanc /bin/sh -c "curl -u $ORTHANC_USER:*** localhost:8042/modalities/dcm4chee/echo -X POST"`. |
| C-MOVE échoue        | Le dcm4chee connaît-il `MEDIVIEW` @ IP:4242 ? Port 4242 publié et joignable ?                                                                                |
| IA très lente        | GPU absent/non vu : `docker compose exec ollama nvidia-smi`. Sinon passer en `qwen2.5vl:3b`.                                                                 |
| Avertissement HTTPS  | Installer la CA racine Caddy (§4) ou accepter l'exception.                                                                                                   |
| Mesures en pixels    | Radio sans PixelSpacing : géré par le repli ImagerPixelSpacing (déjà inclus).                                                                                |
