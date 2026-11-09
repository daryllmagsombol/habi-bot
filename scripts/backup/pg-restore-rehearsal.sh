#!/usr/bin/env bash
#
# pg-restore-rehearsal.sh — prove that an encrypted backup restores, without
# touching the live database.
#
# The archive is age ciphertext. The script verifies the ciphertext checksum
# (unless explicitly skipped), decrypts it with an owner-supplied private key,
# creates a disposable database whose name matches habi_rehearsal_*, restores
# the decrypted archive into it, checks expected tables and row counts, prints
# PASS/FAIL, and always drops the disposable database and its temp files —
# including on failure or interrupt. The decrypted plaintext and any stdin
# identity are staged in a private temp directory and removed with it.
#
# The private key is supplied at invocation (--identity FILE or --identity -);
# it is never read from the archive directory, committed to the repository, or
# placed in an environment variable.
#
# It refuses to restore over any database name that is not provably disposable.
# It does not "clean up" by dropping whatever database happens to be named on
# the command line; the name must match the disposable pattern and must not be
# the source database, postgres, template0, or template1.
#
# Compatibility: bash 3.2+ (macOS) and bash 5 (Linux), PostgreSQL 14+ client,
# age 1.x.
#
# See docs/runbooks/backups.md for the operational procedure.
set -euo pipefail

readonly PROG=${0##*/}
readonly DISPOSABLE_PREFIX='habi_rehearsal_'

PGHOST=${PGHOST:-127.0.0.1}
PGPORT=${PGPORT:-5432}
PGUSER=${PGUSER:-habi}
PGDATABASE=${PGDATABASE:-habi}
MAINTENANCE_DB=${MAINTENANCE_DB:-postgres}

ARCHIVE=''
CHECKSUM_FILE=''
EXPECT_FILE=''
TARGET_DB=''
IDENTITY=''
IDENTITY_SOURCE=''
PLAINTEXT=''
SKIP_CHECKSUM=0
NO_OWNER=0

EXPECT_TABLES=()

usage() {
  cat <<'EOF'
Usage: pg-restore-rehearsal.sh --archive FILE [options]

Restore a custom-format backup into a disposable database and assert contents.

Required:
  --archive FILE        encrypted age archive to rehearse (usually *.dump.age)
  --identity FILE       age private key file; or '-' to read it from stdin.
                        Required: archives are encrypted and the key is
                        owner-held, never stored beside them.
  --expect TABLE=ROWS   expected table and exact row count (repeatable)
  --expect-file FILE    file of "TABLE=ROWS" lines; '#' comments and blank
                        lines are ignored

Options:
  --checksum FILE       checksum sidecar (default: <archive>.sha256)
  --database NAME       disposable database name (default: habi_rehearsal_<random>);
                        must match habi_rehearsal_[a-z0-9_]{6,}
  --host HOST           database host        (env PGHOST, default 127.0.0.1)
  --port PORT           database port        (env PGPORT, default 5432)
  --user NAME           database user        (env PGUSER)
  --maintenance-db NAME database used to create/drop the disposable one
                        (env MAINTENANCE_DB, default postgres)
  --no-owner            restore without ownership (only when roles are absent;
                        discards ownership information from the backup)
  --no-checksum         skip checksum verification (loudly warns; not recommended)
  --help                print this help

Decryption:
  The archive is age ciphertext. Supply the owner-held private key at
  invocation. The key is never read from the archive directory, a committed
  file, or an environment variable. With --identity -, pipe the key on stdin;
  it is staged in a mode-0600 temp file inside the rehearsal's private working
  directory and removed with it.

Authentication:
  Export PGPASSWORD, or point PGPASSFILE at a mode-0600 password file, or rely
  on ~/.pgpass. There is no --password flag on purpose.

Assertions:
  Every expectation is checked: the table must exist and count(*) must equal the
  expected number. Table names accept schema.table and must be lowercase or
  unquoted-safe; arbitrary SQL is never executed from an expectation file.

Exit codes:
  0  restore succeeded and every assertion passed; disposable DB removed
  1  decryption, checksum, restore, or an assertion failed; disposable DB removed
  2  usage error, missing identity, or unsafe target database name; nothing created
EOF
}

die() {
  printf '%s: error: %s\n' "$PROG" "$*" >&2
  exit "${EXIT_CODE:-1}"
}

info() {
  printf '%s: %s\n' "$PROG" "$*"
}

warn() {
  printf '%s: warning: %s\n' "$PROG" "$*" >&2
}

need_value() {
  [[ $# -ge 2 && -n ${2:-} ]] || die "option $1 requires a value"
}

trim() {
  local value=$1
  value=${value#"${value%%[![:space:]]*}"}
  value=${value%"${value##*[![:space:]]}"}
  printf '%s' "$value"
}

while [[ $# -gt 0 ]]; do
  case $1 in
    --archive)
      need_value "$@"
      ARCHIVE=$2
      shift 2
      ;;
    --checksum)
      need_value "$@"
      CHECKSUM_FILE=$2
      shift 2
      ;;
    --identity | --identity-file)
      need_value "$@"
      IDENTITY=$2
      shift 2
      ;;
    --expect)
      need_value "$@"
      EXPECT_TABLES+=("$2")
      shift 2
      ;;
    --expect-file)
      need_value "$@"
      EXPECT_FILE=$2
      shift 2
      ;;
    --database)
      need_value "$@"
      TARGET_DB=$2
      shift 2
      ;;
    --host)
      need_value "$@"
      PGHOST=$2
      shift 2
      ;;
    --port)
      need_value "$@"
      PGPORT=$2
      shift 2
      ;;
    --user | --username)
      need_value "$@"
      PGUSER=$2
      shift 2
      ;;
    --maintenance-db)
      need_value "$@"
      MAINTENANCE_DB=$2
      shift 2
      ;;
    --no-owner)
      NO_OWNER=1
      shift
      ;;
    --no-checksum)
      SKIP_CHECKSUM=1
      shift
      ;;
    --help | -h)
      usage
      exit 0
      ;;
    *)
      die "unknown option: $1 (try --help)"
      ;;
  esac
