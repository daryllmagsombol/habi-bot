#!/usr/bin/env bash
#
# pg-backup.sh — take a consistent, checksummed PostgreSQL logical backup.
#
# Writes a pg_dump custom-format archive to a timestamped file in the output
# directory, then writes a SHA-256 sidecar file next to it. The script verifies
# the archive is non-empty and readable by pg_restore before reporting success.
#
# Authentication comes only from the environment or a .pgpass file. A password
# is never accepted as an argument, echoed, or written to the archive directory.
#
# Compatibility: bash 3.2+ (macOS) and bash 5 (Linux), PostgreSQL 14+ client.
#
# See docs/runbooks/backups.md for the operational procedure.
set -euo pipefail

readonly PROG=${0##*/}

PGHOST=${PGHOST:-127.0.0.1}
PGPORT=${PGPORT:-5432}
PGDATABASE=${PGDATABASE:-habi}
PGUSER=${PGUSER:-habi}
BACKUP_DIR=${BACKUP_DIR:-./backups}
COMPRESS_LEVEL=${BACKUP_COMPRESS_LEVEL:-6}
LOCK_TIMEOUT=${BACKUP_LOCK_TIMEOUT:-60s}
PGPASSFILE=${PGPASSFILE:-}

usage() {
  cat <<'EOF'
Usage: pg-backup.sh [options]

Take a PostgreSQL custom-format backup and write a SHA-256 checksum beside it.

Options:
  --host HOST          database host          (env PGHOST, default 127.0.0.1)
  --port PORT          database port          (env PGPORT, default 5432)
  --database NAME      database to dump       (env PGDATABASE, default habi)
  --user NAME          database user          (env PGUSER, default habi)
  --output-dir DIR     archive directory      (env BACKUP_DIR, default ./backups)
  --compress LEVEL     gzip level 0-9         (env BACKUP_COMPRESS_LEVEL, default 6)
  --lock-timeout TIME  pg_dump lock timeout   (env BACKUP_LOCK_TIMEOUT, default 60s)
  --help               print this help

Authentication:
  Export PGPASSWORD, or point PGPASSFILE at a mode-0600 password file, or rely
  on ~/.pgpass. There is no --password flag on purpose: arguments leak through
  shell history, process listings, and terminal scrollback.

Output:
  DIR/<database>-<UTC timestamp>.dump         custom-format archive, mode 0600
  DIR/<database>-<UTC timestamp>.dump.sha256  checksum sidecar, mode 0600

Exit codes:
  0  backup written and verified
  1  backup failed; no verified archive is reported
EOF
}

die() {
  printf '%s: error: %s\n' "$PROG" "$*" >&2
  exit 1
}

info() {
  printf '%s: %s\n' "$PROG" "$*"
}

warn() {
  printf '%s: warning: %s\n' "$PROG" "$*" >&2
}

# Keep the archive and checksum private even if the output directory is shared.
umask 077

need_value() {
  [[ $# -ge 2 && -n ${2:-} ]] || die "option $1 requires a value"
}

while [[ $# -gt 0 ]]; do
  case $1 in
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
    --database | --dbname)
      need_value "$@"
      PGDATABASE=$2
      shift 2
      ;;
    --user | --username)
      need_value "$@"
      PGUSER=$2
      shift 2
      ;;
    --output-dir | --out)
      need_value "$@"
      BACKUP_DIR=$2
      shift 2
      ;;
    --compress)
      need_value "$@"
      COMPRESS_LEVEL=$2
      shift 2
      ;;
    --lock-timeout)
      need_value "$@"
      LOCK_TIMEOUT=$2
      shift 2
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

[[ $COMPRESS_LEVEL =~ ^[0-9]$ ]] || die "compress level must be 0-9, got '$COMPRESS_LEVEL'"
[[ -n $PGDATABASE ]] || die "database name must not be empty"
[[ -n $PGUSER ]] || die "user name must not be empty"

for tool in pg_dump pg_restore; do
  command -v "$tool" >/dev/null 2>&1 || die "required tool not found on PATH: $tool"
done

