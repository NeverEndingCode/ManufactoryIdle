#!/bin/bash
# backup.sh and the restore in restore.md against a real Postgres 16, on a workstation with
# podman (never on the server).
#
#   bash infra/unraid/ops/test-postgres.sh
#
# Starts a throwaway docker.io/library/postgres:16 container, creates the game's two databases
# (and `supertokens`, which must not be dumped) with a little data, runs backup.sh through a
# docker -> podman shim, restores each dump into a scratch database and compares row counts,
# then does the real restore (--clean --if-exists) over changed data. The container is removed at
# exit.
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

# restore.md, step 1: into a scratch database, read from stdin.
printf '\nrestore into a scratch database\n'
psql_in postgres "CREATE DATABASE manufactory_restore_check OWNER manufactory"
podman exec -i "$NAME" pg_restore -U "$ADMIN" -d manufactory_restore_check --exit-on-error \
  <"${M[0]}"
check "saves: 250 rows" test "$(psql_in manufactory_restore_check 'SELECT count(*) FROM saves')" = 250
check "events: 1000 rows" test "$(psql_in manufactory_restore_check 'SELECT count(*) FROM events')" = 1000
check "saves owned by manufactory" test "$(psql_in manufactory_restore_check "SELECT tableowner FROM pg_tables WHERE tablename = 'saves'")" = manufactory
check "row counts match the live database" test \
  "$(psql_in manufactory_restore_check 'SELECT count(*) FROM saves, events')" = \
  "$(psql_in manufactory 'SELECT count(*) FROM saves, events')"
psql_in postgres "CREATE DATABASE manufactory_supertokens_restore_check OWNER manufactory_supertokens"
podman exec -i "$NAME" pg_restore -U "$ADMIN" -d manufactory_supertokens_restore_check \
  --exit-on-error <"${S[0]}"
check "core users: 42 rows" test "$(psql_in manufactory_supertokens_restore_check 'SELECT count(*) FROM all_auth_recipe_users')" = 42
psql_in postgres "DROP DATABASE manufactory_restore_check"
psql_in postgres "DROP DATABASE manufactory_supertokens_restore_check"

# restore.md, step 2: over the live database, after damage.
printf '\nrestore for real with --clean --if-exists\n'
psql_in manufactory "DELETE FROM events WHERE id > 10; DELETE FROM saves WHERE id > 100 AND id NOT IN (SELECT save_id FROM events)" >/dev/null
check "damage: 10 events left" test "$(psql_in manufactory 'SELECT count(*) FROM events')" = 10
podman exec -i "$NAME" pg_restore -U "$ADMIN" -d manufactory --clean --if-exists \
  --single-transaction --exit-on-error <"${M[0]}"
check "saves back to 250" test "$(psql_in manufactory 'SELECT count(*) FROM saves')" = 250
check "events back to 1000" test "$(psql_in manufactory 'SELECT count(*) FROM events')" = 1000
check "the serial continues after the restored rows" test "$(psql_in manufactory "SELECT nextval('saves_id_seq')")" = 251
printf '\nrestore into an empty database (the migrations case)\n'
psql_in postgres "DROP DATABASE manufactory"
psql_in postgres "CREATE DATABASE manufactory OWNER manufactory"
psql_in postgres "REVOKE CONNECT ON DATABASE manufactory FROM PUBLIC; GRANT CONNECT ON DATABASE manufactory TO manufactory"
podman exec -i "$NAME" pg_restore -U "$ADMIN" -d manufactory --single-transaction \
  --exit-on-error <"${M[0]}"
check "saves: 250 rows" test "$(psql_in manufactory 'SELECT count(*) FROM saves')" = 250
check "events: 1000 rows" test "$(psql_in manufactory 'SELECT count(*) FROM events')" = 1000
check "supertokens untouched" test "$(psql_in supertokens 'SELECT count(*) FROM other_app')" = 0

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[[ $FAIL -eq 0 ]]
