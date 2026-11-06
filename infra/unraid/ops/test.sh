#!/bin/bash
# Tests for backup.sh, healthcheck.sh and install.sh, against stubbed docker, curl, notify, flock
# and date on PATH, in a temp directory. Needs nothing installed beyond bash and coreutils.
#
#   bash infra/unraid/ops/test.sh
#
# test-postgres.sh runs backup.sh and a restore against a real Postgres 16 in podman.
set -euo pipefail

HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd -- "$HERE/../../.." && pwd)
readonly HERE REPO
REAL_DATE=$(command -v date)
REAL_FLOCK=$(command -v flock)
readonly REAL_DATE REAL_FLOCK

T=$(mktemp -d)
trap 'rm -rf -- "$T"' EXIT
readonly STUB=$T/stub BIN=$T/bin
mkdir -p "$STUB" "$BIN"

PASS=0 FAIL=0
ok() {
  PASS=$((PASS + 1))
  printf '  ok    %s\n' "$*"
}
bad() {
  FAIL=$((FAIL + 1))
  printf '  FAIL  %s\n' "$*"
}
check() { # <description> <command...>
  local d=$1
  shift
  if "$@"; then ok "$d"; else bad "$d"; fi
}
section() { printf '\n%s\n' "$*"; }
absent() { ! grep -q -- "$1" "$2"; }
count_lines() { if [[ -f $1 ]]; then wc -l <"$1" | tr -d ' '; else echo 0; fi; }

# ---- stubs ---------------------------------------------------------------------------------
# docker: printenv, pg_dump, pg_restore --list and inspect, steered by files in $STUB.
cat >"$BIN/docker" <<'EOF'
#!/bin/bash
printf '%s\n' "$*" >>"$STUB/docker.log"
if [[ $1 == inspect ]]; then
  name=${!#}
  if [[ -f $STUB/status-$name ]]; then cat "$STUB/status-$name"; else echo running; fi
  exit 0
fi
[[ $1 == exec ]] || exit 99
shift
[[ $1 == -i ]] && shift
[[ $1 == postgresql16 ]] || exit 98
shift
case $1 in
  printenv) echo pgadmin ;;
  pg_dump)
    db=${!#}
    [[ -f $STUB/empty ]] && exit 0
    printf 'PGDMP partial %s\n' "$db"
    [[ -f $STUB/fail-dump-$db ]] && exit 1
    printf 'rest of %s\n' "$db"
    ;;
  pg_restore)
    in=$(cat)
    [[ -f $STUB/fail-verify ]] && exit 1
    [[ $2 == -f && -f $STUB/fail-verify-data ]] && exit 1
    [[ $in == PGDMP* ]] || exit 1
    echo ";  Archive created"
    ;;
  *) exit 97 ;;
esac
EOF
# curl: the answer for a URL is in $STUB/curl-local or $STUB/curl-public, as "<code> <body>",
# or "down" for no answer.
cat >"$BIN/curl" <<'EOF'
#!/bin/bash
url=${!#}
printf '%s\n' "$url" >>"$STUB/curl.log"
case $url in
  *127.0.0.1*) f=$STUB/curl-local ;;
  *) f=$STUB/curl-public ;;
esac
answer=$(cat "$f" 2>/dev/null || echo '200 {"ok":true,"accounts":true}')
if [[ $answer == down ]]; then
  echo "curl: (7) Failed to connect" >&2
  printf '\n000'
  exit 7
