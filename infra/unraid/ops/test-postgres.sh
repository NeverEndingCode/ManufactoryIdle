#!/bin/bash
# backup.sh and the restore in restore.md against a real Postgres 16, on a workstation with
# podman (never on the server).
#
#   bash infra/unraid/ops/test-postgres.sh
#
# Starts a throwaway docker.io/library/postgres:16 container, creates the game's two databases
# (and `supertokens`, which must not be dumped) with a little data, runs backup.sh through a
# docker -> podman shim, then runs restore.md's own command blocks: each dump into a scratch
# database (row counts compared), the guards with DB or DUMP unset, the real restore
# (--clean --if-exists) over changed data, and the empty-database restore. The container is
# removed at exit.
set -euo pipefail

HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
readonly HERE
readonly NAME=manufactory-ops-test-$$
readonly ADMIN=opsadmin_$$ # stands in for postgresql16's POSTGRES_USER

T=$(mktemp -d)
# shellcheck disable=SC2329 # the EXIT trap
cleanup() {
  podman rm -f "$NAME" >/dev/null 2>&1 || true
  rm -rf -- "$T"
}
trap cleanup EXIT

PASS=0 FAIL=0
check() { # <description> <command...>
  local d=$1
  shift
  if "$@"; then
    PASS=$((PASS + 1))
    printf '  ok    %s\n' "$d"
  else
    FAIL=$((FAIL + 1))
    printf '  FAIL  %s\n' "$d"
  fi
}

psql_in() { # <db> <sql>: one value
  podman exec "$NAME" psql -U "$ADMIN" -d "$1" -X -qtA -v ON_ERROR_STOP=1 -c "$2"
}

printf 'starting %s\n' "$NAME"
podman run -d --name "$NAME" -e POSTGRES_USER="$ADMIN" -e POSTGRES_PASSWORD=throwaway \
  docker.io/library/postgres:16 >/dev/null
# The image's init runs a socket-only server first; TCP answers once the real one is up.
for _ in $(seq 60); do
  if podman exec "$NAME" pg_isready -h 127.0.0.1 -U "$ADMIN" -q 2>/dev/null; then break; fi
  sleep 1
done
podman exec "$NAME" pg_isready -h 127.0.0.1 -U "$ADMIN" -q

podman exec -i "$NAME" psql -U "$ADMIN" -d postgres -X -q -v ON_ERROR_STOP=1 <<'SQL'
CREATE ROLE manufactory LOGIN;
CREATE ROLE manufactory_supertokens LOGIN;
CREATE DATABASE manufactory OWNER manufactory;
CREATE DATABASE manufactory_supertokens OWNER manufactory_supertokens;
CREATE DATABASE supertokens;
SQL
podman exec -i "$NAME" psql -U "$ADMIN" -d manufactory -X -q -v ON_ERROR_STOP=1 <<'SQL'
SET ROLE manufactory;
CREATE TABLE saves (id serial PRIMARY KEY, player text NOT NULL, state jsonb NOT NULL);
CREATE TABLE events (id bigserial PRIMARY KEY, save_id int REFERENCES saves (id), at timestamptz DEFAULT now());
INSERT INTO saves (player, state) SELECT 'p' || g, jsonb_build_object('gears', g) FROM generate_series(1, 250) g;
INSERT INTO events (save_id) SELECT 1 + g % 250 FROM generate_series(1, 1000) g;
SQL
podman exec -i "$NAME" psql -U "$ADMIN" -d manufactory_supertokens -X -q -v ON_ERROR_STOP=1 <<'SQL'
SET ROLE manufactory_supertokens;
CREATE TABLE all_auth_recipe_users (user_id char(36) PRIMARY KEY, recipe_id text);
INSERT INTO all_auth_recipe_users SELECT md5(g::text)::uuid::text, 'thirdparty' FROM generate_series(1, 42) g;
SQL
podman exec -i "$NAME" psql -U "$ADMIN" -d supertokens -X -q -v ON_ERROR_STOP=1 <<'SQL'
CREATE TABLE other_app (id int);
SQL

# docker -> podman, with the container's name in place of postgresql16.
mkdir -p "$T/bin"
cat >"$T/bin/docker" <<EOF
#!/bin/bash
args=()
for a in "\$@"; do
  if [[ \$a == postgresql16 ]]; then a=$NAME; fi
  args+=("\$a")
done
# TRUNCATE=1: cut pg_dump's output 300 bytes short, inside its data, past the table of contents.
if [[ \${TRUNCATE-} == 1 && " \$* " == *" pg_dump "* ]]; then
  podman "\${args[@]}" >"$T/whole"
  head -c "\$((\$(stat -c %s "$T/whole") - 300))" "$T/whole"
  exit 0
