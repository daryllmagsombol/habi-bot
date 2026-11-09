#!/usr/bin/env bash
#
# pg-prune.sh — apply a daily/weekly/monthly (GFS) retention policy to encrypted
# Habi backup archives.
#
# The policy is deliberately simple and reproducible. Archives are grouped by
# the UTC timestamp in their filename (`<database>-YYYYMMDDTHHMMSSZ.dump.age`).
# For each tier, the script keeps the newest archive in each calendar period of
# the window ending at the anchor (--now, or the newest archive by default):
#
#   daily   (default 7):  the newest archive on each of the 7 dates ending at
#                         the anchor
#   weekly  (default 4):  the newest archive in each of the 4 ISO weeks ending
#                         at the anchor
#   monthly (default 6):  the newest archive in each of the 6 months ending at
#                         the anchor
#
# The union of those sets, plus the single newest archive overall, is retained.
# Everything else is a deletion candidate. Calendar windows are deliberate: if
# a period has no archive, that slot is empty and older archives age out. A
# count-based "newest N periods present" rule would let a sparse schedule
# stretch the retention window beyond the 6 months used for the data-deletion
# commitment. The newest archive is always kept so a stalled schedule cannot
# delete the last remaining backup.
#
# A candidate is deleted only when it is VERIFIED:
#   - a SHA-256 sidecar exists, names the archive, and matches its bytes; and
#   - a creation-time verification receipt exists, names the archive, records
#     the same SHA-256, and records a numeric TOC entry count.
# The receipt is written by pg-backup.sh only after `pg_restore --list` parsed
# the plaintext dump immediately before encryption. The pruning host holds no
# private key and cannot re-parse the encrypted TOC, so it re-checks the
# ciphertext hash against that creation-time receipt. An archive without a
# valid receipt is never deleted; apply mode reports it and exits non-zero.
#
# Dry-run is the default. Deletion requires --apply.
#
# Compatibility: bash 3.2+ (macOS) and bash 5 (Linux).
#
# See docs/runbooks/backups.md for the operational procedure.
set -euo pipefail

readonly PROG=${0##*/}
readonly ARCHIVE_RE='^(.+)-([0-9]{8}T[0-9]{6}Z)\.dump\.age$'
readonly RECEIPT_FORMAT='habi-backup-verified-v1'

BACKUP_DIR=${BACKUP_DIR:-./backups}
KEEP_DAILY=${BACKUP_KEEP_DAILY:-7}
KEEP_WEEKLY=${BACKUP_KEEP_WEEKLY:-4}
KEEP_MONTHLY=${BACKUP_KEEP_MONTHLY:-6}
NOW=''
APPLY=0
EXIT_CODE=2

usage() {
  cat <<'EOF'
Usage: pg-prune.sh [options]

Apply GFS retention to encrypted backup archives. Dry-run by default.

Options:
  --dir DIR            archive directory   (env BACKUP_DIR, default ./backups)
  --keep-daily N       daily slots         (env BACKUP_KEEP_DAILY, default 7)
  --keep-weekly N      weekly slots        (env BACKUP_KEEP_WEEKLY, default 4)
  --keep-monthly N     monthly slots       (env BACKUP_KEEP_MONTHLY, default 6)
  --now TIMESTAMP      reference time, ISO 8601 UTC (default: the newest
                        archive's timestamp); the retention windows end here
  --apply              actually delete verified deletion candidates
  --help               print this help

Algorithm:
  Archives match <database>-YYYYMMDDTHHMMSSZ.dump.age. The retention windows end
  at --now, or at the newest archive when --now is omitted. For each tier, keep
  the newest archive in each calendar period of the window:
    daily   = newest archive on each of the N dates ending at the anchor;
    weekly  = newest archive in each of the N ISO weeks ending at the anchor;
    monthly = newest archive in each of the N months ending at the anchor.
  A period with no archive leaves its slot empty. The union is retained, plus
  the newest archive overall; every other archive is a deletion candidate.

Safety:
  A deletion candidate is removed only if its SHA-256 sidecar matches its bytes
  and a matching creation-time verification receipt exists. Unknown names,
  missing sidecars, and missing receipts are never deleted. Apply mode exits 1
  when at least one candidate was refused.

Exit codes:
  0  prune plan printed; in apply mode, every verified candidate was deleted
  1  a deletion candidate failed verification; it was not deleted
  2  usage error
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

while [[ $# -gt 0 ]]; do
  case $1 in
    --dir | --output-dir)
      need_value "$@"
      BACKUP_DIR=$2
      shift 2
      ;;
    --keep-daily)
      need_value "$@"
      KEEP_DAILY=$2
      shift 2
      ;;
    --keep-weekly)
      need_value "$@"
      KEEP_WEEKLY=$2
      shift 2
      ;;
    --keep-monthly)
      need_value "$@"
      KEEP_MONTHLY=$2
      shift 2
      ;;
    --now)
      need_value "$@"
      NOW=$2
      shift 2
      ;;
    --apply)
      APPLY=1
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