fi
printf '%s\n%s' "${answer#* }" "${answer%% *}"
EOF
cat >"$BIN/notify" <<'EOF'
#!/bin/bash
printf '%s\n' "$*" >>"$STUB/notify.log"
EOF
# flock: busy when $STUB/flock-busy exists.
cat >"$BIN/flock" <<'EOF'
#!/bin/bash
[[ -f $STUB/flock-busy ]] && exit 1
exit 0
EOF
# date: `date +%s` is the fake clock in $STUB/now; everything else is the real date.
cat >"$BIN/date" <<EOF
#!/bin/bash
if [[ \$* == +%s ]]; then cat "\$STUB/now"; exit 0; fi
exec $REAL_DATE "\$@"
EOF
chmod +x "$BIN"/*
# The same stubs but the real flock, for one lock test.
readonly BIN_REAL_FLOCK=$T/bin-real-flock
mkdir -p "$BIN_REAL_FLOCK"
for f in docker curl notify date; do ln -s "$BIN/$f" "$BIN_REAL_FLOCK/$f"; done
readonly ORIG_PATH=$PATH

export STUB PATH="$BIN:$PATH"
export OPS_NOTIFY=$BIN/notify OPS_LOCK=$T/lock

NOW=$("$REAL_DATE" -d '2026-11-06 03:30:00' +%s)
stamp() { "$REAL_DATE" -d "@$1" +%Y%m%d-%H%M%S; }
days_ago() { stamp $((NOW - $1 * 86400)); }

reset() {
  rm -rf -- "${STUB:?}"/* "$T/backups" "$T/state"
  echo "$NOW" >"$STUB/now"
}

backup() { # runs backup.sh; its status in RC, its output in $T/out
  RC=0
  OPS_BACKUP_DIR=$T/backups bash "$HERE/backup.sh" >"$T/out" 2>&1 || RC=$?
}

# ---- backup.sh -----------------------------------------------------------------------------
section "backup.sh: success"
reset
backup
S=$(stamp "$NOW")
check "exits 0" test "$RC" -eq 0
check "writes manufactory-$S.dump" test -s "$T/backups/manufactory-$S.dump"
check "writes manufactory_supertokens-$S.dump" test -s "$T/backups/manufactory_supertokens-$S.dump"
check "dump files are mode 600" test "$(stat -c %a "$T/backups/manufactory-$S.dump")" = 600
check "backup dir is mode 700" test "$(stat -c %a "$T/backups")" = 700
check "leaves no temp file" test -z "$(find "$T/backups" -name '.*')"
check "dumps with the admin user read at run time" grep -q '^exec postgresql16 pg_dump -U pgadmin -Fc manufactory$' "$STUB/docker.log"
check "verifies each dump with pg_restore --list" test "$(grep -c 'pg_restore --list' "$STUB/docker.log")" -eq 2
check "and reads each dump to its end" test "$(grep -c 'pg_restore -f /dev/null' "$STUB/docker.log")" -eq 2
check "dumps no other database" test "$(grep -c pg_dump "$STUB/docker.log")" -eq 2
check "sends no notification" test ! -e "$STUB/notify.log"
check "logs a one-line summary with sizes" grep -q 'backup: ok: manufactory 1 KiB, manufactory_supertokens 1 KiB' "$T/out"
check "prints no admin user name" absent pgadmin "$T/out"

section "backup.sh: pg_dump failure"
reset
touch "$STUB/fail-dump-manufactory_supertokens"
backup
check "exits non-zero" test "$RC" -ne 0
check "creates no manufactory_supertokens dump" test -z "$(find "$T/backups" -name 'manufactory_supertokens*')"
check "leaves no temp file" test -z "$(find "$T/backups" -name '.*')"
check "keeps the good manufactory dump" test -s "$T/backups/manufactory-$S.dump"
check "sends one alert" test "$(count_lines "$STUB/notify.log")" -eq 1
check "the alert is -i alert and names the database" grep -q -- '-s Manufactory Idle: backup failed -d manufactory_supertokens: pg_dump failed -i alert' "$STUB/notify.log"

section "backup.sh: verify failure"
reset
touch "$STUB/fail-verify"
backup
check "exits non-zero" test "$RC" -ne 0
check "creates no dump under a final name" test -z "$(find "$T/backups" -name '*.dump')"
check "leaves no temp file" test -z "$(find "$T/backups" -name '.*')"
check "sends one alert naming both databases" grep -q 'manufactory: pg_restore --list could not read the dump; manufactory_supertokens: pg_restore' "$STUB/notify.log"

section "backup.sh: a dump that lists but is cut short"
reset
touch "$STUB/fail-verify-data"
backup
check "exits non-zero" test "$RC" -ne 0
check "creates no dump under a final name" test -z "$(find "$T/backups" -name '*.dump')"
check "alerts that the dump could not be read to its end" grep -q 'manufactory: pg_restore could not read the dump to its end' "$STUB/notify.log"

section "backup.sh: empty dump"
reset
touch "$STUB/empty" # a pg_dump that exits 0 but writes nothing
backup
check "exits non-zero" test "$RC" -ne 0
check "creates no dump" test -z "$(find "$T/backups" -name '*.dump')"
check "alerts that pg_dump wrote nothing" grep -q 'manufactory: pg_dump wrote nothing' "$STUB/notify.log"

section "backup.sh: retention"
reset
mkdir -p "$T/backups"
for d in 30 20 15; do touch "$T/backups/manufactory-$(days_ago "$d").dump"; done
touch "$T/backups/manufactory-$(days_ago 13).dump"
FOREIGN=(
  "supertokens-$(days_ago 30).dump"
  "manufactory-$(days_ago 30).dump.bak"
  "manufactory-notes-$(days_ago 30).dump"
  "manufactory-$(days_ago 30).sql"
  "old-manufactory-$(days_ago 30).dump"
  "README"
)
for f in "${FOREIGN[@]}"; do touch "$T/backups/$f"; done
backup
check "exits 0" test "$RC" -eq 0
check "deletes dumps older than 14 days" test -z "$(find "$T/backups" -name "manufactory-$(days_ago 30).dump" -o -name "manufactory-$(days_ago 20).dump" -o -name "manufactory-$(days_ago 15).dump")"
check "keeps a 13-day-old dump" test -e "$T/backups/manufactory-$(days_ago 13).dump"
check "keeps tonight's dumps" test -e "$T/backups/manufactory-$S.dump"
for f in "${FOREIGN[@]}"; do check "never touches $f" test -e "$T/backups/$f"; done

section "backup.sh: the newest dump survives a failing month"
reset
mkdir -p "$T/backups"
touch "$T/backups/manufactory_supertokens-$(days_ago 40).dump" \
  "$T/backups/manufactory_supertokens-$(days_ago 30).dump"
touch "$STUB/fail-dump-manufactory_supertokens"
backup
check "exits non-zero" test "$RC" -ne 0
check "deletes the older of two old dumps" test ! -e "$T/backups/manufactory_supertokens-$(days_ago 40).dump"
check "keeps the newest, 30 days old" test -e "$T/backups/manufactory_supertokens-$(days_ago 30).dump"

section "backup.sh: lock contention"
reset
touch "$STUB/flock-busy"
backup
check "exits non-zero" test "$RC" -ne 0
check "runs no pg_dump" test ! -e "$STUB/docker.log"
check "sends one warning" grep -q -- '-s Manufactory Idle: backup skipped .* -i warning' "$STUB/notify.log"
rm -f "$STUB/flock-busy"
# The same with the real flock, holding the lock in a subshell.
RC=0
(
  exec 8>"$T/lock"
  "$REAL_FLOCK" -n 8
  PATH=$BIN_REAL_FLOCK:$ORIG_PATH OPS_BACKUP_DIR=$T/backups bash "$HERE/backup.sh"
) >"$T/out" 2>&1 || RC=$?
check "real flock: a second run exits non-zero" test "$RC" -ne 0
check "real flock: the second run dumps nothing" test -z "$(find "$T/backups" -name '*.dump')"

# ---- healthcheck.sh ------------------------------------------------------------------------
health() {
  RC=0
  OPS_STATE_DIR=$T/state OPS_PUBLIC_URL=https://example.test/api/health \
    bash "$HERE/healthcheck.sh" >"$T/out" 2>&1 || RC=$?
}
alerts() { count_lines "$STUB/notify.log"; }

section "healthcheck.sh: site down and back"
reset
health
check "all up: exits 0, no notification" test "$RC" -eq 0 -a "$(alerts)" -eq 0
check "all up: logs nothing" test ! -s "$T/out"
echo '503 {"ok":false}' >"$STUB/curl-local"
health
check "down once (HTTP 503): exits 1, no alert" test "$RC" -eq 1 -a "$(alerts)" -eq 0
echo '200 {"ok":false,"accounts":true}' >"$STUB/curl-local"
health
check "down twice (200 without ok:true): one alert" test "$(alerts)" -eq 1
check "the alert is -i alert, with the reason" grep -q -- '-s Manufactory Idle: the site is down -d local: HTTP 200 without "ok":true; public: ok (2 checks in a row) -i alert' "$STUB/notify.log"
echo down >"$STUB/curl-local"
health
check "still down (no answer): no new alert" test "$RC" -eq 1 -a "$(alerts)" -eq 1
health
check "still down again: no new alert" test "$(alerts)" -eq 1
rm "$STUB/curl-local"
health
check "up: exits 0, one recovery notice" test "$RC" -eq 0 -a "$(alerts)" -eq 2
check "the recovery is -i normal" grep -q -- '-s Manufactory Idle: the site is back .* -i normal' "$STUB/notify.log"
health
check "up again: nothing new" test "$(alerts)" -eq 2

section "healthcheck.sh: one blip does not alert"
reset
echo down >"$STUB/curl-public"
health
rm "$STUB/curl-public"
health
check "fail, pass: no alert, no recovery" test "$(alerts)" -eq 0
echo down >"$STUB/curl-public"
health
check "the count restarted after the pass: still no alert" test "$(alerts)" -eq 0
health
check "the public URL down twice: one alert naming it" grep -q 'local: ok; public: no answer (curl: (7) Failed to connect)' "$STUB/notify.log"

section "healthcheck.sh: a container not running"
reset
echo exited >"$STUB/status-manufactory-supertokens"
health
check "once: exits 1, no alert" test "$RC" -eq 1 -a "$(alerts)" -eq 0
health
check "twice: one alert naming the container" grep -q -- '-s Manufactory Idle: manufactory-supertokens is down -d container manufactory-supertokens is exited, not running' "$STUB/notify.log"
check "twice: only that alert" test "$(alerts)" -eq 1
health
check "still stopped: no new alert" test "$(alerts)" -eq 1
rm "$STUB/status-manufactory-supertokens"
health
check "running again: one recovery notice" test "$RC" -eq 0 -a "$(alerts)" -eq 2
check "the state dir is mode 700" test "$(stat -c %a "$T/state")" = 700

section "healthcheck.sh: -v and the public URL off"
reset
RC=0
OPS_STATE_DIR=$T/state OPS_PUBLIC_URL="" bash "$HERE/healthcheck.sh" -v >"$T/out" 2>&1 || RC=$?
check "-v prints each check" test "$(grep -c ': ok (' "$T/out")" -eq 4
check "an empty OPS_PUBLIC_URL skips the public check" test "$(count_lines "$STUB/curl.log")" -eq 1

# ---- install.sh ----------------------------------------------------------------------------
R=$T/root
inst() {
  RC=0
  OPS_ROOT=$R OPS_SRC=$REPO bash "$HERE/install.sh" "$@" >"$T/out" 2>&1 || RC=$?
}
U=/boot/config/plugins/user.scripts/scripts
C=/boot/config/plugins/dynamix

section "install.sh: install twice, uninstall twice"
reset
rm -rf "$R"
mkdir -p "$R/usr/local/sbin" "$R$C"
printf '#!/bin/bash\necho run >>"%s"\n' "$T/update_cron.log" >"$R/usr/local/sbin/update_cron"
chmod +x "$R/usr/local/sbin/update_cron"
rm -f "$T/update_cron.log"
printf '# Re-assert private Docker network containment rules\n*/10 * * * * bash %s >/dev/null 2>&1\n' \
  "$U/private-net-firewall/script" >"$R$C/private-net-fw.cron"
