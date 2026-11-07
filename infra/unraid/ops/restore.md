# Restoring a backup

`backup.sh` keeps 14 days of dumps in `/mnt/user/appdata/manufactory/backups/`, one per database
per night: `manufactory-YYYYMMDD-HHMMSS.dump` (the game's data: players and saves) and
`manufactory_supertokens-YYYYMMDD-HHMMSS.dump` (the game's own SuperTokens core: sign-ins). They
are `pg_dump -Fc` archives. Everything below runs as root on the server, and reads the admin role
from `postgresql16` at run time; it never touches any other database (`supertokens` belongs to
another app).

The backup folder (mode 700, dumps 600) is created by `install.sh`; run that before the first
backup. `test-postgres.sh` runs these same commands against a throwaway Postgres 16.

Every command that writes names its database with `${DB:?set DB}` and reads the dump through
`${DUMP:?set DUMP}` after a `[ -s ... ]` check: with either unset or the file missing, the command
stops before it runs. Without that, `pg_restore -d ""` would connect to the admin role's own
database and restore into it.

## 0. Set up the shell

    PG_ADMIN=$(docker exec postgresql16 printenv POSTGRES_USER)
    ls -l /mnt/user/appdata/manufactory/backups/
    DB=manufactory                     # or manufactory_supertokens
    DUMP=/mnt/user/appdata/manufactory/backups/$DB-20261106-033000.dump
    : "${PG_ADMIN:?set PG_ADMIN}" "${DB:?set DB}" "${DUMP:?set DUMP}"
    [ -s "$DUMP" ] && echo "using $DUMP" || echo "NO DUMP AT $DUMP"

## 1. Into a scratch database first

Check the dump restores, and what is in it, without touching the live database:

    [ -s "${DUMP:?set DUMP}" ] && docker exec -i postgresql16 pg_restore --list <"$DUMP" | head -20
    docker exec postgresql16 createdb -U "${PG_ADMIN:?set PG_ADMIN}" -O "${DB:?set DB}" \
      "${DB:?set DB}_restore_check"
    [ -s "${DUMP:?set DUMP}" ] && docker exec -i postgresql16 pg_restore -U "${PG_ADMIN:?set PG_ADMIN}" \
      -d "${DB:?set DB}_restore_check" --exit-on-error <"$DUMP"

Compare row counts with the live database (the tables of `manufactory`: `\dt` lists them):

    for d in "${DB:?set DB}" "${DB:?set DB}_restore_check"; do
      docker exec postgresql16 psql -U "$PG_ADMIN" -d "$d" -X -c \
        "SELECT relname, n_live_tup FROM pg_stat_user_tables ORDER BY relname"
    done

`n_live_tup` is an estimate; for exact numbers, `SELECT count(*) FROM <table>` in each. Then
drop the scratch database:

    docker exec postgresql16 dropdb -U "${PG_ADMIN:?set PG_ADMIN}" "${DB:?set DB}_restore_check"

## 2. For real

This replaces the live data with the dump's: everything since the dump is lost. Take a fresh
backup first, so the current state can be had back:

    bash /boot/config/plugins/user.scripts/scripts/manufactory-backup/script

Stop what writes to the database. For `manufactory`, the API; for `manufactory_supertokens`, the
API too (it calls the core) and the core:

    docker stop manufactory-api                            # DB=manufactory
    docker stop manufactory-api manufactory-supertokens    # DB=manufactory_supertokens

Restore in one transaction (all or nothing), dropping each object in the dump before it is
recreated:

    [ -s "${DUMP:?set DUMP}" ] && docker exec -i postgresql16 pg_restore -U "${PG_ADMIN:?set PG_ADMIN}" \
      -d "${DB:?set DB}" --clean --if-exists --single-transaction --exit-on-error <"$DUMP"

Start them again, the core before the API, and check:

    docker start manufactory-supertokens   # if it was stopped
    docker start manufactory-api
    curl -s http://127.0.0.1:8087/api/health

If `pg_restore` failed, the transaction rolled back and the database is as it was: start the
containers again and read its error.

**Migrations are forward-only.** `--clean` drops only what is in the dump, so a table that a later
migration added stays, while the migrations table goes back to the dump's. Restoring `manufactory`
from before a migration onto a database after it can then fail at the API's boot. In that case
restore into an empty database instead, with the API stopped (the drop runs only when the dump
is there; each line is guarded on its own, because a failed guard in an interactive shell stops
only its own line):

    [ -s "${DUMP:?set DUMP}" ] && docker exec postgresql16 dropdb -U "${PG_ADMIN:?set PG_ADMIN}" manufactory
    docker exec postgresql16 createdb -U "${PG_ADMIN:?set PG_ADMIN}" -O manufactory manufactory
    docker exec postgresql16 psql -U "${PG_ADMIN:?set PG_ADMIN}" -d postgres -X -c \
      "REVOKE CONNECT ON DATABASE manufactory FROM PUBLIC; GRANT CONNECT ON DATABASE manufactory TO manufactory"
    [ -s "${DUMP:?set DUMP}" ] && docker exec -i postgresql16 pg_restore -U "${PG_ADMIN:?set PG_ADMIN}" \
      -d manufactory --single-transaction --exit-on-error <"$DUMP"

and run the API image that matches the dump's date (see "Rollback" in `../README.md`).
