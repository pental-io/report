#!/bin/sh
# Pental Report installer: https://pental.io/report
#
# Installs Pental Report with Docker and opens it, or updates the one already
# here. Your settings (.env) and your data (Docker volumes) are kept by an
# update.
#
#   curl -fsSL https://pental.io/report/install.sh | sh
#   curl -fsSL https://pental.io/report/install.sh | sh -s -- --tailscale
#   curl -fsSL https://pental.io/report/install.sh | sh -s -- --domain reports.yourfirm.com
#
# Copyright (c) Pental Limited.
# SPDX-License-Identifier: AGPL-3.0-only
set -eu

VERSION="0.1.5"
REPO="pental-io/report"
IMAGE="ghcr.io/pental-io/report"

usage() {
  cat <<'USAGE'
Pental Report installer

  curl -fsSL https://pental.io/report/install.sh | sh -s -- [options]

  --tailscale      for your team, privately: shared on your Tailscale network
                   at https://<this computer>.<your tailnet>.ts.net
  --domain NAME    serve it over HTTPS at NAME (its DNS must point here,
                   with ports 80 and 443 open)
  --local          this computer only, at http://localhost (the default)
  --dir PATH       where it lives (default ~/pental-report, /opt/pental-report as root)
  --version X.Y.Z  a release other than this installer's
  --yes            ask nothing, take the defaults
  --no-open        leave the browser closed at the end
  --no-auto-update leave updating to you: Pental Report says when a release
                   is out, with this command to run
USAGE
}

# ── Options ────────────────────────────────────────────────────────────────
DOMAIN_ARG=""; MODE=""; DIR="${PENTAL_REPORT_DIR:-}"; YES=0; OPEN=1; AUTO_ARG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN_ARG="${2:-}"; MODE=domain; shift; [ $# -gt 0 ] && shift ;;
    --domain=*) DOMAIN_ARG="${1#*=}"; MODE=domain; shift ;;
    --local) MODE=local; shift ;;
    --tailscale) MODE=tailscale; shift ;;
    --dir) DIR="${2:-}"; shift; [ $# -gt 0 ] && shift ;;
    --dir=*) DIR="${1#*=}"; shift ;;
    --version) VERSION="${2:-}"; shift; [ $# -gt 0 ] && shift ;;
    --version=*) VERSION="${1#*=}"; shift ;;
    --yes|-y) YES=1; shift ;;
    --no-open) OPEN=0; shift ;;
    --no-auto-update) AUTO_ARG=0; shift ;;
    --auto-update) AUTO_ARG=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done
VERSION="${VERSION#v}"
if [ -z "$DIR" ]; then
  if [ "$(id -u)" = 0 ]; then DIR=/opt/pental-report; else DIR="$HOME/pental-report"; fi
fi
LOG="${TMPDIR:-/tmp}/pental-report-install.log"
: > "$LOG"

# ── How it looks ───────────────────────────────────────────────────────────
UTF=0
case "${LC_ALL:-${LC_CTYPE:-${LANG:-}}}" in *UTF-8*|*utf-8*|*UTF8*|*utf8*) UTF=1 ;; esac
[ "$(uname -s)" = Darwin ] && UTF=1
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-dumb}" != dumb ]; then
  E=$(printf '\033'); B="$E[1m"; D="$E[2m"; R="$E[0m"; RED="$E[38;5;124m"; OK="$E[38;5;35m"; WARN="$E[38;5;178m"; TTY=1
else
  E=""; B=""; D=""; R=""; RED=""; OK=""; WARN=""; TTY=0
fi
if [ $UTF = 1 ]; then TICK="✓"; CROSS="✗"; DOT="•"; ARROW="›"; BAR="│"; TOP="╭"; BOT="╰"; H="─"
else TICK="+"; CROSS="x"; DOT="*"; ARROW=">"; BAR="|"; TOP="+"; BOT="+"; H="-"; fi

