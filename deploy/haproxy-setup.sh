#!/bin/bash
# Installs HAProxy and a Let's Encrypt certificate for the domain, then puts
# deploy/haproxy.cfg in place. Run after setup.sh (it reads the files from $APP).
set -euo pipefail
DOMAIN=${DOMAIN:-mashloop.truclv.com}
APP=/root/truc_ai/mashloop

if ! command -v haproxy >/dev/null || ! command -v certbot >/dev/null; then
    apt-get update -q
    DEBIAN_FRONTEND=noninteractive apt-get install -y -q haproxy certbot
fi
mkdir -p /etc/haproxy/certs /etc/letsencrypt/renewal-hooks/deploy
install -m 755 "$APP/deploy/certbot-haproxy.sh" /etc/letsencrypt/renewal-hooks/deploy/haproxy.sh
[ -f /etc/haproxy/haproxy.cfg.dist ] || cp /etc/haproxy/haproxy.cfg /etc/haproxy/haproxy.cfg.dist

if [ ! -f "/etc/haproxy/certs/$DOMAIN.pem" ]; then
    # First certificate: HAProxy serves plain HTTP only, passing Let's Encrypt's
    # check through to certbot on loopback; renewals take the same path.
    sed '/^frontend https_in/,/^$/d' "$APP/deploy/haproxy.cfg" > /etc/haproxy/haproxy.cfg
    haproxy -c -q -f /etc/haproxy/haproxy.cfg
    systemctl enable haproxy >/dev/null 2>&1
    systemctl restart haproxy
    certbot certonly --standalone --http-01-address 127.0.0.1 --http-01-port 18080 \
        -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email
    RENEWED_LINEAGE="/etc/letsencrypt/live/$DOMAIN" sh /etc/letsencrypt/renewal-hooks/deploy/haproxy.sh
fi

# (The box's live haproxy.cfg may front other projects too: merge by hand
# there rather than overwrite it.)
install -m 644 "$APP/deploy/haproxy.cfg" /etc/haproxy/haproxy.cfg
# The blocked and trusted address lists the config loads (the app fills them).
touch /etc/haproxy/mashloop-block.lst /etc/haproxy/mashloop-trust.lst
# The request log's file, made ahead: rsyslog runs as syslog and cannot create
# it where /var/log is not group-writable (logrotate then keeps its owner).
[ -e /var/log/haproxy.log ] || install -o syslog -g adm -m 0640 /dev/null /var/log/haproxy.log
haproxy -c -q -f /etc/haproxy/haproxy.cfg
systemctl enable haproxy >/dev/null 2>&1
systemctl reload-or-restart haproxy
echo "haproxy: $(systemctl is-active haproxy)"
certbot certificates 2>/dev/null | grep -E "Domains|Expiry" || true