done

EXIT_CODE=2
[[ -n $ARCHIVE ]] || die "missing required --archive FILE"
[[ -f $ARCHIVE && -r $ARCHIVE ]] || die "archive is not a readable file: $ARCHIVE"

for tool in pg_restore psql age; do
  command -v "$tool" >/dev/null 2>&1 || die "required tool not found on PATH: $tool"
done

[[ -n $IDENTITY ]] ||
  die "no decryption identity. Pass --identity FILE with the owner-held age private key, or --identity - to pipe it on stdin. The key is never stored beside the archive."
if [[ $IDENTITY != '-' ]]; then
  [[ -f $IDENTITY && -r $IDENTITY ]] || die "identity file is not readable: $IDENTITY"
fi

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    die "no SHA-256 tool found: install sha256sum (coreutils) or shasum (Perl)"
  fi
}

file_mode() {
  case $(uname -s) in
    Darwin) stat -f '%Lp' "$1" 2>/dev/null || true ;;
    *) stat -c '%a' "$1" 2>/dev/null || true ;;
  esac
}

is_disposable_db_name() {
  local name=$1

  case $name in
    "$DISPOSABLE_PREFIX"*) ;;
    *) return 1 ;;
  esac

  printf '%s' "$name" | grep -Eq '^habi_rehearsal_[a-z0-9_]{6,}$' || return 1

  case $name in
    postgres | template0 | template1 | "$PGDATABASE") return 1 ;;
  esac

  return 0
}

random_suffix() {
  if [[ -r /dev/urandom ]]; then
    od -An -N8 -tx1 /dev/urandom | tr -d ' \n' | cut -c1-12
  else
    printf '%s%s' "$(date -u +%s)" "$$" | cksum | awk '{print $1}'
  fi
}

# Load expectations from the optional file, then validate every entry.
if [[ -n $EXPECT_FILE ]]; then
  [[ -r $EXPECT_FILE ]] || die "expectation file is not readable: $EXPECT_FILE"

  while IFS= read -r line || [[ -n $line ]]; do
    line=$(trim "${line%%#*}")
    [[ -n $line ]] || continue
    EXPECT_TABLES+=("$line")
  done <"$EXPECT_FILE"