fi
exec podman "\${args[@]}"
EOF
printf '#!/bin/bash\nprintf "%%s\\n" "$*" >>"%s"\n' "$T/notify.log" >"$T/bin/notify"
chmod +x "$T/bin/docker" "$T/bin/notify"

printf '\nbackup.sh against postgres:16\n'
RC=0
PATH=$T/bin:$PATH OPS_BACKUP_DIR=$T/backups OPS_LOCK=$T/lock OPS_NOTIFY=$T/bin/notify \
  bash "$HERE/backup.sh" >"$T/out" 2>&1 || RC=$?
sed 's/^/    /' "$T/out"
check "exits 0" test "$RC" -eq 0
check "sends no notification" test ! -e "$T/notify.log"
shopt -s nullglob
M=("$T/backups"/manufactory-*.dump)
S=("$T/backups"/manufactory_supertokens-*.dump)
O=("$T/backups"/supertokens-*.dump)
shopt -u nullglob
check "one manufactory dump" test "${#M[@]}" -eq 1
check "one manufactory_supertokens dump" test "${#S[@]}" -eq 1
check "no dump of supertokens" test "${#O[@]}" -eq 0
check "dumps are custom format (PGDMP)" test "$(head -c5 "${M[0]}")" = PGDMP
check "dumps are mode 600" test "$(stat -c %a "${M[0]}")" = 600

printf '\nbackup.sh with a dump cut short in its data\n'
mkdir -p "$T/cut"
RC=0
PATH=$T/bin:$PATH TRUNCATE=1 OPS_BACKUP_DIR=$T/cut OPS_LOCK=$T/lock OPS_NOTIFY=$T/bin/notify \
  bash "$HERE/backup.sh" >"$T/out" 2>&1 || RC=$?
sed 's/^/    /' "$T/out"
check "exits non-zero" test "$RC" -ne 0
check "keeps no dump under a final name" test -z "$(find "$T/cut" -name '*.dump')"
check "alerts that it could not be read to its end" grep -q 'could not read the dump to its end' "$T/notify.log"
rm -f "$T/notify.log"

# The restore runs restore.md's own command blocks (its 4-space indented lines), through the shim.
block() { # <text>: the code block of restore.md that contains <text>
  awk -v pat="$1" '
    /^    / { b = b substr($0, 5) "\n"; next }
    { if (b != "" && index(b, pat)) { printf "%s", b; found = 1; exit } b = "" }
    END { if (!found && b != "" && index(b, pat)) printf "%s", b }
  ' "$HERE/restore.md"
}
run_block() { # <text> [VAR=value...]: runs that block in bash with the shim, PG_ADMIN set
  local code
  code=$(block "$1")
  shift
  [[ -n $code ]] || return 99
  env PATH="$T/bin:$PATH" PG_ADMIN="$ADMIN" "$@" bash -c "$code"
}
SCRATCH_BLOCK='_restore_check" --exit-on-error'
COMPARE_BLOCK='pg_stat_user_tables'
# shellcheck disable=SC2016 # literal text of restore.md, not an expansion
DROP_SCRATCH_BLOCK='dropdb -U "${PG_ADMIN:?set PG_ADMIN}" "${DB:?set DB}_restore_check"'
REAL_BLOCK='--clean --if-exists'
EMPTY_BLOCK='REVOKE CONNECT'

printf '\nrestore.md, step 1: into a scratch database\n'
RC=0
run_block "$SCRATCH_BLOCK" DB=manufactory DUMP="${M[0]}" >"$T/out" 2>&1 || RC=$?
check "the scratch block exits 0" test "$RC" -eq 0
check "saves: 250 rows" test "$(psql_in manufactory_restore_check 'SELECT count(*) FROM saves')" = 250
check "events: 1000 rows" test "$(psql_in manufactory_restore_check 'SELECT count(*) FROM events')" = 1000
check "saves owned by manufactory" test "$(psql_in manufactory_restore_check "SELECT tableowner FROM pg_tables WHERE tablename = 'saves'")" = manufactory
check "row counts match the live database" test \
  "$(psql_in manufactory_restore_check 'SELECT count(*) FROM saves, events')" = \
  "$(psql_in manufactory 'SELECT count(*) FROM saves, events')"