for value in "$KEEP_DAILY" "$KEEP_WEEKLY" "$KEEP_MONTHLY"; do
  [[ $value =~ ^[0-9]+$ ]] || die "retention slot counts must be non-negative integers, got '$value'"
done

[[ -d $BACKUP_DIR ]] || die "backup directory does not exist: $BACKUP_DIR"
[[ -r $BACKUP_DIR ]] || die "backup directory is not readable: $BACKUP_DIR"

EXIT_CODE=1

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

# YYYYMMDDTHHMMSSZ -> a value BSD date and GNU date both accept.
stamp_to_iso() {
  local stamp=$1
  printf '%s-%s-%sT%s:%s:%sZ' \
    "${stamp:0:4}" "${stamp:4:2}" "${stamp:6:2}" \
    "${stamp:9:2}" "${stamp:11:2}" "${stamp:13:2}"
}

stamp_day() {
  printf '%s-%s-%s' "${1:0:4}" "${1:4:2}" "${1:6:2}"
}

stamp_month() {
  printf '%s-%s' "${1:0:4}" "${1:4:2}"
}

stamp_week() {
  local iso
  iso=$(stamp_to_iso "$1")

  if date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$iso" +%G-W%V 2>/dev/null; then
    return 0
  fi

  date -u -d "$iso" +%G-W%V
}

# ISO 8601 UTC timestamp -> epoch seconds, on BSD date and GNU date.
to_epoch() {
  local iso=$1

  if date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$iso" +%s 2>/dev/null; then
    return 0
  fi

  date -u -d "$iso" +%s
}

# Epoch seconds -> formatted UTC value, on BSD date and GNU date.
format_epoch() {
  local epoch=$1
  local format=$2

  if date -u -r "$epoch" "+$format" 2>/dev/null; then
    return 0
  fi

  date -u -d "@$epoch" "+$format"
}