fi

[[ ${#EXPECT_TABLES[@]} -gt 0 ]] ||
  die "no expectations: pass at least one --expect TABLE=ROWS or --expect-file FILE (a rehearsal without assertions proves nothing)"

EXPECT_NAMES=()
EXPECT_ROWS=()
for entry in "${EXPECT_TABLES[@]}"; do
  [[ $entry == *=* ]] || die "invalid expectation '$entry': expected TABLE=ROWS"
  table=$(trim "${entry%%=*}")
  rows=$(trim "${entry##*=}")

  [[ -n $table ]] || die "invalid expectation '$entry': empty table name"
  [[ $rows =~ ^[0-9]+$ ]] || die "invalid expectation '$entry': row count must be a non-negative integer"
  printf '%s' "$table" | grep -Eq '^[a-z_][a-z0-9_$]*(\.[a-z_][a-z0-9_$]*)?$' ||
    die "invalid table name '$table': use lowercase unquoted-safe schema.table"

  EXPECT_NAMES+=("$table")
  EXPECT_ROWS+=("$rows")
done

if [[ -z $TARGET_DB ]]; then
  TARGET_DB="${DISPOSABLE_PREFIX}$(random_suffix)"
fi

if ! is_disposable_db_name "$TARGET_DB"; then
  die "refusing to restore over '$TARGET_DB': target must match ${DISPOSABLE_PREFIX}[a-z0-9_]{6,}, must not be the source database ($PGDATABASE), postgres, template0, or template1. Nothing was created."
fi

# Resolve a non-interactive password source. Values are never printed.
AUTH_MODE=''
if [[ -n ${PGPASSWORD:-} ]]; then
  AUTH_MODE='PGPASSWORD environment variable'
else
  if [[ -z ${PGPASSFILE:-} ]]; then
    if [[ -r ${HOME:-}/.pgpass ]]; then
      PGPASSFILE="$HOME/.pgpass"
      export PGPASSFILE
    fi
  fi
  [[ -n ${PGPASSFILE:-} && -r ${PGPASSFILE:-} ]] ||
    die "no password source. Export PGPASSWORD, set PGPASSFILE, or create a mode-0600 ~/.pgpass (never pass a password as an argument)"
  AUTH_MODE=".pgpass file: $PGPASSFILE"
fi

export PGCONNECT_TIMEOUT=${PGCONNECT_TIMEOUT:-10}

PSQL=(psql --no-password --no-psqlrc --quiet --tuples-only --no-align --set ON_ERROR_STOP=1
  --host "$PGHOST" --port "$PGPORT" --username "$PGUSER")

psql_admin() {
  "${PSQL[@]}" --dbname "$MAINTENANCE_DB" "$@"
}

psql_target() {
  "${PSQL[@]}" --dbname "$TARGET_DB" "$@"
}

WORK_DIR=''
CREATED_DB=0
RESTORE_SECONDS=0
DECLARED_FAILURES=0

query() {
  local db=$1
  local sql=$2

  if [[ $db == 'maintenance' ]]; then
    psql_admin --command "$sql"
  else
    psql_target --command "$sql"
  fi
}

db_exists() {
  local name=$1
  local result
  result=$(psql_admin --command "SELECT 1 FROM pg_database WHERE datname = '$name'")
  [[ $result == '1' ]]
}

drop_target_db() {
  if [[ $CREATED_DB -ne 1 ]]; then
    return 0
  fi

  psql_admin --command "DROP DATABASE IF EXISTS \"$TARGET_DB\" WITH (FORCE)" >/dev/null 2>&1 ||
    psql_admin --command "DROP DATABASE IF EXISTS \"$TARGET_DB\"" >/dev/null 2>&1 ||
    {
      warn "could not drop disposable database $TARGET_DB; inspect it manually"
      return 1
    }

  if db_exists "$TARGET_DB"; then
    warn "disposable database $TARGET_DB still exists after DROP"
    return 1
  fi

  CREATED_DB=0
  info "cleanup: dropped disposable database $TARGET_DB"
  return 0
}

cleanup() {
  local status=$?
  local cleanup_failed=0

  drop_target_db || cleanup_failed=1

  if [[ -n $WORK_DIR && -d $WORK_DIR ]]; then
    rm -rf "$WORK_DIR"
    if [[ -d $WORK_DIR ]]; then
      warn "could not remove temp working directory $WORK_DIR"
      cleanup_failed=1
    else
      info "cleanup: removed temp working directory"
    fi
  fi

  if [[ $cleanup_failed -eq 1 && $status -eq 0 ]]; then
    status=1
  fi

  exit "$status"
}

trap cleanup EXIT
trap 'exit 130' INT TERM

EXIT_CODE=1

WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/habi-restore.XXXXXX")

if [[ $IDENTITY == '-' ]]; then
  if [[ -t 0 ]]; then
    die "--identity - reads the age private key from stdin; pipe it (for example, from a password manager) instead of typing it on a terminal"
  fi
  IDENTITY_TMP="$WORK_DIR/identity.txt"
  cat >"$IDENTITY_TMP" || die "could not read the identity from stdin"
  [[ -s $IDENTITY_TMP ]] || die "no identity data was read from stdin"
  chmod 600 "$IDENTITY_TMP"
  IDENTITY_FILE=$IDENTITY_TMP
  IDENTITY_SOURCE='stdin'
else
  IDENTITY_FILE=$IDENTITY
  IDENTITY_SOURCE="file: $IDENTITY"
  mode=$(file_mode "$IDENTITY" || true)
  if [[ -n $mode && $mode != '600' ]]; then
    warn "identity file $IDENTITY has mode $mode; restrict it to its owner (chmod 600)"
  fi
fi

[[ -s $ARCHIVE ]] || die "archive is empty: $ARCHIVE"

if [[ $SKIP_CHECKSUM -eq 1 ]]; then
  warn "checksum verification skipped (--no-checksum); corruption will only surface during restore"
else
  if [[ -z $CHECKSUM_FILE ]]; then
    CHECKSUM_FILE="${ARCHIVE}.sha256"
  fi
  [[ -r $CHECKSUM_FILE ]] ||
    die "checksum file not readable: $CHECKSUM_FILE (create it with pg-backup.sh, or pass --no-checksum to skip deliberately)"

  read -r declared_hash declared_name <"$CHECKSUM_FILE" || true
  declared_hash=$(printf '%s' "${declared_hash:-}" | tr '[:upper:]' '[:lower:]')

  [[ $declared_hash =~ ^[0-9a-f]{64}$ ]] ||
    die "malformed checksum file $CHECKSUM_FILE: expected '<sha256>  <filename>'"
  [[ -z ${declared_name:-} || ${declared_name#\*} == "$(basename "$ARCHIVE")" ]] ||
    warn "checksum file names '$declared_name' but verifying '$(basename "$ARCHIVE")'"

  actual_hash=$(sha256_file "$ARCHIVE")
  if [[ $actual_hash != "$declared_hash" ]]; then
    die "checksum mismatch for $ARCHIVE: file is damaged or was replaced (expected $declared_hash, got $actual_hash)"
  fi
  info "checksum: verified sha256 $actual_hash"
fi

if [[ $(head -n 1 "$ARCHIVE") != 'age-encryption.org/v1' ]]; then
  die "archive is not an age-encrypted backup (expected a *.dump.age file): $ARCHIVE"
fi

PLAINTEXT="$WORK_DIR/archive.dump"
info "decryption: age using $IDENTITY_SOURCE"
if ! age --decrypt --identity "$IDENTITY_FILE" --output "$PLAINTEXT" "$ARCHIVE"; then
  die "decryption failed: wrong identity or corrupt ciphertext (no database was created)"
fi
[[ -s $PLAINTEXT ]] || die "decryption produced an empty archive"

if ! TOC=$(pg_restore --list "$PLAINTEXT" 2>&1); then
  die "decrypted archive is not a readable pg_restore archive (custom-format dumps only): $(printf '%s' "$TOC" | tr '\n' ' ' | cut -c1-300)"
fi

TOC_ENTRIES=$(printf '%s\n' "$TOC" | grep -c '^[0-9]' || true)
[[ $TOC_ENTRIES -ge 1 ]] || die "archive contains no restorable entries"

if db_exists "$TARGET_DB"; then
  die "disposable database $TARGET_DB already exists; refusing to restore over it. Remove it or let the script generate a fresh name."
fi

info "server: $PGHOST:$PGPORT as $PGUSER (source db name for the safety check: $PGDATABASE)"
info "auth: $AUTH_MODE"
info "archive: $ARCHIVE (age ciphertext, $TOC_ENTRIES TOC entries)"

RESTORE_LOG="$WORK_DIR/pg_restore.log"

if ! psql_admin --command "CREATE DATABASE \"$TARGET_DB\"" >/dev/null; then
  die "could not create disposable database $TARGET_DB on $PGHOST:$PGPORT"
fi
CREATED_DB=1
info "created disposable database: $TARGET_DB"

OWNER_FLAG=()
if [[ $NO_OWNER -eq 1 ]]; then
  OWNER_FLAG=(--no-owner)
  warn "restoring with --no-owner: object ownership from the backup is discarded"
fi

SECONDS=0
if pg_restore \
  --host "$PGHOST" \
  --port "$PGPORT" \
  --username "$PGUSER" \
  --dbname "$TARGET_DB" \
  --no-password \
  --single-transaction \
  --exit-on-error \
  "${OWNER_FLAG[@]+"${OWNER_FLAG[@]}"}" \
  "$PLAINTEXT" >"$RESTORE_LOG" 2>&1; then
  RESTORE_SECONDS=$SECONDS
  info "restore: ok (${RESTORE_SECONDS}s)"
else
  RESTORE_SECONDS=$SECONDS
  printf '%s: restore failed after %ss; last log lines:\n' "$PROG" "$RESTORE_SECONDS" >&2
  tail -n 20 "$RESTORE_LOG" >&2 || true
  printf 'rehearsal: FAIL (restore failed)\n' >&2
  die "pg_restore did not complete; the disposable database will be dropped"
fi

# The decrypted plaintext is no longer needed once pg_restore has read it.
rm -f "$PLAINTEXT"
PLAINTEXT=''

ASSERTION_SECONDS=0
SECONDS=0
for index in "${!EXPECT_NAMES[@]}"; do
  table=${EXPECT_NAMES[$index]}
  expected=${EXPECT_ROWS[$index]}

  exists=$(query target "SELECT to_regclass('$table') IS NOT NULL")
  if [[ $exists != 't' ]]; then
    printf 'FAIL  %s  missing after restore (expected %s rows)\n' "$table" "$expected"
    DECLARED_FAILURES=$((DECLARED_FAILURES + 1))
    continue
  fi

  if ! actual=$(query target "SELECT count(*) FROM $table"); then
    printf 'FAIL  %s  row count query failed\n' "$table"
    DECLARED_FAILURES=$((DECLARED_FAILURES + 1))
    continue
  fi

  actual=$(trim "$actual")
  if [[ $actual == "$expected" ]]; then
    printf 'PASS  %s  rows=%s expected=%s\n' "$table" "$actual" "$expected"
  else
    printf 'FAIL  %s  rows=%s expected=%s\n' "$table" "$actual" "$expected"
    DECLARED_FAILURES=$((DECLARED_FAILURES + 1))
  fi
done
ASSERTION_SECONDS=$SECONDS

if [[ $DECLARED_FAILURES -gt 0 ]]; then
  printf 'rehearsal: FAIL (%s of %s assertions failed)\n' "$DECLARED_FAILURES" "${#EXPECT_NAMES[@]}" >&2
  die "restore succeeded but assertions failed; see FAIL lines above"
fi

info "assertions: ${#EXPECT_NAMES[@]} passed"
info "restore_seconds: $RESTORE_SECONDS"
info "assertion_seconds: $ASSERTION_SECONDS"
info "rehearsal: PASS"
