#!/usr/bin/env bash
#
# pg-backup.sh — take a consistent PostgreSQL logical backup, then encrypt it
# with an age public key before it is published.
#
# The published archive is ciphertext (`*.dump.age`). The private key is not
# needed to take a backup and must never be stored on the backup host. A
# SHA-256 sidecar hashes the ciphertext, and a small verification receipt
# records the `pg_restore --list` result from the plaintext dump immediately
# before encryption. Both are written beside the ciphertext.
#
# A backup is reported successful only when all of these hold:
#   1. pg_dump completed and wrote a non-empty custom-format archive;
#   2. `pg_restore --list` parsed that archive's TOC;
#   3. age encrypted it to a non-empty ciphertext with an age header;
#   4. the ciphertext was renamed into place and its SHA-256 sidecar verified;
#   5. the verification receipt names the published ciphertext and its hash.
# Until then the files carry temporary names and are removed on failure.
#
# Authentication comes only from the environment or a .pgpass file. A database
# password is never accepted as an argument, echoed, or written to the archive
# directory. The age private key is never read by this script.
#
# Compatibility: bash 3.2+ (macOS) and bash 5 (Linux), PostgreSQL 14+ client,
# age 1.x and age-keygen on PATH.
#
# See docs/runbooks/backups.md for the operational procedure.
set -euo pipefail

