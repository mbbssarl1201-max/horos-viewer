#!/usr/bin/env bash
# Crée le dépôt GitHub PRIVÉ et pousse la branche security-hardening.
# À lancer APRÈS `gh auth login`.
set -e
cd "$(dirname "$0")"
gh repo create horos-viewer \
  --private \
  --source=. \
  --remote=origin \
  --description "Horos DICOM viewer (full-stack) — security-hardened" \
  --push
echo ""
echo "✅ Dépôt privé créé et poussé :"
gh repo view --json url -q .url