prev_month() {
  local month=$1
  local year=${month:0:4}
  local number=${month:5:2}

  number=$((10#$number - 1))
  if [[ $number -eq 0 ]]; then
    number=12
    year=$((10#$year - 1))
  fi

  printf '%04d-%02d' "$((10#$year))" "$number"
}

normalize_now() {
  local value=$1

  if [[ $value =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
    value="${value}T00:00:00Z"
  fi

  [[ $value =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] ||
    die "--now must be an ISO 8601 UTC timestamp like 2026-11-09T12:00:00Z (or 2026-11-09)"

  printf '%s' "$value"
}

window_contains() {
  local window=$1
  local key=$2

  [[ $window == *"|$key|"* ]]
}

receipt_value() {
  local file=$1
  local key=$2
  sed -n "s/^${key}=//p" "$file" | head -n 1
}

# verify_archive NAME
# Prints the reason on failure and returns 1. Prints nothing on success.
verify_archive() {
  local name=$1
  local path="$BACKUP_DIR/$name"
  local sidecar="$path.sha256"
  local receipt="$path.verified"
  local declared_hash declared_name actual_hash

  [[ -f $path ]] || { printf 'archive is not a regular file'; return 1; }
  [[ -r $sidecar ]] || { printf 'checksum sidecar missing'; return 1; }

  read -r declared_hash declared_name <"$sidecar" || true
  declared_hash=$(printf '%s' "${declared_hash:-}" | tr '[:upper:]' '[:lower:]')
  declared_name=${declared_name:-}

  [[ $declared_hash =~ ^[0-9a-f]{64}$ ]] ||
    { printf 'checksum sidecar is malformed'; return 1; }
  [[ ${declared_name#\*} == "$name" ]] ||
    { printf 'checksum sidecar names a different archive'; return 1; }

  actual_hash=$(sha256_file "$path")
  [[ $actual_hash == "$declared_hash" ]] ||
    { printf 'checksum does not match the ciphertext'; return 1; }

  [[ -r $receipt ]] || { printf 'verification receipt missing'; return 1; }
  [[ $(receipt_value "$receipt" format) == "$RECEIPT_FORMAT" ]] ||
    { printf 'verification receipt has an unknown format'; return 1; }
  [[ $(receipt_value "$receipt" archive) == "$name" ]] ||
    { printf 'verification receipt names a different archive'; return 1; }
  [[ $(receipt_value "$receipt" sha256) == "$declared_hash" ]] ||
    { printf 'verification receipt hash does not match the ciphertext'; return 1; }

  local toc
  toc=$(receipt_value "$receipt" toc_entries)
  [[ $toc =~ ^[0-9]+$ ]] ||
    { printf 'verification receipt has no TOC entry count'; return 1; }

  return 0
}

# Collect archives and their timestamps. Names that do not match the expected
# pattern are reported and never deleted.
ARCHIVE_NAMES=()
ARCHIVE_STAMPS=()
for path in "$BACKUP_DIR"/*.dump.age; do
  [[ -e $path ]] || continue
  name=${path##*/}
  if [[ $name =~ $ARCHIVE_RE ]]; then
    ARCHIVE_NAMES+=("$name")
    ARCHIVE_STAMPS+=("${BASH_REMATCH[2]}")
  else
    warn "ignoring unrecognized file: $name"
  fi
done

TOTAL=${#ARCHIVE_NAMES[@]}
if [[ $TOTAL -eq 0 ]]; then
  info "retention: daily=$KEEP_DAILY weekly=$KEEP_WEEKLY monthly=$KEEP_MONTHLY"
  info "archives: total=0 keep=0 delete=0 refuse=0"
  info "prune: nothing to do"
  exit 0
fi

# Newest first. Stamps are fixed-width, so a reverse sort of "<stamp>\t<name>"
# puts the newest archive first, then the next.
TAB=$(printf '\t')
SORTED=()
while IFS="$TAB" read -r stamp name; do
  SORTED+=("${stamp}${TAB}${name}")
done < <(
  for index in "${!ARCHIVE_NAMES[@]}"; do
    printf '%s%s%s\n' "${ARCHIVE_STAMPS[$index]}" "$TAB" "${ARCHIVE_NAMES[$index]}"
  done | sort -r -t "$TAB" -k1,1
)

KEEP_NAMES=()
KEEP_REASONS=()

keep_reason() {
  local name=$1
  local index
  for index in "${!KEEP_NAMES[@]}"; do
    if [[ ${KEEP_NAMES[$index]} == "$name" ]]; then
      printf '%s' "${KEEP_REASONS[$index]}"
      return 0
    fi
  done
  return 1
}

add_keep() {
  local name=$1
  local reason=$2
  local index
  for index in "${!KEEP_NAMES[@]}"; do
    if [[ ${KEEP_NAMES[$index]} == "$name" ]]; then
      KEEP_REASONS[$index]="${KEEP_REASONS[$index]},$reason"
      return 0
    fi
  done
  KEEP_NAMES+=("$name")
  KEEP_REASONS+=("$reason")
}

select_window() {
  local tier=$1
  local window=$2
  local seen=''
  local entry stamp name key

  for entry in "${SORTED[@]}"; do
    stamp=${entry%%"$TAB"*}
    name=${entry#*"$TAB"}

    case $tier in
      daily) key=$(stamp_day "$stamp") ;;
      weekly) key=$(stamp_week "$stamp") ;;
      monthly) key=$(stamp_month "$stamp") ;;
      *) die "internal error: unknown tier $tier" ;;
    esac

    window_contains "$window" "$key" || continue

    case "|$seen|" in
      *"|$key|"*) continue ;;
    esac

    seen="${seen}|${key}"
    add_keep "$name" "$tier"
  done
}

NEWEST_STAMP=${SORTED[0]%%"$TAB"*}
if [[ -n $NOW ]]; then
  EXIT_CODE=2
  ANCHOR_ISO=$(normalize_now "$NOW")
  EXIT_CODE=1
else
  # Anchor at the newest archive, not the wall clock: a stalled schedule must
  # not age out its own history merely because prune ran late.
  ANCHOR_ISO=$(stamp_to_iso "$NEWEST_STAMP")
fi
ANCHOR_EPOCH=$(to_epoch "$ANCHOR_ISO")

DAILY_WINDOW='|'
offset=0
while [[ $offset -lt $KEEP_DAILY ]]; do
  DAILY_WINDOW="${DAILY_WINDOW}$(format_epoch $((ANCHOR_EPOCH - offset * 86400)) '%Y-%m-%d')|"
  offset=$((offset + 1))
done

WEEKLY_WINDOW='|'
offset=0
while [[ $offset -lt $KEEP_WEEKLY ]]; do
  WEEKLY_WINDOW="${WEEKLY_WINDOW}$(format_epoch $((ANCHOR_EPOCH - offset * 604800)) '%G-W%V')|"
  offset=$((offset + 1))
done

MONTHLY_WINDOW='|'
month_key=$(format_epoch "$ANCHOR_EPOCH" '%Y-%m')
offset=0
while [[ $offset -lt $KEEP_MONTHLY ]]; do
  MONTHLY_WINDOW="${MONTHLY_WINDOW}${month_key}|"
  month_key=$(prev_month "$month_key")
  offset=$((offset + 1))
done

select_window daily "$DAILY_WINDOW"
select_window weekly "$WEEKLY_WINDOW"
select_window monthly "$MONTHLY_WINDOW"

# Always keep the newest archive, even if the schedule has stalled and it falls
# outside every window. Retention must not delete the last remaining backup.
NEWEST_NAME=${SORTED[0]#*"$TAB"}
add_keep "$NEWEST_NAME" 'newest'

DELETE_COUNT=0
REFUSED_COUNT=0

info "retention: daily=$KEEP_DAILY weekly=$KEEP_WEEKLY monthly=$KEEP_MONTHLY"
info "anchor: $ANCHOR_ISO"
info "archives: total=$TOTAL"

for entry in "${SORTED[@]}"; do
  name=${entry#*"$TAB"}

  if reasons=$(keep_reason "$name"); then
    printf 'KEEP    %s  (%s)\n' "$name" "$reasons"
    continue
  fi

  if reason=$(verify_archive "$name"); then
    DELETE_COUNT=$((DELETE_COUNT + 1))
    if [[ $APPLY -eq 1 ]]; then
      rm -f "$BACKUP_DIR/$name" "$BACKUP_DIR/$name.sha256" "$BACKUP_DIR/$name.verified" ||
        die "failed to delete $name"
      printf 'DELETE  %s  (verified)\n' "$name"
    else
      printf 'WOULD DELETE  %s  (verified; dry-run)\n' "$name"
    fi
  else
    REFUSED_COUNT=$((REFUSED_COUNT + 1))
    printf 'REFUSE  %s  (%s; not deleted)\n' "$name" "$reason"
  fi
done

info "keep: ${#KEEP_NAMES[@]}"
info "delete: $DELETE_COUNT"
info "refuse: $REFUSED_COUNT"

if [[ $APPLY -eq 1 ]]; then
  info "prune: applied (deleted $DELETE_COUNT verified archive(s))"
  if [[ $REFUSED_COUNT -gt 0 ]]; then
    die "$REFUSED_COUNT deletion candidate(s) failed verification and were not deleted"
  fi
else
  info "prune: dry-run (nothing deleted; re-run with --apply to delete)"
fi