say()  { printf '%s\n' "$*"; }
step() { printf '  %s%s%s %s\n' "$OK" "$TICK" "$R" "$*"; }
note() { printf '  %s%s %s%s\n' "$D" "$DOT" "$*" "$R"; }
warn() { printf '  %s!%s %s\n' "$WARN" "$R" "$*"; }
fail() {
  printf '\n  %s%s%s %s%s%s\n' "$RED" "$CROSS" "$R" "$B" "$1" "$R" >&2
  shift
  for l in "$@"; do printf '    %s\n' "$l" >&2; done
  if [ -s "$LOG" ]; then
    printf '\n    %sThe last of what it said:%s\n' "$D" "$R" >&2
    tail -n 12 "$LOG" | sed 's/^/      /' >&2
    printf '    %sAll of it: %s%s\n' "$D" "$LOG" "$R" >&2
  fi
  printf '\n' >&2
  exit 1
}

# Asking works when the script is piped in, through the terminal itself. With
# no terminal to ask (--yes, or run by another program) the default is taken.
can_ask() { [ $YES = 0 ] && { [ -t 0 ] || ( : < /dev/tty ) 2>/dev/null; }; }
ask() {
  # ask VAR "Question" default
  _q="$2"; _d="${3:-}"; _a=""
  if ! can_ask; then eval "$1=\$_d"; return 0; fi
  printf '  %s%s%s %s ' "$RED" "$ARROW" "$R" "$_q"
  if [ -t 0 ]; then read -r _a || _a=""; else read -r _a < /dev/tty || _a=""; fi
  [ -n "$_a" ] || _a="$_d"
  eval "$1=\$_a"
}

# run "Label" command...: what the command says goes to the log, a spinner
# with the label to the screen.
run() {
  _label="$1"; shift
  if [ $TTY = 0 ]; then
    note "$_label"
    "$@" >>"$LOG" 2>&1
    return $?
  fi
  "$@" >>"$LOG" 2>&1 &
  _pid=$!
  if [ $UTF = 1 ]; then _frames="⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏"; else _frames="| / - \\"; fi
  while kill -0 "$_pid" 2>/dev/null; do
    for _f in $_frames; do
      kill -0 "$_pid" 2>/dev/null || break
      printf '\r  %s%s%s %s' "$RED" "$_f" "$R" "$_label"
      sleep 0.1
    done
  done
  printf '\r%s[K' "$E"
  wait "$_pid"
}

say ""
printf '  %s%sPENTAL%s  %sReport%s  %s%s%s\n' "$B" "$RED" "$R" "$B" "$R" "$D" "$VERSION" "$R"
printf '  %sFree, open-source penetration test reporting, on your own server.%s\n' "$D" "$R"
say ""

# ── Docker ─────────────────────────────────────────────────────────────────
OS=$(uname -s)
case "$OS" in
  Linux|Darwin) ;;
  *) fail "This installer is for Linux and macOS." "On Windows, run this in PowerShell instead:" "irm https://pental.io/report/install.ps1 | iex" ;;
esac
if command -v curl >/dev/null 2>&1; then GET="curl -fsSL"
elif command -v wget >/dev/null 2>&1; then GET="wget -qO-"
else fail "curl or wget is needed to download Pental Report."; fi
command -v tar >/dev/null 2>&1 || fail "tar is needed to unpack Pental Report."

SUDO=""
[ "$(id -u)" = 0 ] || { command -v sudo >/dev/null 2>&1 && SUDO="sudo"; }

if ! command -v docker >/dev/null 2>&1; then
  [ "$OS" = Darwin ] && fail "Docker is not installed." "Install Docker Desktop from https://www.docker.com/products/docker-desktop/," "open it once, then run this installer again."
  warn "Docker is not installed."
  # Installing it is asked, or given with --yes: never taken for granted.
  if [ $YES = 1 ]; then WANT=y
  elif can_ask; then ask WANT "Install it now with Docker's own installer (get.docker.com)? [Y/n]" "y"
  else fail "Docker is not installed." "Install it from https://docs.docker.com/engine/install/," "or run this again with --yes to have it installed for you."; fi
  case "$WANT" in [nN]*) fail "Pental Report runs in Docker." "Install it from https://docs.docker.com/engine/install/, then run this again." ;; esac
  [ -n "$SUDO" ] && $SUDO -v
  run "Installing Docker" sh -c "$GET https://get.docker.com | $SUDO sh" \
    || fail "Docker could not be installed." "Install it from https://docs.docker.com/engine/install/, then run this again."
  $SUDO systemctl enable --now docker >>"$LOG" 2>&1 || true
  step "Docker installed"
