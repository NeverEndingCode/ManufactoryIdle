#!/bin/bash
# Uptime check for Manufactory Idle (runbook: infra/unraid/README.md, "Backups and uptime").
#
#   healthcheck.sh       check the site and its containers; alert on a change of state
#   healthcheck.sh -v    the same, and print the result of every check
#
# Runs as root on the server, from cron every 5 minutes (installed by install.sh). It checks:
#   - site: http://127.0.0.1:8087/api/health, and the public https URL through Cloudflare. Each
#     must answer 200 with "ok":true in the body within its timeout.
#   - the containers manufactory-api, manufactory-web and manufactory-supertokens are running.
# A check alerts once after 2 failures in a row (a deploy recreates the containers, and one slow
# answer is not an outage), then stays quiet until it passes again, which sends one recovery
# notice. State lives in /mnt/user/appdata/manufactory/ops-state. Exits 1 while anything fails.
#
# It runs on the same server, so it cannot report a whole-server outage: see the README.
#
# Overrides for the tests (test.sh): OPS_STATE_DIR, OPS_LOCK, OPS_NOTIFY, OPS_LOCAL_URL,
# OPS_PUBLIC_URL (empty skips the public check).
set -euo pipefail
umask 077

readonly STATE_DIR=${OPS_STATE_DIR:-/mnt/user/appdata/manufactory/ops-state}
# On /var (RAM), not the array: flock on Unraid's FUSE user shares is not to be relied on.
readonly LOCK=${OPS_LOCK:-/var/lock/manufactory-healthcheck.lock}
readonly NOTIFY=${OPS_NOTIFY:-/usr/local/emhttp/webGui/scripts/notify}
readonly LOCAL_URL=${OPS_LOCAL_URL:-http://127.0.0.1:8087/api/health}
readonly PUBLIC_URL=${OPS_PUBLIC_URL-https://manufactory.neverendingcode.com/api/health}
readonly LOCAL_TIMEOUT=5
readonly PUBLIC_TIMEOUT=10
readonly CONTAINERS=(manufactory-api manufactory-web manufactory-supertokens)
readonly STRIKES=2 # failures in a row before the down alert

VERBOSE=0
UNHEALTHY=0

log() { printf '%s health: %s\n' "$(date '+%F %T')" "$*"; }

notify() { # <importance> <subject> <description>
  log "$2: $3"
  "$NOTIFY" -e "Manufactory Idle uptime" -s "$2" -d "$3" -i "$1" ||
    printf 'health: %s failed\n' "$NOTIFY" >&2
}

# probe <url> <timeout>: 0 when the URL answers 200 with "ok":true; otherwise prints why.
probe() {
  local url=$1 timeout=$2 out code body
  if ! out=$(curl --silent --show-error --max-time "$timeout" --write-out '\n%{http_code}' \
    "$url" 2>&1); then
    printf 'no answer (%s)' "${out%%$'\n'*}"
    return 1
  fi
  code=${out##*$'\n'}
  body=${out%$'\n'*}
  if [[ $code != 200 ]]; then
    printf 'HTTP %s' "$code"
    return 1
  fi
  if [[ ! $body =~ \"ok\"[[:space:]]*:[[:space:]]*true ]]; then
    printf 'HTTP 200 without "ok":true'
    return 1
  fi
}

# record <key> <label> <ok|fail> <detail>: counts failures in a row in <key>.fails and marks an
# alerted outage with <key>.down, so each outage sends one alert and one recovery notice.
record() {
  local key=$1 label=$2 result=$3 detail=$4 fails=0
  local fails_file="$STATE_DIR/$key.fails" down_file="$STATE_DIR/$key.down"
  if [[ $VERBOSE -eq 1 ]]; then log "$label: $result ($detail)"; fi
  if [[ $result == ok ]]; then
    if [[ -e $down_file ]]; then
      notify normal "Manufactory Idle: $label is back" "$detail; down since $(<"$down_file")"
      rm -f -- "$down_file"
    fi
    rm -f -- "$fails_file"
    return 0
  fi
  UNHEALTHY=1
  if [[ -f $fails_file ]]; then fails=$(<"$fails_file"); fi
  [[ $fails =~ ^[0-9]+$ ]] || fails=0
  fails=$((fails + 1))
  printf '%d\n' "$fails" >"$fails_file"
  if ((fails >= STRIKES)) && [[ ! -e $down_file ]]; then
    date '+%F %T' >"$down_file"
    notify alert "Manufactory Idle: $label is down" "$detail ($fails checks in a row)"
  fi
}

check_site() {
  local local_err="" public_err="" detail
  local_err=$(probe "$LOCAL_URL" "$LOCAL_TIMEOUT") || local_err=${local_err:-failed}
  if [[ -n $PUBLIC_URL ]]; then
    public_err=$(probe "$PUBLIC_URL" "$PUBLIC_TIMEOUT") || public_err=${public_err:-failed}
  fi
  if [[ -z $local_err && -z $public_err ]]; then
    record site "the site" ok "local and public /api/health answer"
    return 0
  fi
  detail="local: ${local_err:-ok}"
  if [[ -n $PUBLIC_URL ]]; then detail+="; public: ${public_err:-ok}"; fi
  record site "the site" fail "$detail"
}

check_containers() {
  local name status
  for name in "${CONTAINERS[@]}"; do
    status=$(docker inspect -f '{{.State.Status}}' "$name" 2>/dev/null) || status=missing
    if [[ $status == running ]]; then
      record "container-$name" "$name" ok running
    else
      record "container-$name" "$name" fail "container $name is $status, not running"
    fi
  done
}

main() {
  case ${1-} in
    "") ;;
    -v) VERBOSE=1 ;;
    *)
      sed -n '4,5p' "$0" >&2
      exit 2
      ;;
  esac
  mkdir -p -- "$STATE_DIR"
  chmod 700 -- "$STATE_DIR"
  # A run that hangs past the next one is skipped quietly: the next run counts again.
  exec 9>"$LOCK"
  flock -n 9 || exit 0

  check_site
  check_containers
  exit "$UNHEALTHY"
}

main "$@"