readonly PROG=${0##*/}
readonly RECEIPT_FORMAT='habi-backup-verified-v1'

PGHOST=${PGHOST:-127.0.0.1}
PGPORT=${PGPORT:-5432}
PGDATABASE=${PGDATABASE:-habi}
PGUSER=${PGUSER:-habi}
BACKUP_DIR=${BACKUP_DIR:-./backups}
COMPRESS_LEVEL=${BACKUP_COMPRESS_LEVEL:-6}
LOCK_TIMEOUT=${BACKUP_LOCK_TIMEOUT:-60s}
PGPASSFILE=${PGPASSFILE:-}

RECIPIENTS=()
RECIPIENT_FILES=()

usage() {
  cat <<'EOF'
Usage: pg-backup.sh --recipient KEY [options]

Take a PostgreSQL custom-format backup, encrypt it with age, and publish the
ciphertext with a SHA-256 sidecar and a verification receipt.

Required (one of):
  --recipient KEY         age recipient (age1…, or ssh-ed25519 …); repeatable
                          (env BACKUP_RECIPIENT)
  --recipient-file FILE   file of recipients, one per line, '#' comments
                          allowed; repeatable (env BACKUP_RECIPIENT_FILE)

Options:
  --host HOST          database host          (env PGHOST, default 127.0.0.1)
  --port PORT          database port          (env PGPORT, default 5432)
  --database NAME      database to dump       (env PGDATABASE, default habi)
  --user NAME          database user          (env PGUSER, default habi)
  --output-dir DIR     archive directory      (env BACKUP_DIR, default ./backups)
  --compress LEVEL     gzip level 0-9         (env BACKUP_COMPRESS_LEVEL, default 6)
  --lock-timeout TIME  pg_dump lock timeout   (env BACKUP_LOCK_TIMEOUT, default 60s)
  --help               print this help

Encryption:
  Every archive is encrypted. There is no plaintext mode. Supply the public
  key; keep the private key off this host. The script never reads, needs, or
  prints a private key.

Authentication:
  Export PGPASSWORD, or point PGPASSFILE at a mode-0600 password file, or rely
  on ~/.pgpass. There is no --password flag on purpose: arguments leak through
  shell history, process listings, and terminal scrollback.

Output (all mode 0600):
  DIR/<database>-<UTC timestamp>.dump.age         age ciphertext
  DIR/<database>-<UTC timestamp>.dump.age.sha256  SHA-256 of the ciphertext
  DIR/<database>-<UTC timestamp>.dump.age.verified creation-time receipt

  The receipt records the plaintext TOC entry count from `pg_restore --list`
  and the ciphertext hash. pg-prune.sh refuses to delete an archive without a
  matching receipt.

Exit codes:
  0  backup written, encrypted, and verified
  1  backup failed or the invocation was invalid; no verified archive is
     published
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

# Keep the archive, sidecar, receipt, and transient plaintext private even if
# the output directory is shared.
umask 077

need_value() {
  [[ $# -ge 2 && -n ${2:-} ]] || die "option $1 requires a value"
}

if [[ -n ${BACKUP_RECIPIENT:-} ]]; then
  RECIPIENTS+=("$BACKUP_RECIPIENT")
fi
if [[ -n ${BACKUP_RECIPIENT_FILE:-} ]]; then
  RECIPIENT_FILES+=("$BACKUP_RECIPIENT_FILE")
fi

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
    --recipient)
      need_value "$@"
      RECIPIENTS+=("$2")
      shift 2
      ;;
    --recipient-file)
      need_value "$@"
      RECIPIENT_FILES+=("$2")
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

if [[ ${#RECIPIENTS[@]} -eq 0 && ${#RECIPIENT_FILES[@]} -eq 0 ]]; then
  die "no backup recipient. Pass --recipient age1… or --recipient-file FILE with the owner's age public key. Plaintext backups are not supported."
fi

for tool in pg_dump pg_restore age; do
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

# Build the age recipient arguments in one place. `-r` takes an inline key;
# `-R` takes a file of keys (comments and blank lines allowed).
RECIPIENT_ARGS=()
if [[ ${#RECIPIENTS[@]} -gt 0 ]]; then
  for key in "${RECIPIENTS[@]}"; do
    RECIPIENT_ARGS+=(-r "$key")
  done
fi
if [[ ${#RECIPIENT_FILES[@]} -gt 0 ]]; then
  for file in "${RECIPIENT_FILES[@]}"; do
    [[ -r $file ]] || die "recipient file is not readable: $file"
    RECIPIENT_ARGS+=(-R "$file")
  done
fi

# Validate the recipients before touching the database. age with empty input
# emits only a header; this catches a typo or an empty recipient file early
# instead of after a long dump.
PREFLIGHT_ERR="$(mktemp "${TMPDIR:-/tmp}/habi-age-preflight.XXXXXX")"
cleanup_preflight() {
  rm -f "$PREFLIGHT_ERR"
}
trap cleanup_preflight EXIT
if ! printf '' | age "${RECIPIENT_ARGS[@]}" >/dev/null 2>"$PREFLIGHT_ERR"; then
  printf '%s: error: age rejected the recipient configuration:\n' "$PROG" >&2
  sed 's/^/  /' "$PREFLIGHT_ERR" >&2 || true
  die "invalid age recipient; no backup was taken"
fi
rm -f "$PREFLIGHT_ERR"
trap - EXIT

RECIPIENT_COUNT=${#RECIPIENTS[@]}
RECIPIENT_FILE_COUNT=${#RECIPIENT_FILES[@]}

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
BASENAME="${SAFE_DB}-${STAMP}.dump.age"
DEST="${BACKUP_DIR%/}/${BASENAME}"
CHECKSUM_FILE="${DEST}.sha256"
VERIFIED_FILE="${DEST}.verified"

PLAINTEXT="${BACKUP_DIR%/}/.${SAFE_DB}-${STAMP}.dump.plain.partial.$$"
CIPHER_PARTIAL="${BACKUP_DIR%/}/.${BASENAME}.partial.$$"
CHECKSUM_PARTIAL="${CHECKSUM_FILE}.partial.$$"
VERIFIED_PARTIAL="${VERIFIED_FILE}.partial.$$"

FINALIZED=0

cleanup() {
  local status=$?

  set +e
  rm -f "$PLAINTEXT" "$CIPHER_PARTIAL" "$CHECKSUM_PARTIAL" "$VERIFIED_PARTIAL"
  if [[ $FINALIZED -ne 1 ]]; then
    # A failed run must not leave anything that looks like a publishable
    # archive, sidecar, or receipt.
    rm -f "$DEST" "$CHECKSUM_FILE" "$VERIFIED_FILE"
  fi

  exit "$status"
}

mkdir -p "$BACKUP_DIR"
[[ -w $BACKUP_DIR ]] || die "output directory is not writable: $BACKUP_DIR"
[[ ! -e $DEST ]] || die "refusing to overwrite an existing archive: $DEST"
[[ ! -e $CHECKSUM_FILE ]] || die "refusing to overwrite an existing checksum: $CHECKSUM_FILE"
[[ ! -e $VERIFIED_FILE ]] || die "refusing to overwrite an existing receipt: $VERIFIED_FILE"

trap cleanup EXIT

info "source: $PGDATABASE on $PGHOST:$PGPORT as $PGUSER"
info "auth: $AUTH_MODE"
info "encryption: age ($RECIPIENT_COUNT inline recipient(s), $RECIPIENT_FILE_COUNT recipient file(s))"

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
  --file "$PLAINTEXT"; then
  die "pg_dump failed; no archive was published"
fi
DUMP_SECONDS=$SECONDS

[[ -e $PLAINTEXT ]] || die "pg_dump reported success but wrote no file"
[[ -s $PLAINTEXT ]] || die "pg_dump produced an empty archive"

# Readability check before encryption. A truncated or foreign archive must not
# be encrypted and published as if it were a usable backup. `pg_restore --list`
# parses the archive header and TOC from the plaintext dump.
if ! TOC=$(pg_restore --list "$PLAINTEXT" 2>&1); then
  die "archive is not readable by pg_restore --list (empty or corrupt); no archive was published"
fi

TOC_ENTRIES=$(printf '%s\n' "$TOC" | grep -c '^[0-9]' || true)
if [[ $TOC_ENTRIES -lt 1 ]]; then
  # A readable archive with no entries is a legitimate empty database, but it is
  # also what a mis-targeted backup looks like. Keep the archive and warn.
  warn "archive contains no restorable entries; confirm the database is intentionally empty"
fi

# Encrypt to a temporary name. The published name is only used after the
# ciphertext is complete and its checksum has been written.
ENCRYPT_ERR="$(mktemp "${TMPDIR:-/tmp}/habi-age-encrypt.XXXXXX")"
if ! age "${RECIPIENT_ARGS[@]}" --output "$CIPHER_PARTIAL" "$PLAINTEXT" 2>"$ENCRYPT_ERR"; then
  sed 's/^/  /' "$ENCRYPT_ERR" >&2 || true
  rm -f "$ENCRYPT_ERR"
  die "age encryption failed; no archive was published"
fi
rm -f "$ENCRYPT_ERR"

[[ -s $CIPHER_PARTIAL ]] || die "age produced an empty ciphertext; no archive was published"
chmod 600 "$CIPHER_PARTIAL"

# Sanity-check the age file header before publishing. This is not a substitute
# for decryption, which only the owner can do.
if [[ $(head -n 1 "$CIPHER_PARTIAL") != 'age-encryption.org/v1' ]]; then
  die "ciphertext does not start with the age file header; no archive was published"
fi

HASH=$(sha256_file "$CIPHER_PARTIAL")
printf '%s  %s\n' "$HASH" "$BASENAME" >"$CHECKSUM_PARTIAL"
chmod 600 "$CHECKSUM_PARTIAL"

# The receipt binds the creation-time TOC check to this exact ciphertext. The
# pruning host holds no private key, so it cannot re-parse the TOC from the
# ciphertext; it verifies this receipt and the ciphertext checksum instead.
{
  printf 'format=%s\n' "$RECEIPT_FORMAT"
  printf 'archive=%s\n' "$BASENAME"
  printf 'sha256=%s\n' "$HASH"
  printf 'toc_entries=%s\n' "$TOC_ENTRIES"
  printf 'verified_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} >"$VERIFIED_PARTIAL"
chmod 600 "$VERIFIED_PARTIAL"

# Publish archive first, then sidecar, then receipt. The receipt is the final
# success marker: prune never deletes an archive without a matching receipt.
mv "$CIPHER_PARTIAL" "$DEST"
chmod 600 "$DEST"
mv "$CHECKSUM_PARTIAL" "$CHECKSUM_FILE"
chmod 600 "$CHECKSUM_FILE"
mv "$VERIFIED_PARTIAL" "$VERIFIED_FILE"
chmod 600 "$VERIFIED_FILE"

# Re-read from disk and verify the sidecar against the published ciphertext
# before success. A failure here removes all three published files.
if command -v sha256sum >/dev/null 2>&1; then
  (cd "$(dirname "$DEST")" && sha256sum --check --status "$(basename "$CHECKSUM_FILE")") ||
    die "checksum verification failed for $DEST"
else
  (cd "$(dirname "$DEST")" && shasum -a 256 --check "$(basename "$CHECKSUM_FILE")" >/dev/null) ||
    die "checksum verification failed for $DEST"
fi

recorded_hash=$(sed -n 's/^sha256=//p' "$VERIFIED_FILE" | head -n 1)
recorded_archive=$(sed -n 's/^archive=//p' "$VERIFIED_FILE" | head -n 1)
[[ $recorded_hash == "$HASH" && $recorded_archive == "$BASENAME" ]] ||
  die "verification receipt does not match the published ciphertext"

FINALIZED=1
rm -f "$PLAINTEXT"
PLAINTEXT=''

SIZE_BYTES=$(wc -c <"$DEST" | tr -d '[:space:]')

info "archive: $DEST"
info "bytes: $SIZE_BYTES"
info "sha256: $HASH"
info "checksum_file: $CHECKSUM_FILE"
info "verified_file: $VERIFIED_FILE"
info "toc_entries: $TOC_ENTRIES"
info "dump_seconds: $DUMP_SECONDS"
info "backup: ok"