fi

DOCKER="docker"
if ! docker info >/dev/null 2>&1; then
  if [ "$OS" = Darwin ]; then
    open -ga Docker >/dev/null 2>&1 || true
    _wait_docker() { _i=0; while [ $_i -lt 90 ]; do docker info >/dev/null 2>&1 && return 0; sleep 2; _i=$((_i + 1)); done; return 1; }
    run "Starting Docker Desktop" _wait_docker || fail "Docker Desktop is not running." "Open Docker Desktop, wait until it says it is running, then run this again."
  elif [ -n "$SUDO" ]; then
    # Not in the docker group: Docker is asked through sudo, once for the password.
    $SUDO -v || fail "Docker needs sudo here, and sudo was not given."
    $SUDO systemctl start docker >>"$LOG" 2>&1 || true
    $SUDO docker info >/dev/null 2>&1 || fail "Docker is installed but not running." "Start it with: sudo systemctl start docker, then run this again."
    DOCKER="$SUDO docker"
  else
    systemctl start docker >>"$LOG" 2>&1 || true
    docker info >/dev/null 2>&1 || fail "Docker is installed but not running." "Start it with: systemctl start docker, then run this again."
  fi
fi
$DOCKER compose version >/dev/null 2>&1 || fail "Docker Compose v2 is needed (the 'docker compose' command)." "Install the Compose plugin: https://docs.docker.com/compose/install/"
DV=$($DOCKER version --format '{{.Server.Version}}' 2>/dev/null || true)
step "Docker${DV:+ $DV} is ready"

# ── Download ───────────────────────────────────────────────────────────────
UPDATE=0
[ -f "$DIR/.env" ] && UPDATE=1
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
URL="https://github.com/$REPO/archive/refs/tags/v$VERSION.tar.gz"
run "Downloading Pental Report $VERSION" sh -c "$GET '$URL' | tar -xzf - -C '$TMP'" \
  || fail "Pental Report $VERSION could not be downloaded." "From $URL" "Check this computer can reach github.com, then try again."
SRC=$(find "$TMP" -mindepth 1 -maxdepth 1 -type d | head -n 1)
{ [ -n "$SRC" ] && [ -f "$SRC/docker-compose.yml" ]; } || fail "That download was not a Pental Report release." "From $URL"
mkdir -p "$DIR"
# The app's own files are replaced whole; .env and anything else of yours stay.
for d in server web db; do rm -rf "${DIR:?}/$d"; done
cp -R "$SRC"/. "$DIR"/
step "Pental Report $VERSION is in $DIR"
cd "$DIR"

# ── Settings ───────────────────────────────────────────────────────────────
port_busy() {
  if command -v ss >/dev/null 2>&1; then ss -ltn 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]$1\$"
  elif command -v lsof >/dev/null 2>&1; then lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
  elif command -v netstat >/dev/null 2>&1; then netstat -an 2>/dev/null | grep -i listen | grep -Eq "[:.]$1 "
  else return 1; fi
}
envget() { sed -n "s/^$1=//p" .env | tail -n 1; }
envset() {
  if grep -q "^$1=" .env; then
    _v=$(printf '%s' "$2" | sed 's/[\\&|]/\\&/g')
    ( umask 077; sed "s|^$1=.*|$1=$_v|" .env > .env.next ) && cat .env.next > .env && rm -f .env.next
  else printf '%s=%s\n' "$1" "$2" >> .env; fi
}
secret() {
  if command -v openssl >/dev/null 2>&1; then openssl rand -base64 "$1" | tr -d '\n=' | tr '+/' '-_'
  else head -c "$1" /dev/urandom | base64 | tr -d '\n=' | tr '+/' '-_'; fi
}