cp "$R$C/private-net-fw.cron" "$T/fw.before"

inst
check "exits 0" test "$RC" -eq 0
check "copies backup.sh" cmp -s "$HERE/backup.sh" "$R$U/manufactory-backup/script"
check "copies healthcheck.sh" cmp -s "$HERE/healthcheck.sh" "$R$U/manufactory-healthcheck/script"
check "writes both descriptions" test -s "$R$U/manufactory-backup/description" -a -s "$R$U/manufactory-healthcheck/description"
EXPECTED_BACKUP_CRON="# Manufactory Idle: manufactory-backup (infra/unraid/ops/backup.sh)
30 3 * * * bash $U/manufactory-backup/script >>/mnt/user/appdata/manufactory/ops-state/backup.log 2>&1"
EXPECTED_HEALTH_CRON="# Manufactory Idle: manufactory-healthcheck (infra/unraid/ops/healthcheck.sh)
*/5 * * * * bash $U/manufactory-healthcheck/script >>/mnt/user/appdata/manufactory/ops-state/healthcheck.log 2>&1"
check "manufactory-backup.cron: 03:30 nightly" test "$(cat "$R$C/manufactory-backup.cron")" = "$EXPECTED_BACKUP_CRON"
check "manufactory-healthcheck.cron: every 5 minutes" test "$(cat "$R$C/manufactory-healthcheck.cron")" = "$EXPECTED_HEALTH_CRON"
check "cron files end in a newline" test "$(tail -c1 "$R$C/manufactory-backup.cron" | od -An -c | tr -d ' ')" = '\n'
check "creates backups and ops-state, mode 700" test "$(stat -c %a "$R/mnt/user/appdata/manufactory/backups")$(stat -c %a "$R/mnt/user/appdata/manufactory/ops-state")" = 700700
check "runs update_cron" test "$(count_lines "$T/update_cron.log")" -eq 1
check "prints what it wrote" test "$(grep -c '^==> wrote ' "$T/out")" -eq 6
check "prints the cron lines" grep -q "^    30 3 \* \* \* bash $U/manufactory-backup/script" "$T/out"
find "$R$U" "$R$C" -type f -exec md5sum {} + | sort >"$T/sum1"

