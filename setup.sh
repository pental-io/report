#!/bin/sh
# Makes .env for Pental Report: new secrets, and the address your team will
# use. The installer runs it for you; by hand, run it once, then
# `docker compose up -d`.
#
#   ./setup.sh                            asks for a domain
#   DOMAIN=reports.yourfirm.com ./setup.sh
#   DOMAIN= ./setup.sh                    this machine only, http://localhost:8080
#   DOMAIN= PORT=8090 ./setup.sh          the same, on another port
#
# SPDX-License-Identifier: AGPL-3.0-only
set -eu
cd "$(dirname "$0")"

if [ -f .env ]; then
  echo ".env already exists, so nothing was changed. Its secrets protect the data"
  echo "already in your database: keep it. To start again from nothing, remove"
  echo "both .env and the database (docker compose down -v) first."
  exit 1
fi

secret() {
  # $1 random bytes, URL-safe.
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 "$1" | tr -d '\n=' | tr '+/' '-_'
  else
    head -c "$1" /dev/urandom | base64 | tr -d '\n=' | tr '+/' '-_'
  fi
}

if [ -z "${DOMAIN+set}" ]; then
  printf 'Domain for HTTPS, such as reports.yourfirm.com (leave blank to use it on this machine only): '
  if [ -t 0 ]; then read -r DOMAIN || DOMAIN=; elif [ -r /dev/tty ]; then read -r DOMAIN < /dev/tty || DOMAIN=; else DOMAIN=; echo; fi
fi
DOMAIN=$(printf '%s' "$DOMAIN" | tr -d '[:space:]' | sed -e 's#^https\{0,1\}://##' -e 's#/.*$##')
PORT=${PORT:-8080}

if [ -n "$DOMAIN" ]; then
  URL="https://$DOMAIN"
  PROFILES=https
  TRUST=1
else
  URL="http://localhost:$PORT"
  PROFILES=
  TRUST=false
fi
TOKEN="prs_$(secret 24)"

umask 077
cat > .env <<ENV
# Pental Report, made by setup.sh on $(date -u +%Y-%m-%dT%H:%MZ).
# These are the keys to your reports. Keep this file, keep it private, and
# back it up with the database: without VAULT_KEY a backup cannot be opened.

POSTGRES_PASSWORD=$(secret 32)
REPORT_DB_PASSWORD=$(secret 32)
JWT_SECRET=$(secret 48)
VAULT_KEY=$(secret 32)
SETUP_TOKEN=$TOKEN

PUBLIC_URL=$URL
DOMAIN=$DOMAIN
COMPOSE_PROFILES=$PROFILES
TRUST_PROXY=$TRUST
PORT=$PORT

# See .env.example for everything else you can set here (file storage in an
# S3 bucket, upload size).
ENV

[ "${QUIET:-}" = 1 ] && exit 0
echo
echo "Made .env."
echo
echo "Next:"
echo "  1. docker compose up -d"
if [ -n "$DOMAIN" ]; then
  echo "     ($DOMAIN must point at this machine, with ports 80 and 443 open,"
  echo "     for the certificate to be issued.)"
fi
echo "  2. Open $URL"
echo "  3. Enter this setup token to make the first administrator:"
echo
echo "     $TOKEN"
echo
echo "It is also in .env (SETUP_TOKEN), and is only asked for once."