if [ $UPDATE = 0 ]; then
  if [ -z "$MODE" ] && can_ask; then
    say ""
    printf '  %sWhere will your team open it?%s\n' "$B" "$R"
    printf '    %s1%s  On this computer, to try it\n' "$RED" "$R"
    printf '    %s2%s  On your Tailscale network: your team opens it from their own computers, privately\n' "$RED" "$R"
    printf '    %s3%s  On a domain of yours over HTTPS, such as reports.yourfirm.com\n' "$RED" "$R"
    ask CHOICE "Choose 1, 2 or 3 [1]:" "1"
    case "$CHOICE" in 2*) MODE=tailscale ;; 3*) MODE=domain ;; *) MODE=local ;; esac
    say ""
  fi
  [ -n "$MODE" ] || MODE=local
  DOMAIN=""
  if [ "$MODE" = domain ]; then
    DOMAIN="$DOMAIN_ARG"
    [ -n "$DOMAIN" ] || ask DOMAIN "Domain name:" ""
    DOMAIN=$(printf '%s' "$DOMAIN" | tr -d '[:space:]' | sed -e 's#^https\{0,1\}://##' -e 's#/.*$##')
    case "$DOMAIN" in *.*) ;; *) fail "That is not a domain name: '$DOMAIN'." "Give one such as reports.yourfirm.com, or choose this computer." ;; esac
    for p in 80 443; do port_busy $p && warn "Port $p is already in use here, and Caddy needs it to serve $DOMAIN."; done
    if ! { getent hosts "$DOMAIN" >/dev/null 2>&1 || host "$DOMAIN" >/dev/null 2>&1 || nslookup "$DOMAIN" >/dev/null 2>&1; }; then
      warn "$DOMAIN does not resolve yet. Point it at this server: its certificate is fetched once it does."
    fi
  fi
  PORT=8080
  while port_busy $PORT; do PORT=$((PORT + 1)); done
  [ $PORT = 8080 ] || note "Port 8080 is in use, so it listens on $PORT"
  DOMAIN="$DOMAIN" PORT="$PORT" QUIET=1 sh ./setup.sh >>"$LOG" 2>&1 || fail "The settings could not be written."
  step "Settings made, with new secrets, in $DIR/.env"
else
  step "Your settings are kept ($DIR/.env)"
