# MediView ON-PREMISE — Installation sur iMac (Apple Silicon)

Variante macOS du déploiement on-premise. Tout reste sur le Mac / le réseau du
cabinet. L'IA d'analyse tourne **nativement** sur le GPU Apple (Ollama), le reste
de la stack tourne dans **Colima** (moteur Docker open-source, sans Docker Desktop).

> Pour un serveur Linux + GPU NVIDIA, voir `README.md` à la place.

```
  Navigateur (ce Mac / postes LAN) ──HTTPS──▶ Caddy ─▶ app ─┬─▶ MySQL
                                                            ├─▶ MinIO
                                                            ├─▶ Orthanc ─▶ dcm4chee (PACS)
                                                            └─▶ Ollama (NATIF sur le Mac, GPU Apple)
```

---

## 1. Prérequis (à faire une fois, demandent le mot de passe Mac)

```bash
# Outils de compilation Apple
xcode-select --install

# Homebrew (gestionnaire de paquets)
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

> Sous Claude Code : lance ces deux commandes en les préfixant de `!` (elles
> demandent ton mot de passe, que l'assistant ne peut pas saisir).

RAM : **16 Go suffisent** (le script choisit alors le modèle `qwen2.5vl:3b`).
Avec **24 Go+**, il prend `qwen2.5vl:7b` (meilleure qualité).

---

## 2. Installation (automatique)

```bash
cd deploy/on-premise
./setup-mac.sh
```

Le script : installe Colima + docker + ollama (via brew), démarre le moteur
Docker (Colima en mode `vz` + **Rosetta** → l'image amd64 tourne vite sur Apple
Silicon), configure et lance Ollama (GPU Apple), télécharge le modèle, génère les
secrets, puis démarre toute la stack.

---

## 3. Accès

1. Ajouter le nom d'hôte local (sudo) :
   ```bash
   echo "127.0.0.1  mediview.cabinet.local" | sudo tee -a /etc/hosts
   ```
2. Ouvrir **https://mediview.cabinet.local** (certificat CA interne Caddy →
   accepter l'exception, ou installer la CA : voir `README.md` §4).
3. **Créer le 1er compte** → il devient automatiquement **administrateur**.

Depuis les autres postes du cabinet : remplacer `127.0.0.1` par l'IP LAN du Mac
dans leur fichier `hosts`, et faire confiance à la CA Caddy.

---

## 4. PACS (quand l'iMac est sur le réseau du cabinet)

- Brancher l'iMac sur le **réseau du cabinet** (idéalement Ethernet) — il doit
  joindre le dcm4chee `192.168.1.180:11112`.
- Côté **dcm4chee**, déclarer la destination C-MOVE :
  AE Title `MEDIVIEW`, hôte = **IP LAN de l'iMac**, port **4242**.
- Dans MediView (menu PACS) : rechercher → récupérer → ouvrir une étude.

Vérifier la liaison : `docker compose -f docker-compose.mac.yml logs orthanc`

---

## 5. Exploitation

```bash
# État
docker compose -f docker-compose.mac.yml ps
# Logs app
docker compose -f docker-compose.mac.yml logs -f app
# Arrêt / démarrage
docker compose -f docker-compose.mac.yml down
docker compose -f docker-compose.mac.yml up -d
# Sauvegarde (MySQL + MinIO)
./backup.sh
```

**Démarrage automatique au boot** : Colima ne démarre pas seul. Pour un serveur
permanent, activer `colima start` au login (Éléments de connexion macOS) ou créer
un LaunchAgent. Désactiver la **mise en veille** de l'iMac (Réglages > Batterie /
Économie d'énergie) pour qu'il reste joignable.

---

## 6. Sécurité / conformité (nLPD, secret médical)

- **Aucune donnée patient ne sort du Mac** : IA locale (Ollama natif), stockage
  local (MinIO/MySQL), PACS sur le LAN. `AI_BACKEND=ollama` imposé.
- Activer **FileVault** (chiffrement du disque) sur l'iMac — il contient du PHI.
- Ollama écoute sur `0.0.0.0:11434` (nécessaire pour le conteneur) → garder le
  **pare-feu macOS activé** ; sur un LAN cabinet fermé, risque faible.
- Secrets dans `.env` (chmod 600, gitignoré).

---

## 7. Dépannage

| Symptôme                           | Piste                                                                                                                 |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `docker` ne répond pas             | `colima start` (le moteur n'était pas lancé).                                                                         |
| app très lente au 1er lancement    | émulation amd64 qui chauffe + 1er pull ; ça se stabilise.                                                             |
| IA renvoie une erreur              | Ollama joignable ? `curl http://localhost:11434/api/tags`. Modèle tiré ? `ollama list`.                               |
| IA lente                           | RAM limitée → rester en `qwen2.5vl:3b`. Vérifier que c'est bien Apple Silicon.                                        |
| `host.docker.internal` injoignable | Ollama doit écouter sur `0.0.0.0` : `launchctl setenv OLLAMA_HOST 0.0.0.0:11434` puis `brew services restart ollama`. |
| Recherche PACS vide                | iMac pas encore sur le réseau du cabinet, ou destination `MEDIVIEW` non déclarée côté dcm4chee.                       |
