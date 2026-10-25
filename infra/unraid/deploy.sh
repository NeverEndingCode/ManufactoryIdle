#!/bin/bash
# Deploy Manufactory Idle on the Unraid server (runbook: infra/unraid/README.md).
#
#   deploy.sh <git-ref>        full deploy of a pushed branch, tag or commit (steps 1-7)
#   deploy.sh --recreate       re-render the templates and recreate the containers from the
#                              images tagged :current (steps 3-6), e.g. after editing a template
#   deploy.sh --rollback <tag> point :current at an older build (a short sha from
#                              `docker image ls manufactory-api`), then --recreate
#
# Runs as root on the server. Idempotent. Secrets (the database password, the SuperTokens API
# key) are never printed, never passed on a command line and never written outside the two
# mode-600 templates on the flash drive (D-8).
#
# Containers are created here with `docker run`, not with Unraid's update_container: that script
# first `docker pull`s the template's Repository, which fails for these local-only images, and it
# then skips the container. The run is built from the rendered template itself (as dockerMan's
# xmlToCommand does) and carries the net.unraid.docker.managed=dockerman label, so the Docker tab
# shows and manages these containers with their templates.
set -euo pipefail
shopt -u patsub_replacement 2>/dev/null || true # bash 5.2: keep `&` literal in ${x//a/b}
umask 077

readonly REPO_URL=https://github.com/NeverEndingCode/ManufactoryIdle.git
readonly SRC=/mnt/user/appdata/manufactory/src
readonly TEMPLATES=/boot/config/plugins/dockerMan/templates-user
readonly AUTOSTART=/var/lib/docker/unraid-autostart
readonly NETWORK=pgnet
readonly PG_CONTAINER=postgresql16
readonly DB_NAME=manufactory # also the role's name
readonly ST_CONTAINER=SuperTokens---PostgreSQL
readonly ST_URI=http://SuperTokens---PostgreSQL:3567
readonly SITE_ORIGIN=https://manufactory.neverendingcode.com
readonly HOST_PORT=8087
readonly CLIENT_IP_HEADER=Cf-Connecting-Ip
readonly CLIENT_IP_TRUSTED_PROXIES=private_ranges
readonly API=manufactory-api
readonly WEB=manufactory-web
readonly KEEP=3 # sha-tagged builds kept per image

WORK="" # mktemp -d: env files and template backups, on Unraid's RAM-backed /tmp

log() { printf '==> %s\n' "$*"; }
die() {
  printf 'deploy.sh: %s\n' "$*" >&2
  exit 1
}
# shellcheck disable=SC2329 # the EXIT trap
cleanup() { if [[ -n $WORK ]]; then rm -rf -- "$WORK"; fi; }

usage() {
  sed -n '4,9p' "$0" >&2 || true
  exit 2
}

# ---- preflight -----------------------------------------------------------------------------
preflight() {
  [[ $(id -u) -eq 0 ]] || die "run as root"
  local cmd
  for cmd in docker git curl awk; do
    command -v "$cmd" >/dev/null || die "$cmd not found"
  done
  docker network inspect "$NETWORK" >/dev/null 2>&1 || die "docker network $NETWORK not found"
  [[ $(docker inspect -f '{{.State.Running}}' "$PG_CONTAINER" 2>/dev/null) == true ]] ||
    die "$PG_CONTAINER is not running"
  [[ $(docker inspect -f '{{.State.Running}}' "$ST_CONTAINER" 2>/dev/null) == true ]] ||
    die "$ST_CONTAINER is not running"
  [[ -d $TEMPLATES ]] || die "$TEMPLATES not found (is this Unraid?)"
}

# ---- 1. source -----------------------------------------------------------------------------
SHA="" SHORT=""
NEW_TAG="" # the build that becomes :current, moved only just before the recreate (step 5)
fetch_source() {
  local ref=$1
  if [[ ! -d $SRC/.git ]]; then
    log "cloning $REPO_URL into $SRC"
    mkdir -p "${SRC%/*}"
    git clone --quiet "$REPO_URL" "$SRC"
  fi
  log "fetching origin"
  git -C "$SRC" fetch --quiet --force --prune --tags origin '+refs/heads/*:refs/remotes/origin/*'
  # A branch name means origin's branch; anything else (a tag, a sha) as given.
  SHA=$(git -C "$SRC" rev-parse --quiet --verify "refs/remotes/origin/$ref^{commit}") ||
    SHA=$(git -C "$SRC" rev-parse --quiet --verify "$ref^{commit}") ||
    die "unknown ref '$ref' (is it pushed to origin?)"
  SHORT=$(git -C "$SRC" rev-parse --short=12 "$SHA")
  git -C "$SRC" checkout --quiet --force --detach "$SHA"
  git -C "$SRC" clean --quiet -ffdx
  log "at $SHORT: $(git -C "$SRC" log -1 --format=%s "$SHA")"
}