fi
envset REPORT_VERSION "$VERSION"
# What Pental Report is told of this computer, so the app can give the exact
# command that updates it, and the token its updater asks with (update.sh).
case "$OS" in Darwin) envset REPORT_HOST macos ;; *) envset REPORT_HOST linux ;; esac
envset REPORT_DIR "$DIR"
if [ "$(id -u)" = 0 ]; then envset REPORT_ROOT 1; else envset REPORT_ROOT 0; fi
[ -n "$(envget UPDATE_TOKEN)" ] || envset UPDATE_TOKEN "$(secret 32)"
PORT=$(envget PORT); PORT=${PORT:-8080}
DOMAIN=$(envget DOMAIN)
ADDR=$(envget PUBLIC_URL); ADDR=${ADDR:-http://localhost:$PORT}
# Shared over Tailscale before, or asked for now (an install made for this
# computer alone can be shared with --tailscale later, the same way).
SHARE=0
if [ "$MODE" = tailscale ] || [ "$(envget TAILSCALE)" = 1 ]; then
  [ -z "$DOMAIN" ] || fail "This Pental Report is served at https://$DOMAIN already." "Tailscale is for one without a domain of its own."
  SHARE=1
fi

# ── Start ──────────────────────────────────────────────────────────────────
if [ -n "$DOMAIN" ]; then
  run "Fetching PostgreSQL and Caddy" $DOCKER compose pull --quiet db caddy || fail "PostgreSQL and Caddy could not be fetched." "Check this computer can reach Docker Hub, then try again."
else
  run "Fetching PostgreSQL" $DOCKER compose pull --quiet db || fail "PostgreSQL could not be fetched." "Check this computer can reach Docker Hub, then try again."
fi
step "PostgreSQL${DOMAIN:+ and Caddy} fetched"
if run "Fetching Pental Report $VERSION" $DOCKER pull --quiet "$IMAGE:$VERSION"; then
  step "Pental Report $VERSION fetched"
else
  run "Building Pental Report $VERSION from its source" $DOCKER compose build report || fail "Pental Report could not be built."
  step "Pental Report $VERSION built"
fi
run "Starting it" $DOCKER compose up -d --no-build --remove-orphans || fail "Pental Report could not be started."

answers() { $GET "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; }
until_up() { _i=0; while [ $_i -lt 150 ]; do answers && return 0; sleep 2; _i=$((_i + 1)); done; return 1; }
run "Waiting for it to answer" until_up \
  || fail "Pental Report did not answer on port $PORT." "See what it is doing: cd $DIR && $DOCKER compose logs --tail 50 report"
step "Pental Report is running"

# ── Your team, over Tailscale ──────────────────────────────────────────────
# Tailscale's own HTTPS proxy (tailscale serve) shares the app with your
# tailnet at this computer's name there, with a certificate Tailscale issues:
# nothing is opened to the internet, and there is no domain to set up. The
# app stays listening on this computer alone; the address the team uses is
# PUBLIC_URL (the links Pental Report hands out, and security keys, are made
# for it), and Tailscale's proxy is the one in front (TRUST_PROXY=1).
if [ $SHARE = 1 ]; then
  TS=""; TS_SUDO=""
  if command -v tailscale >/dev/null 2>&1; then TS=tailscale
  elif [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ]; then TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale
  fi
  if [ -z "$TS" ]; then
    [ "$OS" = Darwin ] && fail "Tailscale is not installed." "Install it from https://tailscale.com/download/mac and sign in," "then run this installer again with --tailscale."
    warn "Tailscale is not installed."
    if [ $YES = 1 ]; then WANT=y
    elif can_ask; then ask WANT "Install it now with Tailscale's own installer (tailscale.com/install.sh)? [Y/n]" "y"
    else fail "Tailscale is not installed." "Install it from https://tailscale.com/download, or run this again with --yes to have it installed for you."; fi
    case "$WANT" in [nN]*) fail "Sharing with your team over Tailscale needs Tailscale." "Install it from https://tailscale.com/download, then run this again." ;; esac
    run "Installing Tailscale" sh -c "$GET https://tailscale.com/install.sh | $SUDO sh" \
      || fail "Tailscale could not be installed." "Install it from https://tailscale.com/download, then run this again."
    TS=tailscale
    step "Tailscale installed"
  fi
  # On Linux, Tailscale is changed as root.
  [ "$OS" = Linux ] && [ "$(id -u)" != 0 ] && TS_SUDO="$SUDO"
  ts_get() { $TS_SUDO $TS status --json 2>/dev/null | grep -o "\"$1\": *\"[^\"]*\"" | head -n 1 | sed 's/.*"\([^"]*\)"$/\1/'; }
  if [ "$(ts_get BackendState)" != Running ]; then
    [ "$OS" = Darwin ] && fail "Tailscale is not signed in." "Open Tailscale, sign in, then run this installer again with --tailscale."
    say ""
    note "Sign this computer in to your Tailscale network, at the link it shows:"
    $TS_SUDO $TS up || fail "Tailscale did not sign in." "Sign in with: $TS_SUDO $TS up, then run this installer again."
    say ""
  fi
  # 443 unless something else of yours is served there already.
  TS_PORT=443
  NOW=$($TS_SUDO $TS serve status --json 2>/dev/null || true)
  if printf '%s' "$NOW" | grep -q '"443"' && ! printf '%s' "$NOW" | grep -q "127.0.0.1:$PORT"; then TS_PORT=8443; fi
  # In the open, not in the log: the first time, Tailscale may show a link to
  # turn sharing on for the tailnet, and waits until it is.
  note "Sharing it on your tailnet. If Tailscale shows a link to turn on HTTPS, open it and say yes."
  $TS_SUDO $TS serve --bg --https=$TS_PORT "http://127.0.0.1:$PORT" \
    || fail "Tailscale could not share it." "Turn on HTTPS for your tailnet (Tailscale's admin console, DNS, HTTPS Certificates)," "then run this installer again with --tailscale. On Linux, run it as root or with sudo."
  NAME=$(ts_get DNSName); NAME=${NAME%.}
  [ -n "$NAME" ] || fail "Tailscale did not say this computer's name on your tailnet." "Check Tailscale is signed in (tailscale status), then run this again."
  ADDR="https://$NAME"; [ "$TS_PORT" = 443 ] || ADDR="$ADDR:$TS_PORT"
  if [ "$(envget PUBLIC_URL)" != "$ADDR" ] || [ "$(envget TRUST_PROXY)" != 1 ] || [ "$(envget TAILSCALE)" != 1 ]; then
    envset PUBLIC_URL "$ADDR"; envset TRUST_PROXY 1; envset TAILSCALE 1
    run "Restarting it at $ADDR" $DOCKER compose up -d --no-build report || fail "Pental Report could not be restarted."
    run "Waiting for it to answer" until_up \
      || fail "Pental Report did not answer on port $PORT." "See what it is doing: cd $DIR && $DOCKER compose logs --tail 50 report"
  fi
  step "Shared with your tailnet at $ADDR"
fi

# ── Updates ────────────────────────────────────────────────────────────────
# The updater (update.sh) asks Pental Report every minute whether to update,
# and installs a new release when an administrator presses Update Now, or
# overnight when updates are automatic (Settings, Updates). On Linux a systemd
# timer runs it (cron where there is no systemd), as root because it runs
# Docker; on macOS a launchd agent, as you. Without it, Pental Report still
# says when a release is out, with the command that installs it.
UNIT=pental-report-update
AGENT=io.pental.report.update
PLIST="$HOME/Library/LaunchAgents/$AGENT.plist"
xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
as_root() {
  [ "$(id -u)" = 0 ] && return 0
  [ -n "$SUDO" ] || return 1
  $SUDO -n true 2>/dev/null && return 0
  can_ask || return 1
  note "Setting up updates asks for your password, once."
  $SUDO -v
}
setup_updater() {
  case "$OS" in
    Linux)
      as_root || { warn "Updating by itself is set up as root (through sudo), which is not available here."; return 1; }
      if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
        printf '%s\n' "[Unit]" "Description=Pental Report's updater: asks Pental Report whether to update, and does" \
          "After=docker.service" "Wants=docker.service" "" "[Service]" "Type=oneshot" "ExecStart=/bin/sh \"$DIR/update.sh\"" \
          "TimeoutStartSec=1h" "LogLevelMax=notice" | $SUDO tee "/etc/systemd/system/$UNIT.service" >/dev/null || return 1
        printf '%s\n' "[Unit]" "Description=Pental Report's updater, every minute" "" "[Timer]" "OnBootSec=2min" "OnUnitActiveSec=1min" \
          "AccuracySec=15s" "" "[Install]" "WantedBy=timers.target" | $SUDO tee "/etc/systemd/system/$UNIT.timer" >/dev/null || return 1
        $SUDO systemctl daemon-reload >>"$LOG" 2>&1 && $SUDO systemctl enable --now "$UNIT.timer" >>"$LOG" 2>&1 || return 1
      elif [ -d /etc/cron.d ]; then
        printf '* * * * * root /bin/sh "%s/update.sh" >/dev/null 2>&1\n' "$DIR" | $SUDO tee "/etc/cron.d/$UNIT" >/dev/null || return 1
      else
        warn "This computer has neither systemd nor cron to run the updater."; return 1
      fi ;;
    Darwin)
      [ "$(id -u)" != 0 ] || { warn "On macOS the updater runs as you, so run the installer without sudo to set it up."; return 1; }
      mkdir -p "$HOME/Library/LaunchAgents"
      cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$AGENT</string>
  <key>ProgramArguments</key><array><string>/bin/sh</string><string>$(xml "$DIR")/update.sh</string></array>
  <key>StartInterval</key><integer>60</integer>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:$(xml "$HOME")/.docker/bin:/Applications/Docker.app/Contents/Resources/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
