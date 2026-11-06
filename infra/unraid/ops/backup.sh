#!/bin/bash
# Nightly logical backups of the game's two databases (runbook: infra/unraid/README.md,
# "Backups and uptime"; restore: infra/unraid/ops/restore.md).
#
#   backup.sh      dump manufactory and manufactory_supertokens from postgresql16, verify each
#                  dump, then drop this script's dumps older than 14 days
#
# Runs as root on the server, from cron at 03:30 (installed by install.sh). On any failure it
# sends an Unraid alert and exits non-zero; a success only logs one line. Only the game's two
# databases are read: never `supertokens` (the other app's), nor anything else.
#
# The paths can be overridden for the tests (test.sh): OPS_BACKUP_DIR, OPS_LOCK, OPS_NOTIFY.
set -euo pipefail
umask 077 # dumps hold every player's save and account: 600 files in a 700 directory

readonly PG_CONTAINER=postgresql16
readonly DATABASES=(manufactory manufactory_supertokens)
readonly KEEP_DAYS=14
readonly BACKUP_DIR=${OPS_BACKUP_DIR:-/mnt/user/appdata/manufactory/backups}
# On /var (RAM), not the array: flock on Unraid's FUSE user shares is not to be relied on.
readonly LOCK=${OPS_LOCK:-/var/lock/manufactory-backup.lock}
readonly NOTIFY=${OPS_NOTIFY:-/usr/local/emhttp/webGui/scripts/notify}

PG_ADMIN=""  # the container's POSTGRES_USER, read at run time
TMP=""       # the dump being written; removed at exit unless renamed into place
ALERTED=0    # so the EXIT trap does not alert a second time
FAILURES=()  # one line per failed database
SUMMARY=()   # "<db> <size>" per good dump

log() { printf '%s backup: %s\n' "$(date '+%F %T')" "$*"; }

# Unraid's notifier: -e event, -s subject, -d description, -i importance.
alert() {
  local importance=$1 subject=$2 description=$3
  ALERTED=1
  printf '%s backup: %s: %s\n' "$(date '+%F %T')" "$subject" "$description" >&2
  "$NOTIFY" -e "Manufactory Idle backup" -s "$subject" -d "$description" -i "$importance" ||
    printf 'backup: %s failed too\n' "$NOTIFY" >&2
}

die() {
  alert alert "Manufactory Idle: backup failed" "$*"
  exit 1
}

# shellcheck disable=SC2329 # the EXIT trap
on_exit() {
  local rc=$?
  if [[ -n $TMP ]]; then rm -f -- "$TMP"; fi
  # An unexpected `set -e` exit still alerts: a silent failure is the one to avoid.
  if [[ $rc -ne 0 && $ALERTED -eq 0 ]]; then
    alert alert "Manufactory Idle: backup failed" "backup.sh stopped with status $rc (see its log)"
  fi
}

human() { # bytes -> "123 KiB"
  local b=$1
  if ((b >= 1048576)); then
    printf '%d.%d MiB' $((b / 1048576)) $((b % 1048576 * 10 / 1048576))
  else
    printf '%d KiB' $(((b + 1023) / 1024))
  fi
}

