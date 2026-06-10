#!/usr/bin/env bash
# MediView on-premise — installation macOS (Apple Silicon).
# Prépare le moteur Docker (Colima open-source), l'IA locale (Ollama natif, GPU
# Apple), génère les secrets et démarre la stack. Idempotent.
#
# Prérequis À FAIRE PAR L'UTILISATEUR AVANT (demandent le mot de passe macOS) :
#   1) Outils Xcode :   xcode-select --install
#   2) Homebrew :       /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
# Le reste est automatique.
set -euo pipefail
cd "$(dirname "$0")"

say() { printf "\033[1;36m→ %s\033[0m\n" "$1"; }
ok()  { printf "\033[1;32m  ✓ %s\033[0m\n" "$1"; }
die() { printf "\033[1;31m✗ %s\033[0m\n" "$1" >&2; exit 1; }

[[ "$(uname -s)" == "Darwin" ]] || die "Ce script est pour macOS. Sur Linux, utiliser setup.sh."
[[ "$(uname -m)" == "arm64" ]] || say "ATTENTION : Mac Intel détecté — l'IA locale sera lente (pas de GPU exploitable)."

command -v brew >/dev/null || die "Homebrew absent. Installe-le d'abord (voir en-tête du script)."

# ── 1. Outils : Colima + client Docker + Compose + Ollama ────────────────────
say "Vérification des outils (Colima, docker, docker-compose, ollama)…"
need_brew=()
command -v colima  >/dev/null || need_brew+=(colima)
command -v docker  >/dev/null || need_brew+=(docker)
docker compose version >/dev/null 2>&1 || need_brew+=(docker-compose)
command -v ollama  >/dev/null || need_brew+=(ollama)
if (( ${#need_brew[@]} )); then
  say "Installation via Homebrew : ${need_brew[*]}"
  brew install "${need_brew[@]}"
fi
ok "Outils présents"

# ── 2. Dimensionnement selon la RAM ──────────────────────────────────────────
MEM_GB=$(( $(sysctl -n hw.memsize) / 1024 / 1024 / 1024 ))
if (( MEM_GB >= 24 )); then
  COLIMA_MEM=10; DEFAULT_MODEL="qwen2.5vl:7b"
else
  COLIMA_MEM=8;  DEFAULT_MODEL="qwen2.5vl:3b"   # 16 Go : modèle réduit pour tenir
fi
COLIMA_CPU=$(( $(sysctl -n hw.ncpu) > 6 ? 4 : 2 ))
OLLAMA_VISION_MODEL="${OLLAMA_VISION_MODEL:-$DEFAULT_MODEL}"
say "RAM ${MEM_GB} Go → Colima ${COLIMA_MEM} Go / ${COLIMA_CPU} vCPU, modèle IA ${OLLAMA_VISION_MODEL}"

# ── 3. Démarrage de Colima (VZ + Rosetta = émulation amd64 rapide) ───────────
if colima status >/dev/null 2>&1; then
  ok "Colima déjà démarré"
else
  say "Démarrage de Colima (vz + rosetta pour l'image amd64)…"
  colima start --vm-type vz --vz-rosetta --cpu "$COLIMA_CPU" --memory "$COLIMA_MEM" --disk 100
fi
docker info >/dev/null 2>&1 || die "Le client docker ne joint pas Colima. Relance : colima start"
ok "Moteur Docker prêt"

# ── 4. Ollama natif : écoute sur 0.0.0.0 (joignable par le conteneur) + modèle ─
say "Configuration d'Ollama (natif, GPU Apple)…"
launchctl setenv OLLAMA_HOST "0.0.0.0:11434" 2>/dev/null || true
# (Re)démarrer le service ollama pour prendre OLLAMA_HOST en compte.
brew services restart ollama >/dev/null 2>&1 || { OLLAMA_HOST=0.0.0.0:11434 nohup ollama serve >/tmp/ollama.log 2>&1 & sleep 3; }
for i in $(seq 1 20); do curl -sf http://127.0.0.1:11434/api/tags >/dev/null && break || sleep 1; done
say "Téléchargement du modèle ${OLLAMA_VISION_MODEL} (long la 1re fois)…"
ollama pull "$OLLAMA_VISION_MODEL"
ok "IA locale prête"

# ── 5. Secrets + config (réutilise la logique de setup.sh) ───────────────────
if [[ -f .env ]]; then
  ok ".env existant conservé"
else
  say "Génération des secrets (.env) + config Orthanc…"
  OLLAMA_VISION_MODEL="$OLLAMA_VISION_MODEL" ./setup.sh >/dev/null
  ok ".env + orthanc/orthanc.json générés"
fi
# Forcer le modèle calculé dans le .env (au cas où setup.sh a mis le défaut).
if grep -q '^OLLAMA_VISION_MODEL=' .env; then
  /usr/bin/sed -i '' "s|^OLLAMA_VISION_MODEL=.*|OLLAMA_VISION_MODEL=${OLLAMA_VISION_MODEL}|" .env
fi

# ── 6. Démarrage de la stack ─────────────────────────────────────────────────
say "Pull des images + démarrage…"
docker compose -f docker-compose.mac.yml pull
docker compose -f docker-compose.mac.yml up -d

HOST=$(grep '^MEDIVIEW_HOSTNAME=' .env | cut -d= -f2)
echo
ok "MediView démarré."
echo "   • Ajoute '127.0.0.1  ${HOST}' à /etc/hosts (sudo), puis ouvre https://${HOST}"
echo "   • 1er compte créé = administrateur."
echo "   • PACS : quand l'iMac est sur le réseau du cabinet, configure la destination"
echo "     C-MOVE 'MEDIVIEW' @ IP-du-Mac:4242 côté dcm4chee (voir README-macos.md §PACS)."