# ---- 2. images -----------------------------------------------------------------------------
# The context is `git archive` of the commit (D-2), so the build is exactly what was pushed.
build_images() {
  log "building $API:$SHORT"
  git -C "$SRC" archive --format=tar "$SHA" |
    docker build --pull --progress=plain -f infra/docker/Dockerfile --target api \
      -t "$API:$SHORT" -
  log "building $WEB:$SHORT"
  # The full 40-hex sha: the footer's source link accepts nothing shorter (W-25).
  git -C "$SRC" archive --format=tar "$SHA" |
    docker build --pull --progress=plain -f infra/docker/Dockerfile --target web \
      --build-arg "SOURCE_COMMIT=$SHA" -t "$WEB:$SHORT" -
  NEW_TAG=$SHORT
}

# ---- 3. database ---------------------------------------------------------------------------
# The admin role is the container's own POSTGRES_USER (it can create roles and databases), read
# at run time so no name is in the repo. Never logged.
PG_ADMIN=""
pg_admin() {
  PG_ADMIN=$(docker exec "$PG_CONTAINER" printenv POSTGRES_USER) ||
    die "$PG_CONTAINER has no POSTGRES_USER in its env"
  [[ -n $PG_ADMIN ]] || die "$PG_CONTAINER has an empty POSTGRES_USER"
}
psql_su() {
  docker exec -i "$PG_CONTAINER" psql -U "$PG_ADMIN" -d postgres -X -q -v ON_ERROR_STOP=1 "$@"
}