# dump_one <db> <stamp>: streams pg_dump into a hidden temp file in the backup directory, checks
# it, and only then renames it to <db>-<stamp>.dump, so a final name never holds a partial dump.
dump_one() {
  local db=$1 stamp=$2 final size
  final="$BACKUP_DIR/$db-$stamp.dump"
  TMP=$(mktemp "$BACKUP_DIR/.$db-$stamp.XXXXXX.partial")
  if ! docker exec "$PG_CONTAINER" pg_dump -U "$PG_ADMIN" -Fc "$db" >"$TMP"; then
    FAILURES+=("$db: pg_dump failed")
    return 0
  fi
  if [[ ! -s $TMP ]]; then
    FAILURES+=("$db: pg_dump wrote nothing")
    return 0
  fi
  # --list reads the archive's header and table of contents. It stops there, so a dump cut short
  # in its data still lists: the second pass reads every data block (into /dev/null, no database).
  if ! docker exec -i "$PG_CONTAINER" pg_restore --list <"$TMP" >/dev/null; then
    FAILURES+=("$db: pg_restore --list could not read the dump")
    return 0
  fi
  if ! docker exec -i "$PG_CONTAINER" pg_restore -f /dev/null <"$TMP"; then
    FAILURES+=("$db: pg_restore could not read the dump to its end")
    return 0
  fi
  chmod 600 -- "$TMP"
  mv -- "$TMP" "$final"
  TMP=""
  size=$(stat -c %s -- "$final")
  SUMMARY+=("$db $(human "$size")")
}

# prune <db> <cutoff-stamp>: deletes <db>-YYYYMMDD-HHMMSS.dump files whose stamp is older than
# the cutoff, except the newest one, which is kept however old it is. The stamp in the name, not
# the mtime, is the age: a copy or a touch cannot make a dump look newer or older. Nothing that
# does not match that exact pattern is ever touched.
prune() {
  local db=$1 cutoff=$2 f name stamp newest=""
  local -a files=()
  for f in "$BACKUP_DIR/$db"-*.dump; do
    name=${f##*/}
    [[ $name =~ ^${db}-([0-9]{8}-[0-9]{6})\.dump$ && -f $f ]] || continue
    files+=("$f")
  done
  ((${#files[@]})) || return 0
  # The glob is sorted, and so is the stamp: the last match is the newest.
  newest=${files[-1]}
  for f in "${files[@]}"; do
    [[ $f == "$newest" ]] && continue
    name=${f##*/}
    stamp=${name#"$db"-}
    stamp=${stamp%.dump}
    if [[ $stamp < "$cutoff" ]]; then
      rm -f -- "$f"
      log "deleted $name (older than $KEEP_DAYS days)"
    fi
  done
}

main() {
  [[ $# -eq 0 ]] || {
    sed -n '5,6p' "$0" >&2
    exit 2
  }
  trap on_exit EXIT

  mkdir -p -- "$BACKUP_DIR"
  chmod 700 -- "$BACKUP_DIR"

  exec 9>"$LOCK"
  if ! flock -n 9; then
    alert warning "Manufactory Idle: backup skipped" "another backup.sh still holds $LOCK"
    exit 1
  fi

  # The admin role is the container's own POSTGRES_USER, read at run time (as deploy.sh does) so
  # no name is in the repo. Never logged.
  PG_ADMIN=$(docker exec "$PG_CONTAINER" printenv POSTGRES_USER) ||
    die "could not read POSTGRES_USER from $PG_CONTAINER (is it running?)"
  [[ -n $PG_ADMIN ]] || die "$PG_CONTAINER has an empty POSTGRES_USER"

  local now stamp cutoff db
  now=$(date +%s)
  stamp=$(date -d "@$now" +%Y%m%d-%H%M%S)
  cutoff=$(date -d "@$((now - KEEP_DAYS * 86400))" +%Y%m%d-%H%M%S)

  for db in "${DATABASES[@]}"; do
    dump_one "$db" "$stamp"
    if [[ -n $TMP ]]; then
      rm -f -- "$TMP"
      TMP=""
    fi
  done

  # Pruning runs after a failed night too: the newest dump of each database always survives, and
  # the alert below says the new one is missing.
  for db in "${DATABASES[@]}"; do
    prune "$db" "$cutoff"
  done

  if ((${#FAILURES[@]})); then
    local msg
    msg=$(printf '%s; ' "${FAILURES[@]}")
    die "${msg%; }"
  fi
  log "ok: ${SUMMARY[0]}, ${SUMMARY[1]} in $BACKUP_DIR"
}

main "$@"