RC=0
run_block "$COMPARE_BLOCK" DB=manufactory >"$T/out" 2>&1 || RC=$?
check "the compare block lists saves in both" test "$RC" -eq 0 -a "$(grep -c ' saves ' "$T/out")" -eq 2
RC=0
run_block "$SCRATCH_BLOCK" DB=manufactory_supertokens DUMP="${S[0]}" >"$T/out" 2>&1 || RC=$?
check "core users: 42 rows" test "$RC" -eq 0 -a "$(psql_in manufactory_supertokens_restore_check 'SELECT count(*) FROM all_auth_recipe_users')" = 42
run_block "$DROP_SCRATCH_BLOCK" DB=manufactory
run_block "$DROP_SCRATCH_BLOCK" DB=manufactory_supertokens
check "the drop block removes the scratch databases" test \
  "$(psql_in postgres "SELECT count(*) FROM pg_database WHERE datname LIKE '%_restore_check'")" = 0

printf '\nrestore.md, step 2: for real with --clean --if-exists\n'
psql_in manufactory "DELETE FROM events WHERE id > 10; DELETE FROM saves WHERE id > 100 AND id NOT IN (SELECT save_id FROM events)" >/dev/null
check "damage: 10 events left" test "$(psql_in manufactory 'SELECT count(*) FROM events')" = 10
# The guards: an unset DB or DUMP, or a missing file, stops the block before pg_restore runs.
RC=0
run_block "$REAL_BLOCK" DUMP="${M[0]}" >"$T/out" 2>&1 || RC=$?
check "DB unset: the block fails" test "$RC" -ne 0
check "DB unset: it says so" grep -q 'DB: set DB' "$T/out"
check "DB unset: nothing restored into the admin role's database" test \
  "$(psql_in "$ADMIN" "SELECT count(*) FROM pg_tables WHERE tablename = 'saves'")" = 0
RC=0
run_block "$REAL_BLOCK" DB=manufactory >"$T/out" 2>&1 || RC=$?
check "DUMP unset: the block fails" test "$RC" -ne 0
RC=0
run_block "$REAL_BLOCK" DB=manufactory DUMP="$T/no-such.dump" >"$T/out" 2>&1 || RC=$?
check "DUMP missing: the block fails" test "$RC" -ne 0
check "the guards left the damage alone" test "$(psql_in manufactory 'SELECT count(*) FROM events')" = 10
RC=0
run_block "$REAL_BLOCK" DB=manufactory DUMP="${M[0]}" >"$T/out" 2>&1 || RC=$?
check "the real block exits 0" test "$RC" -eq 0
check "saves back to 250" test "$(psql_in manufactory 'SELECT count(*) FROM saves')" = 250
check "events back to 1000" test "$(psql_in manufactory 'SELECT count(*) FROM events')" = 1000
check "the serial continues after the restored rows" test "$(psql_in manufactory "SELECT nextval('saves_id_seq')")" = 251

printf '\nrestore.md: into an empty database (the migrations case)\n'
RC=0
run_block "$EMPTY_BLOCK" DUMP="$T/no-such.dump" >"$T/out" 2>&1 || RC=$?
check "DUMP missing: the empty-database block fails" test "$RC" -ne 0
check "DUMP missing: manufactory is not dropped" test "$(psql_in manufactory 'SELECT count(*) FROM saves')" = 250
# Line by line, as when pasted into an interactive shell: the drop is guarded on its own line.
RC=0
while IFS= read -r line; do
  [[ $line == *dropdb* ]] || continue
  env PATH="$T/bin:$PATH" PG_ADMIN="$ADMIN" DUMP="$T/no-such.dump" bash -c "$line" >"$T/out" 2>&1 || RC=$?
done < <(block "$EMPTY_BLOCK")
check "the dropdb line alone, without a dump: manufactory stays" test \
  "$(psql_in postgres "SELECT count(*) FROM pg_database WHERE datname = 'manufactory'")" = 1
RC=0
run_block "$EMPTY_BLOCK" DUMP="${M[0]}" >"$T/out" 2>&1 || RC=$?
check "the empty-database block exits 0" test "$RC" -eq 0
check "saves: 250 rows" test "$(psql_in manufactory 'SELECT count(*) FROM saves')" = 250
check "events: 1000 rows" test "$(psql_in manufactory 'SELECT count(*) FROM events')" = 1000
check "PUBLIC may not connect" test \
  "$(psql_in postgres "SELECT has_database_privilege('public', 'manufactory', 'CONNECT')")" = f
check "supertokens untouched" test "$(psql_in supertokens 'SELECT count(*) FROM other_app')" = 0

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[[ $FAIL -eq 0 ]]
