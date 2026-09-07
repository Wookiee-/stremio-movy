#!/usr/bin/env bash
set -euo pipefail

# setup-docker.sh - Docker for movy addon only (no nginx in Docker)
# Host nginx handles proxy + TLS: nginx/movy.conf -> 127.0.0.1:7000
#
# Usage:
#   chmod +x setup-docker.sh
#   ./setup-docker.sh                    # build + start movy container only
#   sudo ./setup-docker.sh --with-nginx  # also install host nginx + certbot (calls setup-nginx.sh)
#
# Prereqs on Ubuntu: docker + docker compose plugin
#   sudo apt update && sudo apt install -y docker.io docker-compose-plugin
#   sudo systemctl enable --now docker

WITH_NGINX=false
DOMAIN="movy.ddns.net"
EMAIL=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --with-nginx) WITH_NGINX=true; shift;;
    --domain) DOMAIN="$2"; shift 2;;
    --email) EMAIL="$2"; shift 2;;
    -h|--help)
      echo "Usage: $0 [--with-nginx] [--domain DOMAIN] [--email EMAIL]"
      echo "  Default: start movy container only. Use --with-nginx to also setup host nginx+certbot."
      exit 0
      ;;
    *) echo "Unknown option: $1" >&2; exit 1;;
  esac
done

if ! command -v docker >/dev/null 2>&1; then
  echo "[*] Installing docker..."
  sudo apt update
  sudo apt install -y docker.io docker-compose-plugin
  sudo systemctl enable --now docker
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "[!] docker compose plugin not found" >&2
  exit 1
fi

echo "[*] Building + starting movy (Docker) on 127.0.0.1:7000..."
docker compose build movy
docker compose up -d movy
docker compose ps
echo ""
echo "[✓] Movy running: curl -i http://127.0.0.1:7000/manifest.json"
echo "    Logs: docker compose logs -f movy"
echo "    Restart: docker compose restart movy"
echo "    Stop: docker compose down"

if [[ "$WITH_NGINX" == true ]]; then
  if [[ -z "$EMAIL" ]]; then
    echo ""
    echo "[!] --email required for --with-nginx (e.g. --email you@example.com)"
    exit 1
  fi
  echo ""
  echo "[*] Setting up host nginx + certbot for ${DOMAIN}..."
  sudo ./setup-nginx.sh --domain "$DOMAIN" --email "$EMAIL"
else
  echo ""
  echo "Host nginx setup (if not already done):"
  echo "  sudo cp nginx/movy.conf /etc/nginx/sites-available/${DOMAIN}"
  echo "  sudo ln -sf /etc/nginx/sites-available/${DOMAIN} /etc/nginx/sites-enabled/"
  echo "  sudo nginx -t && sudo systemctl reload nginx"
  echo "  sudo certbot --nginx -d ${DOMAIN} --email you@example.com --agree-tos --redirect"
  echo "  curl -i https://${DOMAIN}/manifest.json"
fi
