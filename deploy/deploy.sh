#!/usr/bin/env bash
# WORLDSMITH deploy — rsync site/ to Namecheap over SSH.
# Requires in ~/.hermes/.env (or environment):
#   NAMECHEAP_SSH_HOST, NAMECHEAP_SSH_PORT, NAMECHEAP_SFTP_USER, NAMECHEAP_SSH_KEY_PATH
# Usage: ./deploy/deploy.sh [--dry-run]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${HOME}/.hermes/.env"
[ -f "$ENV_FILE" ] && set -a && source "$ENV_FILE" && set +a

: "${NAMECHEAP_SSH_HOST:?NAMECHEAP_SSH_HOST not set}"
: "${NAMECHEAP_SSH_PORT:?NAMECHEAP_SSH_PORT not set}"
: "${NAMECHEAP_SFTP_USER:?NAMECHEAP_SFTP_USER not set}"
NAMECHEAP_SSH_KEY_PATH="${NAMECHEAP_SSH_KEY_PATH:-$HOME/.ssh/id_ed25519}"

# Remote folder under public_html — set once domain/subdomain is decided
REMOTE_PATH="${REMOTE_PATH:-public_html/worlds}"

DRY_RUN=""
[ "${1:-}" = "--dry-run" ] && DRY_RUN="--dry-run"

echo "==> Deploying ${SCRIPT_DIR}/../site/ to ${NAMECHEAP_SFTP_USER}@${NAMECHEAP_SSH_HOST}:${REMOTE_PATH}"
rsync -avz --delete ${DRY_RUN} \
  -e "ssh -p ${NAMECHEAP_SSH_PORT} -i ${NAMECHEAP_SSH_KEY_PATH}" \
  --exclude 'thumbs-raw/' \
  "${SCRIPT_DIR}/../site/" \
  "${NAMECHEAP_SFTP_USER}@${NAMECHEAP_SSH_HOST}:${REMOTE_PATH}/"

echo "==> Done. Verify over HTTPS once domain is pointed."
