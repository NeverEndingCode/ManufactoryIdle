#!/bin/bash
# Install the nightly backup and the uptime check on the Unraid server (runbook:
# infra/unraid/README.md, "Backups and uptime").
#
#   install.sh               copy backup.sh and healthcheck.sh into User Scripts and schedule them
#   install.sh --uninstall   remove both scripts and their schedules (the backups stay)
#
# Runs as root on the server. Idempotent: rerun it after a deploy that changed either script.
# It follows the pattern already on the server: User Scripts keeps each script in
# /boot/config/plugins/user.scripts/scripts/<name>/{script,description}, and a matching
# /boot/config/plugins/dynamix/<name>.cron, which update_cron merges into root's crontab. The
# schedule is in that .cron file, not in the User Scripts page: leave it unscheduled there, or
# it runs twice.
#
# Overrides for the tests (test.sh): OPS_SRC (the checkout to copy from) and OPS_ROOT (a prefix
# for every path it writes, and for update_cron).
set -euo pipefail
umask 077

readonly SRC=${OPS_SRC:-/mnt/user/appdata/manufactory/src}
readonly ROOT=${OPS_ROOT:-}
readonly SCRIPTS=/boot/config/plugins/user.scripts/scripts
readonly CRON_DIR=/boot/config/plugins/dynamix
readonly UPDATE_CRON=/usr/local/sbin/update_cron
readonly APPDATA=/mnt/user/appdata/manufactory
readonly BACKUP_DIR=$APPDATA/backups
readonly STATE_DIR=$APPDATA/ops-state

# name | source in the repo | schedule | log | description
readonly JOBS=(
  "manufactory-backup|backup.sh|30 3 * * *|backup.log|Manufactory Idle: nightly backup of the game's two databases (manufactory, manufactory_supertokens) to $BACKUP_DIR. Installed by infra/unraid/ops/install.sh; scheduled by $CRON_DIR/manufactory-backup.cron."
  "manufactory-healthcheck|healthcheck.sh|*/5 * * * *|healthcheck.log|Manufactory Idle: uptime check every 5 minutes (site and containers), alerting once per outage. Installed by infra/unraid/ops/install.sh; scheduled by $CRON_DIR/manufactory-healthcheck.cron."
)

log() { printf '==> %s\n' "$*"; }
die() {
  printf 'install.sh: %s\n' "$*" >&2
  exit 1
}

# put <path>: writes stdin to <path> only when it differs, through a temp file in the same
# directory, and says which. A failed write removes the temp file: /boot is the flash drive.
put() {
  local path=$1 tmp
  mkdir -p -- "${path%/*}"
  tmp=$(mktemp "$path.XXXXXX")
  if ! cat >"$tmp"; then
    rm -f -- "$tmp"
    die "could not write $path"
  fi
  if cmp -s -- "$tmp" "$path"; then
    rm -f -- "$tmp"
    log "unchanged $path"
  elif mv -fT -- "$tmp" "$path"; then # -T: never into <path> when it is a directory
    log "wrote $path"
  else
    rm -f -- "$tmp"
    die "could not replace $path"
  fi
}

refresh_cron() {
  log "running $UPDATE_CRON"
  "$ROOT$UPDATE_CRON"
}

install_all() {
  local job name file schedule logfile description src cron
  for job in "${JOBS[@]}"; do
    IFS='|' read -r name file schedule logfile description <<<"$job"
    src="$SRC/infra/unraid/ops/$file"
    [[ -f $src ]] || die "$src not found (is the checkout at $SRC?)"
    bash -n "$src" || die "$src does not parse"
  done

  local dir
  for dir in "$BACKUP_DIR" "$STATE_DIR"; do
    mkdir -p -- "$ROOT$dir"
    chmod 700 -- "$ROOT$dir"
    log "directory $dir (mode 700)"
  done

  for job in "${JOBS[@]}"; do
    IFS='|' read -r name file schedule logfile description <<<"$job"
    put "$ROOT$SCRIPTS/$name/script" <"$SRC/infra/unraid/ops/$file"
    printf '%s\n' "$description" | put "$ROOT$SCRIPTS/$name/description"
    # The same shape as private-net-fw.cron: a comment, then the line. The output goes to a log
    # in ops-state, which only gets a line per backup and per change of health.
    cron="# Manufactory Idle: $name (infra/unraid/ops/$file)"$'\n'
    cron+="$schedule bash $SCRIPTS/$name/script >>$STATE_DIR/$logfile 2>&1"$'\n'
    printf '%s' "$cron" | put "$ROOT$CRON_DIR/$name.cron"
    printf '%s' "$cron" | sed 's/^/    /'
  done
  refresh_cron
  log "installed; check with: crontab -l | grep manufactory"
}

uninstall_all() {
  local job name rest path
  for job in "${JOBS[@]}"; do
    IFS='|' read -r name rest <<<"$job"
    for path in "$ROOT$CRON_DIR/$name.cron" "$ROOT$SCRIPTS/$name/script" \
      "$ROOT$SCRIPTS/$name/description"; do
      if [[ -e $path ]]; then
        rm -f -- "$path"
        log "removed $path"
      fi
    done
    # User Scripts may have left files of its own (a log): keep them and carry on, so the other
    # job is removed too and the crontab is always refreshed.
    if [[ -d $ROOT$SCRIPTS/$name ]]; then
      if rmdir -- "$ROOT$SCRIPTS/$name" 2>/dev/null; then
        log "removed $ROOT$SCRIPTS/$name/"
      else
        log "left $ROOT$SCRIPTS/$name: other files"
      fi
    fi
  done
  refresh_cron
  log "uninstalled; kept $BACKUP_DIR and $STATE_DIR"
}

main() {
  if [[ -z $ROOT ]]; then [[ $(id -u) -eq 0 ]] || die "run as root"; fi
  case ${1-} in
    "") install_all ;;
    --uninstall) uninstall_all ;;
    *)
      sed -n '4,5p' "$0" >&2
      exit 2
      ;;
  esac
}

main "$@"