</dict>
</plist>
PLISTEOF
      launchctl bootout "gui/$(id -u)/$AGENT" >/dev/null 2>&1 || true
      launchctl bootstrap "gui/$(id -u)" "$PLIST" >>"$LOG" 2>&1 || return 1 ;;
  esac
  return 0
}
remove_updater() {
  case "$OS" in
    Linux)
      if [ -f "/etc/systemd/system/$UNIT.timer" ] || [ -f "/etc/cron.d/$UNIT" ]; then
        as_root || return 1
        if [ -f "/etc/systemd/system/$UNIT.timer" ]; then
          $SUDO systemctl disable --now "$UNIT.timer" >>"$LOG" 2>&1 || true
          $SUDO rm -f "/etc/systemd/system/$UNIT.timer" "/etc/systemd/system/$UNIT.service"
          $SUDO systemctl daemon-reload >>"$LOG" 2>&1 || true
        fi
        $SUDO rm -f "/etc/cron.d/$UNIT"
      fi ;;
    Darwin)
      launchctl bootout "gui/$(id -u)/$AGENT" >/dev/null 2>&1 || true
      rm -f "$PLIST" ;;
  esac
  return 0
}
UPD=""
if [ "${PENTAL_REPORT_UPDATER:-}" = 1 ]; then
  # Run by the updater itself: it stays as it is.
  UPD=on
