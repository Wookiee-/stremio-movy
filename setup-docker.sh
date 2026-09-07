#!/usr/bin/env bash
set -euo pipefail

# setup-docker.sh - Docker version of nginx + certbot for movy.ddns.net
# No systemd service needed: movy runs as a container, nginx as a container, certbot as a container
#
# Usage:
#   chmod +x setup-docker.sh
#   sudo ./setup-docker.sh --email you@example.com                # full setup + TLS
#   sudo ./setup-docker.sh --email you@example.com --staging      # test with staging cert
#   sudo ./setup-docker.sh --no-certbot                           # HTTP only, no TLS
#
# Prereqs on Ubuntu: docker + docker compose plugin
#   sudo apt update && sudo apt install -y docker.io docker-compose-plugin
#   sudo systemctl enable --now docker

DOMAIN="movy.ddns.net"
EMAIL=""
STAGING=false
DO_CERTBOT=true

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2;;
    --email) EMAIL="$2"; shift 2;;
    --staging) STAGING=true; shift;;
    --no-certbot) DO_CERTBOT=false; shift;;
    -h|--help)
      echo "Usage: sudo $0 [--domain DOMAIN] [--email EMAIL] [--staging] [--no-certbot]"
      exit 0
      ;;
    *) echo "Unknown option: $1" >&2; exit 1;;
  esac
done

if [[ $EUID -ne 0 ]]; then
  echo "[!] Run as root: sudo $0 --email you@example.com" >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "[*] Installing docker..."
  apt update
  apt install -y docker.io docker-compose-plugin
  systemctl enable --now docker
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "[!] docker compose plugin not found" >&2
  exit 1
fi

echo "[*] Domain: $DOMAIN  Email: ${EMAIL:-<none>}  Staging: $STAGING  Certbot: $DO_CERTBOT"

# 1. Build and start movy + nginx (HTTP only at first)
echo "[*] Building movy image..."
docker compose build movy

echo "[*] Starting movy + nginx (HTTP)..."
# Temporarily hide the 443 block if certs don't exist yet so nginx can start
if [[ ! -f "/var/lib/docker/volumes/stremio-movy_certbot_certs/_data/live/${DOMAIN}/fullchain.pem" ]] && \
   [[ ! -d "./certbot_certs/live/${DOMAIN}" ]]; then
  echo "[*] No certs yet - starting with HTTP-only nginx config"
  # Create a temp HTTP-only config
  cp nginx/movy.conf nginx/movy.conf.bak
  # Comment out the 443 server block for the first boot
  awk 'BEGIN{p=1} /# --- HTTPS:/{p=0} p' nginx/movy.conf.bak > /tmp/movy-http-only.conf
  # Keep only the :80 server
  cat /tmp/movy-http-only.conf > nginx/movy.conf.tmp
  mv nginx/movy.conf.tmp nginx/movy.conf
  # Restore after boot if we mangled it - we'll restore the full file after cert issuance
  RESTORE_NGINX=true
else
  RESTORE_NGINX=false
fi

docker compose up -d movy nginx
sleep 3
docker compose ps

if [[ "$DO_CERTBOT" != true ]]; then
  echo ""
  echo "[✓] HTTP-only stack up (no certbot)"
  echo "    Test: curl -i http://${DOMAIN}/manifest.json"
  echo "    To add TLS later: sudo ./setup-docker.sh --email you@example.com"
  [[ "$RESTORE_NGINX" == true ]] && mv nginx/movy.conf.bak nginx/movy.conf || true
  exit 0
fi

if [[ -z "$EMAIL" ]]; then
  echo "[!] --email is required for certbot (e.g. --email you@example.com)" >&2
  echo "    Or use --no-certbot for HTTP only"
  exit 1
fi

# 2. Obtain cert via webroot (nginx serves /.well-known/acme-challenge/ from /var/www/certbot)
STAGING_ARG=""
if [[ "$STAGING" == true ]]; then
  STAGING_ARG="--staging"
  echo "[*] Using Let's Encrypt STAGING"
fi

echo "[*] Requesting certificate for ${DOMAIN} via certbot webroot..."
docker compose run --rm --entrypoint "" certbot certbot certonly --webroot \
  -w /var/www/certbot \
  -d "$DOMAIN" \
  --email "$EMAIL" --agree-tos --no-eff-email \
  $STAGING_ARG --force-renewal || {
  echo "[!] certbot failed - check:"
  echo "    - DNS A record for ${DOMAIN} points to this host's public IP"
  echo "    - Port 80 is open and forwarded (ufw allow 80,443; router NAT)"
  echo "    - nginx is serving: curl -i http://${DOMAIN}/.well-known/acme-challenge/test"
  exit 1
}

# 3. Restore full nginx config (with 443) and reload
if [[ "$RESTORE_NGINX" == true ]]; then
  echo "[*] Restoring full nginx config with TLS..."
  mv nginx/movy.conf.bak nginx/movy.conf
fi

echo "[*] Reloading nginx with TLS config..."
docker compose restart nginx
sleep 2

# Add redirect to HTTPS now that TLS works (uncomment return 301 if you want)
# The movy.conf HTTP block already proxies; to force HTTPS, edit nginx/movy.conf:
#   location / { return 301 https://\$host\$request_uri; }
# and: docker compose restart nginx

echo "[*] Testing..."
curl -ki "https://${DOMAIN}/manifest.json" | head -n 20 || true
curl -i "http://${DOMAIN}/manifest.json" | head -n 20 || true

echo ""
echo "[✓] Done!"
echo "    HTTP:  http://${DOMAIN}/manifest.json"
echo "    HTTPS: https://${DOMAIN}/manifest.json"
echo ""
echo "    Containers: docker compose ps"
echo "    Logs:       docker compose logs -f movy nginx certbot"
echo "    Renew:      certbot container auto-renews every 12h (docker compose logs certbot)"
echo "    Manual:     docker compose run --rm --entrypoint \"\" certbot certbot renew --webroot -w /var/www/certbot && docker compose restart nginx"
echo ""
echo "    To force HTTPS redirect, edit nginx/movy.conf HTTP location to:"
echo "      return 301 https://\$host\$request_uri;"
echo "    then: docker compose restart nginx"
