#!/usr/bin/env bash
set -euo pipefail

# setup-nginx.sh - Ubuntu nginx + certbot for movy.ddns.net -> 127.0.0.1:7000
# Usage:
#   sudo ./setup-nginx.sh [--domain movy.ddns.net] [--email you@example.com] [--port 7000] [--no-certbot] [--no-ufw]
# Example:
#   chmod +x setup-nginx.sh
#   sudo ./setup-nginx.sh --email you@example.com

DOMAIN="movy.ddns.net"
EMAIL=""
PORT="7000"
DO_CERTBOT=true
DO_UFW=true

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2;;
    --email) EMAIL="$2"; shift 2;;
    --port) PORT="$2"; shift 2;;
    --no-certbot) DO_CERTBOT=false; shift;;
    --no-ufw) DO_UFW=false; shift;;
    -h|--help)
      echo "Usage: sudo $0 [--domain DOMAIN] [--email EMAIL] [--port PORT] [--no-certbot] [--no-ufw]"
      exit 0
      ;;
    *) echo "Unknown option: $1" >&2; exit 1;;
  esac
done

if [[ $EUID -ne 0 ]]; then
  echo "[!] Run as root: sudo $0 --email you@example.com" >&2
  exit 1
fi

echo "[*] Domain: $DOMAIN"
echo "[*] Port:   $PORT"
echo "[*] Email:  ${EMAIL:-<none>}"
echo "[*] Certbot: $DO_CERTBOT"

echo "[*] Installing nginx + certbot..."
apt update
apt install -y nginx certbot python3-certbot-nginx

if [[ "$DO_UFW" == true ]] && command -v ufw >/dev/null 2>&1; then
  echo "[*] Configuring UFW..."
  ufw allow 'Nginx Full' || true
  ufw allow OpenSSH || true
fi

NGINX_CONF="/etc/nginx/sites-available/${DOMAIN}"

echo "[*] Writing ${NGINX_CONF}..."
cat > "$NGINX_CONF" <<EOF
# ${DOMAIN} - Stremio Movy addon (node addon.js -> 127.0.0.1:${PORT})
# Managed by setup-nginx.sh - safe to edit, re-run script will overwrite

server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};

    # for certbot http-01 challenge
    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    location / {
        proxy_pass http://127.0.0.1:${PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Connection "";

        # streaming / large file friendly - matches addon.js proxy behavior
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        send_timeout 3600s;
        client_max_body_size 0;
        proxy_max_temp_file_size 0;
    }
}
EOF

echo "[*] Enabling site..."
ln -sf "$NGINX_CONF" "/etc/nginx/sites-enabled/${DOMAIN}"

# Optional: keep default site - comment out next 2 lines if you need it
# if [[ -f /etc/nginx/sites-enabled/default ]]; then
#   echo "[*] Default site still enabled (remove with: sudo rm /etc/nginx/sites-enabled/default)"
# fi

echo "[*] Testing nginx config..."
nginx -t

echo "[*] Reloading nginx..."
systemctl reload nginx || systemctl restart nginx
systemctl enable nginx

if [[ "$DO_CERTBOT" == true ]]; then
  if [[ -z "$EMAIL" ]]; then
    echo ""
    echo "[!] No --email supplied. Running certbot with --register-unsafely-without-email"
    echo "    For production, re-run: sudo certbot --nginx -d ${DOMAIN} --email you@example.com --agree-tos --redirect"
    echo ""
    certbot --nginx -d "$DOMAIN" --agree-tos --redirect --register-unsafely-without-email --non-interactive || {
      echo "[!] certbot failed - check DNS A record for ${DOMAIN} points to this server and port 80 is open" >&2
      exit 1
    }
  else
    echo "[*] Requesting certificate via certbot --nginx..."
    certbot --nginx -d "$DOMAIN" --email "$EMAIL" --agree-tos --redirect --non-interactive || {
      echo "[!] certbot failed - check DNS A record for ${DOMAIN} points to this server and port 80 is open" >&2
      exit 1
    }
  fi

  echo "[*] Verifying renewal..."
  certbot renew --dry-run || true
  echo "[*] certbot timer: systemctl list-timers | grep certbot"
else
  echo "[*] Skipping certbot (--no-certbot). To run later:"
  echo "    sudo certbot --nginx -d ${DOMAIN} --email you@example.com --agree-tos --redirect"
fi

echo ""
echo "[✓] Done!"
echo "    HTTP:  http://${DOMAIN}/manifest.json  -> http://127.0.0.1:${PORT}"
if [[ "$DO_CERTBOT" == true ]]; then
  echo "    HTTPS: https://${DOMAIN}/manifest.json (certbot managed)"
fi
echo ""
echo "    Test addon: curl -i http://127.0.0.1:${PORT}/manifest.json"
echo "    Test nginx: curl -i http://${DOMAIN}/manifest.json"
if [[ "$DO_CERTBOT" == true ]]; then
  echo "    Test TLS:   curl -i https://${DOMAIN}/manifest.json"
fi
echo ""
echo "    Logs: sudo nginx -t; sudo journalctl -u nginx -e; sudo tail -f /var/log/nginx/error.log"
echo "    Make sure your addon is running: PORT=${PORT} node addon.js  (or via systemd/pm2)"