else
  WANT_UPD="$AUTO_ARG"
  [ -n "$WANT_UPD" ] || WANT_UPD=$(envget UPDATER)
  if [ -z "$WANT_UPD" ]; then
    if can_ask; then
      say ""
      ask A "Keep Pental Report up to date by itself? New releases install overnight, after a copy of the database [Y/n]" "y"
      case "$A" in [nN]*) WANT_UPD=0 ;; *) WANT_UPD=1 ;; esac
    else WANT_UPD=1; fi
  fi
  envset UPDATER "$WANT_UPD"
  if [ "$WANT_UPD" = 1 ]; then
    if setup_updater; then UPD=on; step "It updates itself: new releases install overnight"
    else UPD=none; note "Updates are yours to install: Pental Report says when one is out, with the command"; fi
  else
    remove_updater || true
    UPD=off
  fi
fi

FIRST=0
case "$($GET "http://127.0.0.1:$PORT/reporter/v1/config" 2>/dev/null || true)" in *'"first_run":true'*) FIRST=1 ;; esac
TOKEN=$(envget SETUP_TOKEN)

# ── Done ───────────────────────────────────────────────────────────────────
rule() { _n=60; _s=""; while [ $_n -gt 0 ]; do _s="$_s$H"; _n=$((_n - 1)); done; printf '  %s%s%s%s\n' "$D" "$1" "$_s" "$R"; }
bar()  { printf '  %s%s%s  %s\n' "$D" "$BAR" "$R" "$*"; }
say ""
rule "$TOP"
if [ $UPDATE = 1 ]; then bar "${B}Pental Report is updated to $VERSION.${R}"; else bar "${B}Pental Report is installed.${R}"; fi
bar ""
bar "${D}Open${R}         ${B}$ADDR${R}"
if [ $FIRST = 1 ]; then
  bar "${D}Setup code${R}   ${B}$TOKEN${R}"
  bar ""
  bar "${D}The setup code makes you its first administrator. It is also${R}"
  bar "${D}SETUP_TOKEN in $DIR/.env.${R}"
fi
if [ -n "$DOMAIN" ]; then
  bar ""
  bar "${D}$DOMAIN must point at this server, with ports 80 and 443 open:${R}"
  bar "${D}its certificate is fetched the first time it is opened.${R}"
fi
if [ $SHARE = 1 ]; then
  bar ""
  bar "${D}Your team opens it at that address from their own computers,${R}"
  bar "${D}once they are on your tailnet (Tailscale's admin console, Users).${R}"
  bar "${D}Nothing is open to the internet. Keep this computer on.${R}"
fi
rule "$BOT"
say ""
printf '  %sLives in%s  %s\n' "$D" "$R" "$DIR"
printf '  %sLogs%s      cd %s && %s compose logs -f report\n' "$D" "$R" "$DIR" "$DOCKER"
printf '  %sStop%s      cd %s && %s compose stop\n' "$D" "$R" "$DIR" "$DOCKER"
if [ "$UPD" = on ]; then printf '  %sUpdates%s   install by themselves overnight (Settings, Updates)\n' "$D" "$R"
else printf '  %sUpdate%s    run this installer again\n' "$D" "$R"; fi
say ""
rm -f "$LOG"

if [ $OPEN = 1 ] && [ $FIRST = 1 ] && [ -z "$DOMAIN" ]; then
  # The setup code after a #, so the first-run page fills it in. A # part is
  # never sent to the server, and the page takes it off the address at once.
  GO="$ADDR/#setup=$TOKEN"
  if [ "$OS" = Darwin ]; then open "$GO" >/dev/null 2>&1 || true
  elif [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] && command -v xdg-open >/dev/null 2>&1; then xdg-open "$GO" >/dev/null 2>&1 || true
  fi
fi