sha256_file() {
  local file=$1

  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
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

# Resolve a non-interactive password source. Values are never printed.
AUTH_MODE=''
if [[ -n ${PGPASSWORD:-} ]]; then
  AUTH_MODE='PGPASSWORD environment variable'
elif [[ -n $PGPASSFILE ]]; then
  [[ -r $PGPASSFILE ]] || die "PGPASSFILE is not readable: $PGPASSFILE"
  AUTH_MODE=".pgpass file: $PGPASSFILE"
elif [[ -r ${HOME:-}/.pgpass ]]; then
  PGPASSFILE="$HOME/.pgpass"
  export PGPASSFILE
  AUTH_MODE=".pgpass file: $PGPASSFILE"
else
  die "no password source. Export PGPASSWORD, set PGPASSFILE, or create a mode-0600 ~/.pgpass (never pass a password as an argument)"
fi

if [[ -n ${PGPASSFILE:-} ]]; then
  mode=$(file_mode "$PGPASSFILE" || true)
  if [[ -n $mode && $mode != '600' ]]; then
    warn "$PGPASSFILE has mode $mode; libpq ignores .pgpass files that are not mode 0600"
  fi
fi

# Fail fast instead of hanging on an unreachable host.
export PGCONNECT_TIMEOUT=${PGCONNECT_TIMEOUT:-10}

SAFE_DB=${PGDATABASE//[^A-Za-z0-9._-]/_}
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
BASENAME="${SAFE_DB}-${STAMP}.dump"
DEST="${BACKUP_DIR%/}/${BASENAME}"
PARTIAL="${BACKUP_DIR%/}/.${BASENAME}.partial.$$"

cleanup() {
  local status=$?

  if [[ -n ${PARTIAL:-} && -e $PARTIAL ]]; then
    rm -f "$PARTIAL"
  fi

  exit "$status"
}
trap cleanup EXIT

mkdir -p "$BACKUP_DIR"
[[ -w $BACKUP_DIR ]] || die "output directory is not writable: $BACKUP_DIR"

info "source: $PGDATABASE on $PGHOST:$PGPORT as $PGUSER"
info "auth: $AUTH_MODE"

SECONDS=0
if ! pg_dump \
  --host "$PGHOST" \
  --port "$PGPORT" \
  --username "$PGUSER" \
  --dbname "$PGDATABASE" \
  --format=custom \
  --compress="$COMPRESS_LEVEL" \
  --lock-wait-timeout="$LOCK_TIMEOUT" \
  --no-password \
  --file "$PARTIAL"; then
  die "pg_dump failed; no archive was published"
fi
DUMP_SECONDS=$SECONDS

[[ -e $PARTIAL ]] || die "pg_dump reported success but wrote no file"
[[ -s $PARTIAL ]] || die "pg_dump produced an empty archive"

mv "$PARTIAL" "$DEST"
PARTIAL=''
chmod 600 "$DEST"

# Readability check: a truncated or foreign archive must not be reported as a
# usable backup. `pg_restore --list` parses the archive header and TOC.
if ! TOC=$(pg_restore --list "$DEST" 2>&1); then
  rm -f "$DEST"
  die "archive is not readable by pg_restore --list (empty or corrupt); removed $DEST"
fi

TOC_ENTRIES=$(printf '%s\n' "$TOC" | grep -c '^[0-9]' || true)
if [[ $TOC_ENTRIES -lt 1 ]]; then
  # A readable archive with no entries is a legitimate empty database, but it is
  # also what a mis-targeted backup looks like. Keep the archive and warn.
  warn "archive contains no restorable entries; confirm the database is intentionally empty"
fi

HASH=$(sha256_file "$DEST")
CHECKSUM_FILE="${DEST}.sha256"
printf '%s  %s\n' "$HASH" "$BASENAME" >"$CHECKSUM_FILE"
chmod 600 "$CHECKSUM_FILE"

# Re-read from disk and verify the sidecar against the archive before success.
if command -v sha256sum >/dev/null 2>&1; then
  (cd "$(dirname "$DEST")" && sha256sum --check --status "$(basename "$CHECKSUM_FILE")") ||
    die "checksum verification failed for $DEST"
else
  (cd "$(dirname "$DEST")" && shasum -a 256 --check "$(basename "$CHECKSUM_FILE")" >/dev/null) ||
    die "checksum verification failed for $DEST"
fi

SIZE_BYTES=$(wc -c <"$DEST" | tr -d '[:space:]')

info "archive: $DEST"
info "bytes: $SIZE_BYTES"
info "sha256: $HASH"
info "checksum_file: $CHECKSUM_FILE"
info "toc_entries: $TOC_ENTRIES"
info "dump_seconds: $DUMP_SECONDS"
info "backup: ok"