inst
check "second run exits 0" test "$RC" -eq 0
check "second run writes nothing" test "$(grep -c '^==> wrote ' "$T/out")" -eq 0
check "second run reports all six unchanged" test "$(grep -c '^==> unchanged ' "$T/out")" -eq 6
find "$R$U" "$R$C" -type f -exec md5sum {} + | sort >"$T/sum2"
check "second run leaves identical files" cmp -s "$T/sum1" "$T/sum2"
check "second run leaves no temp files" test -z "$(find "$R" -name '*.??????' -newer "$T/fw.before")"
check "second run still runs update_cron" test "$(count_lines "$T/update_cron.log")" -eq 2

echo "a dump" >"$R/mnt/user/appdata/manufactory/backups/manufactory-20261101-033000.dump"
inst --uninstall
check "uninstall exits 0" test "$RC" -eq 0
check "removes both script dirs" test ! -e "$R$U/manufactory-backup" -a ! -e "$R$U/manufactory-healthcheck"
check "removes both cron files" test ! -e "$R$C/manufactory-backup.cron" -a ! -e "$R$C/manufactory-healthcheck.cron"
check "keeps the backups" test -s "$R/mnt/user/appdata/manufactory/backups/manufactory-20261101-033000.dump"
check "runs update_cron" test "$(count_lines "$T/update_cron.log")" -eq 3
inst --uninstall
check "second uninstall exits 0 and removes nothing" test "$RC" -eq 0 -a "$(grep -c '^==> removed' "$T/out")" -eq 0
check "never touches private-net-fw.cron" cmp -s "$T/fw.before" "$R$C/private-net-fw.cron"

inst --bogus
check "an unknown flag exits 2" test "$RC" -eq 2
RC=0
OPS_ROOT=$R OPS_SRC=$T/nowhere bash "$HERE/install.sh" >"$T/out" 2>&1 || RC=$?
check "a missing checkout fails before writing" test "$RC" -ne 0 -a ! -e "$R$U/manufactory-backup"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[[ $FAIL -eq 0 ]]