xml_escape() {
  local s=$1
  s=${s//"&"/"&amp;"}
  s=${s//"<"/"&lt;"}
  s=${s//">"/"&gt;"}
  s=${s//'"'/"&quot;"}
  s=${s//"'"/"&apos;"}
  printf '%s' "$s"
}
xml_unescape() {
  local s=$1
  s=${s//"&lt;"/"<"}
  s=${s//"&gt;"/">"}
  s=${s//"&quot;"/'"'}
  s=${s//"&apos;"/"'"}
  s=${s//"&amp;"/"&"}
  printf '%s' "$s"
}

# A <Config Target="$2"> element's value in template file $1 (empty when absent).
config_value() {
  local line
  [[ -f $1 ]] || return 0
  while IFS= read -r line; do
    if [[ $line == *'<Config '*"Target=\"$2\""* ]]; then
      line=${line#*>}
      xml_unescape "${line%</Config>*}"
      return 0
    fi
  done <"$1"
}

DB_PASSWORD=""
ensure_database() {
  # Keep the password the API template already holds; generate one only without it.
  local url new=false role_exists err
  pg_admin
  url=$(config_value "$TEMPLATES/my-$API.xml" DATABASE_URL)
  if [[ $url =~ ^postgres(ql)?://$DB_NAME:([0-9a-f]+)@ ]]; then
    DB_PASSWORD=${BASH_REMATCH[2]}
  else
    DB_PASSWORD=$(od -An -tx1 -N24 /dev/urandom | tr -d ' \n') # 48 hex: URL-safe
    [[ ${#DB_PASSWORD} -eq 48 ]] || die "could not generate a password"
    new=true
  fi

  role_exists=$(psql_su -tA -c "SELECT 1 FROM pg_roles WHERE rolname = '$DB_NAME'" </dev/null)
  # The password goes over psql's stdin, never argv. It is sent only when it is new or the role
  # is, so a redeploy never puts it in a statement (and so in a log_statement=ddl server log).
  if [[ $new == true || $role_exists != 1 ]]; then
    log "setting up role $DB_NAME on $PG_CONTAINER"
    if ! err=$(
      psql_su 2>&1 >/dev/null <<SQL
\set pw '$DB_PASSWORD'
SELECT 'CREATE ROLE $DB_NAME LOGIN' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '$DB_NAME') \gexec
ALTER ROLE $DB_NAME WITH LOGIN PASSWORD :'pw';
SQL
    ); then
      printf '%s\n' "${err//"$DB_PASSWORD"/<redacted>}" >&2
      die "creating role $DB_NAME failed"
    fi
  fi
  if ! err=$(
    psql_su 2>&1 >/dev/null <<SQL
SELECT 'CREATE DATABASE $DB_NAME OWNER $DB_NAME' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '$DB_NAME') \gexec
SELECT 'ALTER DATABASE $DB_NAME OWNER TO $DB_NAME' FROM pg_database WHERE datname = '$DB_NAME' AND pg_get_userbyid(datdba) <> '$DB_NAME' \gexec
SQL
  ); then
    printf '%s\n' "$err" >&2
    die "creating database $DB_NAME, owned by $DB_NAME, failed"
  fi
}

# ---- 4. templates --------------------------------------------------------------------------
supertokens_key() {
  local line key=""
  local -a env
  mapfile -t env < <(docker inspect "$ST_CONTAINER" --format '{{range .Config.Env}}{{println .}}{{end}}')
  for line in "${env[@]}"; do
    if [[ $line == API_KEYS=* ]]; then
      key=${line#API_KEYS=}
      key=${key%%,*}
    fi
  done
  [[ -n $key ]] || die "$ST_CONTAINER has no API_KEYS in its env"
  printf '%s' "$key"
}

pgnet_subnet() {
  local s
  for s in $(docker network inspect "$NETWORK" -f '{{range .IPAM.Config}}{{.Subnet}} {{end}}'); do
    if [[ $s == *.*/* ]]; then
      printf '%s' "$s"
      return 0
    fi
  done
  die "$NETWORK has no IPv4 subnet"
}

# render <name> KEY=VALUE...: $SRC/infra/unraid/templates/my-<name>.xml with @@KEY@@ filled in
# (XML-escaped), written atomically to $TEMPLATES/my-<name>.xml. <Config> lines of the old
# rendered file whose Target the new one lacks (a variable added to the file by hand, such as the
# SMTP ones) are carried over. The old file is kept in $WORK for a rollback.
render() {
  local name=$1 kv key val line target out extras="" tmp
  shift
  local src=$SRC/infra/unraid/templates/my-$name.xml dst=$TEMPLATES/my-$name.xml
  [[ -f $src ]] || die "$src not found"
  out=$(<"$src")
  for kv in "$@"; do
    key=${kv%%=*}
    val=$(xml_escape "${kv#*=}")
    out=${out//"@@$key@@"/"$val"}
  done
  [[ $out != *@@[A-Z_]*@@* ]] || die "my-$name.xml has an unfilled placeholder"
  if [[ -f $dst ]]; then
    cp -p -- "$dst" "$WORK/my-$name.xml.prev"
    while IFS= read -r line; do
      [[ $line == *'<Config '* && $line =~ [[:space:]]Target=\"([^\"]*)\" ]] || continue
      target=${BASH_REMATCH[1]}
      [[ $out == *"Target=\"$target\""* ]] || extras+="$line"$'\n'
    done <"$dst"
    [[ -z $extras ]] || out=${out/"</Container>"/"$extras</Container>"}
  fi
  tmp=$(mktemp "$TEMPLATES/.my-$name.XXXXXX")
  printf '%s\n' "$out" >"$tmp"
  chmod 600 "$tmp" 2>/dev/null || true # /boot is FAT: root-only by its mount options
  mv -f -- "$tmp" "$dst"
  log "rendered $dst"
}

render_templates() {
  local key subnet
  key=$(supertokens_key)
  subnet=$(pgnet_subnet)
  render "$API" \
    "DATABASE_URL=postgres://$DB_NAME:$DB_PASSWORD@$PG_CONTAINER:5432/$DB_NAME" \
    "SUPERTOKENS_CONNECTION_URI=$ST_URI" \
    "SUPERTOKENS_API_KEY=$key" \
    "SITE_ORIGIN=$SITE_ORIGIN" \
    "TRUST_PROXY=$subnet"
  render "$WEB" \
    "HOST_PORT=$HOST_PORT" \
    "CLIENT_IP_HEADER=$CLIENT_IP_HEADER" \
    "CLIENT_IP_TRUSTED_PROXIES=$CLIENT_IP_TRUSTED_PROXIES"
}

# ---- 5. containers -------------------------------------------------------------------------
xml_text() { # <tag> text of line $1, or nothing
  local v=${1#*<"$2">}
  [[ $v != "$1" ]] || return 0
  xml_unescape "${v%%</"$2">*}"
}
xml_attr() {
  [[ $1 =~ [[:space:]]$2=\"([^\"]*)\" ]] || return 0
  xml_unescape "${BASH_REMATCH[1]}"
}

# The `docker run` arguments for a rendered template, into RUN_ARGS, as dockerMan's
# xmlToCommand builds them. Variables go through an --env-file (mode 600, in $WORK, removed at
# exit), so no value is on a command line. A malformed template dies here, before anything is
# removed.
RUN_ARGS=()
prepare_run() {
  local file=$1 line name="" repo="" net="" webui="" icon="" extra="" type target mode value
  local envfile
  local -a args=() extras=()
  envfile=$(mktemp "$WORK/env.XXXXXX")
  while IFS= read -r line; do
    case $line in
    *'<Name>'*) name=$(xml_text "$line" Name) ;;
    *'<Repository>'*) repo=$(xml_text "$line" Repository) ;;
    *'<Network>'*) net=$(xml_text "$line" Network) ;;
    *'<WebUI>'*) webui=$(xml_text "$line" WebUI) ;;
    *'<Icon>'*) icon=$(xml_text "$line" Icon) ;;
    *'<ExtraParams>'*) extra=$(xml_text "$line" ExtraParams) ;;
    *'<Config '*'</Config>'*)
      type=$(xml_attr "$line" Type)
      target=$(xml_attr "$line" Target)
      mode=$(xml_attr "$line" Mode)
      value=${line#*>}
      value=$(xml_unescape "${value%</Config>*}")
      [[ -n $value ]] || continue # empty: unset, as the image's default
      case $type in
      Variable) printf '%s=%s\n' "$target" "$value" >>"$envfile" ;;
      Port) args+=(-p "$value:$target/${mode:-tcp}") ;;
      Path) args+=(-v "$value:$target${mode:+:$mode}") ;;
      Label) args+=(-l "$target=$value") ;;
      Device) args+=(--device "$value") ;;
      *) die "$file: unsupported Config Type '$type'" ;;
      esac
      ;;
    esac
  done <"$file"
  [[ -n $name && -n $repo && -n $net ]] || die "$file: no Name, Repository or Network"
  [[ -z $extra ]] || read -ra extras <<<"$extra"
  args+=(-l net.unraid.docker.managed=dockerman)
  [[ -z $webui ]] || args+=(-l "net.unraid.docker.webui=$webui")
  [[ -z $icon ]] || args+=(-l "net.unraid.docker.icon=$icon")
  [[ ${file##*/} == "my-$name.xml" ]] || die "$file: its Name is $name"
  RUN_ARGS=(-d --name "$name" --net "$net" --env-file "$envfile" "${args[@]}" "${extras[@]}" "$repo")
}

# Called under `if` (recreate), where set -e is off: every failure returns explicitly. The
# arguments are built first, then the old container goes (-v: with Caddy's anonymous /data and
# /config volumes, which would otherwise pile up), then the new one runs.
replace_container() {
  local name=$1
  prepare_run "$TEMPLATES/my-$name.xml"
  docker rm -fv "$name" >/dev/null 2>&1 || true
  docker run "${RUN_ARGS[@]}" >/dev/null || return 1
  log "started $name ($(docker inspect -f '{{.Config.Image}} {{printf "%.19s" .Image}}' "$name"))"
}

wait_healthy() { # the image's HEALTHCHECK (probing every 2s while starting)
  local name=$1 i status restarts
  for ((i = 0; i < 75; i++)); do
    status=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$name" 2>/dev/null) ||
      status=missing
    restarts=$(docker inspect -f '{{.RestartCount}}' "$name" 2>/dev/null) || restarts=0
    case $status in
    healthy | running) return 0 ;; # running: an image with no HEALTHCHECK (smoke decides)
    unhealthy | exited | dead | missing) break ;;
    esac
    [[ $restarts -eq 0 ]] || break
    sleep 2
  done
  log "$name is $status (restarts: $restarts); its last log lines:"
  docker logs --tail 30 "$name" 2>&1 || true
  return 1
}

# ---- 6. smoke test -------------------------------------------------------------------------
# Through the published port, so through Caddy. /api/health's "accounts":true says only that the
# SuperTokens env is set (the SDK contacts no core until a request needs one), so a second probe
# asks the core something: EmailPassword's email-exists lookup (supertokens-node 24,
# /auth/emailpassword/email/exists) answers {"status":"OK",...} only when the core accepted the
# API key and speaks the SDK's interface.
smoke() {
  local base=http://127.0.0.1:$HOST_PORT body="" i
  for ((i = 0; i < 30; i++)); do
    if body=$(curl -fsS --max-time 5 "$base/api/health" 2>/dev/null); then break; fi
    body=""
    sleep 2
  done
  if [[ -z $body ]]; then
    log "no answer from $base/api/health"
    return 1
  fi
  log "health: $body"
  if [[ $body != *'"accounts":true'* ]]; then
    log "the API answers but accounts are off"
    return 1
  fi
  if ! body=$(curl -fsS --max-time 15 "$base/auth/emailpassword/email/exists?email=smoke@example.invalid" 2>&1); then
    log "the SuperTokens probe failed: $body"
    return 1
  fi
  if [[ $body != *'"status":"OK"'* ]]; then
    log "the SuperTokens probe answered: $body"
    return 1
  fi
  log "SuperTokens core: $body"
}

start_both() {
  replace_container "$API" && wait_healthy "$API" &&
    replace_container "$WEB" && wait_healthy "$WEB" && smoke
}

# Point :current at NEW_TAG (a fresh build, or --rollback's tag), if any.
promote() {
  [[ -n $NEW_TAG ]] || return 0
  docker tag "$API:$NEW_TAG" "$API:current"
  docker tag "$WEB:$NEW_TAG" "$WEB:current"
  log ":current is now $NEW_TAG"
}

# Steps 5 and 6. On failure, put back what ran before: its image (by ID, retagged :current) and
# its template, then fail. Migrations are forward-only, so a rollback across a migration needs
# care (README, "Rollback").
recreate() {
  local old_api old_web
  old_api=$(docker inspect -f '{{.Image}}' "$API" 2>/dev/null) || old_api=""
  old_web=$(docker inspect -f '{{.Image}}' "$WEB" 2>/dev/null) || old_web=""
  if start_both; then
    return 0
  fi
  if [[ -z $old_api || -z $old_web ]]; then
    die "the new containers failed, and nothing ran before to roll back to"
  fi
  log "the new containers failed; rolling back"
  local f
  for f in "$API" "$WEB"; do
    [[ ! -f $WORK/my-$f.xml.prev ]] || cp -p -- "$WORK/my-$f.xml.prev" "$TEMPLATES/my-$f.xml"
  done
  docker tag "$old_api" "$API:current"
  docker tag "$old_web" "$WEB:current"
  if start_both; then
    die "deploy failed; rolled back to the previous images, which are healthy"
  fi
  die "deploy failed, and so did the rollback; see docker logs $API / $WEB"
}

ensure_autostart() {
  local name
  [[ -f $AUTOSTART ]] || : >"$AUTOSTART"
  [[ ! -s $AUTOSTART || -z $(tail -c1 "$AUTOSTART") ]] || printf '\n' >>"$AUTOSTART"
  for name in "$API" "$WEB"; do
    if ! awk '{print $1}' "$AUTOSTART" | grep -qxF "$name"; then
      printf '%s\n' "$name" >>"$AUTOSTART"
      log "added $name to Unraid autostart"
    fi
  done
}

# ---- 7. prune ------------------------------------------------------------------------------
prune_images() {
  local repo tag
  for repo in "$API" "$WEB"; do
    docker image ls "$repo" --format '{{.CreatedAt}}'$'\t''{{.Tag}}' | sort -r |
      awk -F'\t' '$2 != "current" && $2 != "<none>" { print $2 }' | tail -n "+$((KEEP + 1))" |
      while IFS= read -r tag; do
        if docker rmi "$repo:$tag" >/dev/null 2>&1; then
          log "pruned $repo:$tag"
        fi
      done
  done
}

# ---- main ----------------------------------------------------------------------------------
main() {
  [[ $# -ge 1 ]] || usage
  preflight
  WORK=$(mktemp -d)
  trap cleanup EXIT
  if command -v flock >/dev/null; then
    mkdir -p /var/lock
    exec 9>/var/lock/manufactory-deploy.lock
    flock -n 9 || die "another deploy is running"
  fi

  case $1 in
  --recreate)
    [[ $# -eq 1 ]] || usage
    [[ -d $SRC/.git ]] || die "no checkout at $SRC; run a full deploy first"
    ;;
  --rollback)
    [[ $# -eq 2 ]] || usage
    docker image inspect "$API:$2" "$WEB:$2" >/dev/null 2>&1 ||
      die "no $API:$2 / $WEB:$2 image (see: docker image ls $API)"
    NEW_TAG=$2
    ;;
  -*) usage ;;
  *)
    [[ $# -eq 1 ]] || usage
    fetch_source "$1"
    build_images
    ;;
  esac

  ensure_database
  render_templates
  # Only now: a failure above leaves :current, and the running game, on the old images.
  promote
  recreate
  ensure_autostart
  if [[ $1 != -* ]] && ! prune_images; then
    log "warning: pruning old images failed; the deploy itself succeeded"
  fi
  log "deployed ${SHORT:-:current} ($1) at $SITE_ORIGIN"
}

# Everything runs from main, parsed whole before it starts: step 1 rewrites the checkout this
# script may be running from.
main "$@"
exit
