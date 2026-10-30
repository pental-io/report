#!/bin/sh
# Pental Report's updater, on the computer Pental Report runs on.
#
# The installer sets it to run every minute (a systemd timer on Linux, a
# launchd agent on macOS). Each time it asks Pental Report, over this
# computer's own connection to it and with UPDATE_TOKEN from .env, whether to
# update; nearly always the answer is no, and it stops there. When an
# administrator has pressed Update Now, or overnight when updates are
# automatic, the answer is the version to install, and it:
#
#   1. makes a copy of the database in backups/ (the last three are kept);
#   2. downloads that release from its own tag on GitHub, which cannot be
#      moved or changed once it is published;
#   3. runs that release's installer, as the install command does: your
#      settings and your data stay as they are;
#   4. if the new version does not start, puts the one before it back.
#
# What it did is written to update.log beside it, and told to Pental Report,
# which shows it in Settings, Updates. To stop it, set UPDATER=0 in .env, or
# run the installer with --no-auto-update.
#
#   sh update.sh            what the timer runs
#
# Copyright (c) Pental Limited.
# SPDX-License-Identifier: AGPL-3.0-only

# All of it in one block, read whole before any of it runs: the installer it
# starts replaces this file, and a shell reading on from where it was in the
# old one would run whatever stands there in the new.
{
set -u

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1
cd "$DIR" || exit 1
[ -f .env ] || exit 0
envget() { sed -n "s/^$1=//p" .env | tail -n 1; }
[ "$(envget UPDATER)" = 0 ] && exit 0
TOKEN=$(envget UPDATE_TOKEN)
[ -n "$TOKEN" ] || exit 0
PORT=$(envget PORT); PORT=${PORT:-8080}
ASK="${PENTAL_REPORT_UPDATER_URL:-http://127.0.0.1:$PORT/reporter/v1/updater}"
RELEASES="${PENTAL_REPORT_RELEASES:-https://github.com/pental-io/report/archive/refs/tags}"
LOG="$DIR/update.log"

if command -v curl >/dev/null 2>&1; then
  ask()   { curl -fsS --max-time 15 -H "X-Updater-Token: $TOKEN" "$ASK?$1" 2>/dev/null; }
  tell()  { curl -fsS --max-time 15 -X POST -H "X-Updater-Token: $TOKEN" -H 'Content-Type: application/x-www-form-urlencoded' --data "$1" "$ASK" >/dev/null 2>&1 || true; }
  fetch() { curl -fsSL --max-time 600 "$1"; }
elif command -v wget >/dev/null 2>&1; then
  ask()   { wget -qO- -T 15 --header="X-Updater-Token: $TOKEN" "$ASK?$1" 2>/dev/null; }
  tell()  { wget -qO- -T 15 --header="X-Updater-Token: $TOKEN" --header='Content-Type: application/x-www-form-urlencoded' --post-data="$1" "$ASK" >/dev/null 2>&1 || true; }
  fetch() { wget -qO- -T 600 "$1"; }
else
  exit 0
fi

# One at a time. A lock left by an updater stopped part-way is cleared once
# it is two hours old.
LOCK="$DIR/.update.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  [ -n "$(find "$LOCK" -maxdepth 0 -mmin +120 2>/dev/null)" ] || exit 0
  rmdir "$LOCK" 2>/dev/null; mkdir "$LOCK" 2>/dev/null || exit 0
fi
TMP=""
cleanup() { rmdir "$LOCK" 2>/dev/null; [ -n "$TMP" ] && rm -rf "$TMP"; }
trap cleanup EXIT
trap 'exit 1' INT TERM

ANSWER=$(ask "hour=$(date +%H)&os=$(uname -s)") || exit 0
case "$ANSWER" in "update "*) VERSION=$(printf '%s' "${ANSWER#update }" | tr -d '[:space:]') ;; *) exit 0 ;; esac
case "$VERSION" in ""|*[!0-9.]*) exit 0 ;; esac
FROM=$(envget REPORT_VERSION)
case "$FROM" in *[!0-9.]*) FROM="" ;; esac

say() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG"; }
# Words for Pental Report, without anything a form would read as its own.
words() { printf '%s' "$*" | tr -c 'A-Za-z0-9 .,:()/_-' ' ' | tr ' ' '+'; }
failed() { say "$1"; tell "event=failed&version=$VERSION&from=$FROM&message=$(words "$1")"; exit 1; }

say "Updating from ${FROM:-an unknown version} to $VERSION"
tell "event=started&version=$VERSION&from=$FROM"

# The computer's owner of these files, so what root writes here stays theirs.
OWNER=$(stat -c '%u:%g' .env 2>/dev/null || stat -f '%u:%g' .env 2>/dev/null || echo "")
give_back() { [ "$(id -u)" = 0 ] && [ -n "$OWNER" ] && [ "$OWNER" != "0:0" ] && chown -R "$OWNER" "$DIR" 2>/dev/null; return 0; }

docker info >/dev/null 2>&1 || failed "Docker is not running on the computer Pental Report runs on, so nothing was changed."

# 1. A copy of the database.
mkdir -p backups
COPY="backups/before-$VERSION-$(date +%Y%m%d-%H%M%S).sql"
if docker compose exec -T db pg_dump -U postgres -d report > "$COPY" 2>>"$LOG" && [ -s "$COPY" ]; then
  gzip -f "$COPY" 2>>"$LOG" || true
  say "Database copied to $(ls "$COPY"* 2>/dev/null | head -n 1)"
  # The last three made here; a backup you made yourself is never touched.
  ls -1t backups/before-*.sql* 2>/dev/null | tail -n +4 | while IFS= read -r old; do rm -f "$old"; done
else
  rm -f "$COPY"
  failed "The database could not be copied first, so nothing was changed."
fi

# 2. That release, from its tag.
TMP=$(mktemp -d) || failed "No room to download it, so nothing was changed."
get_release() {
  _dest="$TMP/$1"; mkdir -p "$_dest"
  fetch "$RELEASES/v$1.tar.gz" 2>>"$LOG" | tar -xzf - -C "$_dest" 2>>"$LOG" || return 1
  _src=$(find "$_dest" -mindepth 1 -maxdepth 1 -type d | head -n 1)
  [ -n "$_src" ] && [ -f "$_src/install.sh" ] && [ -f "$_src/docker-compose.yml" ] || return 1
  printf '%s' "$_src"
}
SRC=$(get_release "$VERSION") || failed "Pental Report $VERSION could not be downloaded from GitHub, so nothing was changed."

# 3. Installed as the install command does it. The installer is told the
# updater is running it, so it leaves the updater itself alone.
if PENTAL_REPORT_UPDATER=1 sh "$SRC/install.sh" --dir "$DIR" --version "$VERSION" --yes --no-open >> "$LOG" 2>&1; then
  give_back
  say "Updated to $VERSION"
  tell "event=done&version=$VERSION&from=$FROM"
  exit 0
fi

# 4. It did not start: the one before it, back.
WHY="$VERSION did not start"
if [ -n "$FROM" ] && OLD=$(get_release "$FROM") \
  && PENTAL_REPORT_UPDATER=1 sh "$OLD/install.sh" --dir "$DIR" --version "$FROM" --yes --no-open >> "$LOG" 2>&1; then
  give_back
  failed "$WHY, so $FROM was put back. The database copy from before is in backups/."
fi
give_back
failed "$WHY, and $FROM could not be put back. The database copy from before is in backups/: run the install command to start it again."
exit 1
}
