# Backups, encryption, retention, and restore rehearsal

Status: local tooling and procedure only. Encryption and GFS retention are
implemented and tested against a disposable container; **nothing is scheduled,
deployed, or copied off the VM**, and no live restore has been performed. H-012
is not closed by this document: the owner-held items at the end are still open.

This runbook covers the PostgreSQL logical backup path in
[`scripts/backup/`](../../scripts/backup/). It assumes the reader did not build
it. Anyone able to connect to the database with a backup role and holding the
owner's age public key can take a backup; only the owner holds the private key
needed to restore.

## Owner decisions (2026-11-09)

These are recorded decisions, not open questions:

1. **Destination.** Archives stay on the VM disk. The owner copies them off the
   VM manually (see [Manual copy discipline](#manual-copy-discipline)). There is
   no S3, SFTP, or other upload path.
2. **Encryption.** Client-side, with an owner-held age keypair. The VM holds
   only the public key.
3. **Retention.** Daily/weekly/monthly ("GFS"): 7 daily, 4 weekly, 6 monthly.
   Implemented by [`pg-prune.sh`](../../scripts/backup/pg-prune.sh). Not
   scheduled.
4. **Deleted data.** Deleting an account removes it from the live database
   immediately. A copy survives in any encrypted archive created before the
   deletion until that archive ages out under retention. The worst case is
   stated in [Deleted account data](#deleted-account-data-in-backups) below.

## What is and is not covered

Covered today:

- `pg_dump` custom-format archive of one database, encrypted with age before it
  is published as `<database>-<UTC timestamp>.dump.age`.
- A SHA-256 sidecar (`….dump.age.sha256`) that checksums the **ciphertext**, not
  the plaintext dump.
- A creation-time verification receipt (`….dump.age.verified`) recording the
  `pg_restore --list` TOC entry count and the ciphertext hash.
- Honest failure: no `backup: ok` until the dump, TOC parse, encryption,
  checksum, and receipt all succeed. Partial files never carry a publishable
  name.
- A GFS prune tool with dry-run default and a refusal to delete unverified
  archives.
- A rehearsal that decrypts with an owner-supplied key, restores into a
  disposable database, asserts expected tables and row counts, and always drops
  the database and temp files.

Not covered today:

- Artifact/attachment objects: those features are not backed up as files (see
  AGENTS.md).
- Roles and cluster-global objects. `pg_dump` records object ownership and ACLs
  but does not dump `pg_authid`; a restore into a cluster without the same roles
  needs `--no-owner` or pre-created roles.
- Scheduling, alerting, monitoring, and **automatic off-VM copies**. Retention
  only deletes inside the local archive directory; it does not verify or manage
  copies the owner has taken elsewhere.
- Restoring over a live database. Deliberately unsupported here.
- Key escrow or rotation. The owner holds the only private key; losing it makes
  every archive unrecoverable.

## Prerequisites

- PostgreSQL client tools: `pg_dump`, `pg_restore`, and `psql` on `PATH`.
  Client major version should be >= the server major version. The stack uses
  `postgres:18.6-alpine`; `pg_dump` 18 is the safe choice.
- `age` and `age-keygen` 1.x on `PATH`. The scripts use age because it is a
  small, purpose-built file-encryption tool with a clean asymmetric model: the
  backup host needs only a public key. Install it from the distribution
  (`apk add age`, `apt install age`, `brew install age`) before taking backups.
  There is no fallback to plaintext and no GPG path in these scripts.
- A database role allowed to read every object being dumped.
- A password source that is not the command line:
  - `PGPASSWORD` exported in the current shell (not in a file that gets
    committed), or
  - `PGPASSFILE` pointing at a mode-0600 file, or
  - `~/.pgpass` with mode 0600. libpq silently ignores other modes; the scripts
    warn when they notice a bad mode.

`docker` is needed only for the automated rehearsal test, not for backups.

## Encryption keys (owner-held)

Generate the keypair on a trusted machine, not on the VM:

```bash
age-keygen -o habi-backup.key          # mode 0600; prints the public key
chmod 600 habi-backup.key
```

The file contains the private key (`AGE-SECRET-KEY-…`) and a comment line with
the public key (`age1…`). Treat the private key as the only thing that can read
every backup:

- Keep it off the VM. Do not copy it to the server, a container image, this
  repository, a script, a shell environment variable, or an issue/chat message.
- Put only the public key on the VM, for example
  `/etc/habi/backup-recipient.pub`, mode 0644. The file may contain comments and
  one or more `age1…` lines.
- Back up the private key separately (owner-held escrow, for example an
  offline password manager or encrypted removable media). Losing it means the
  archives cannot be restored. There is no recovery path in these scripts.
- Rotation is not implemented. To rotate, generate a new keypair, update the
  recipient file on the VM, and keep the old private key until every archive
  encrypted to the old recipient has aged out.

The backup script never reads a private key. It validates the recipient before
touching the database, so a typo fails without a long dump.

## Take a backup

Default target is the local Compose database on `127.0.0.1:5432`.

```bash
# Prompt without echoing, so the password is not in shell history or `ps`.
read -r -s -p 'DB password: ' PGPASSWORD; echo; export PGPASSWORD

scripts/backup/pg-backup.sh \
  --host 127.0.0.1 \
  --port 5432 \
  --database habi \
  --user habi \
  --recipient-file /etc/habi/backup-recipient.pub \
  --output-dir /var/backups/habi
```

Environment equivalents: `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`,
`BACKUP_DIR`, `BACKUP_COMPRESS_LEVEL` (0-9, default 6),
`BACKUP_LOCK_TIMEOUT` (default `60s`), `BACKUP_RECIPIENT` (an inline public key),
and `BACKUP_RECIPIENT_FILE`. Flags win over environment variables.

At least one recipient is required. `--recipient` may be repeated, and
`--recipient-file` may be repeated (for example to encrypt to the owner and a
second escrow key). There is no plaintext mode and no `--no-encrypt` escape.

Do not point `--output-dir` inside the repository. A repository-relative
`./backups` default exists for smoke tests only; backups contain user data and
must not be committed. If you must keep a local directory, add it to
`.git/info/exclude` rather than editing tracked files.

Expected output (paths and timings vary):

```text
pg-backup.sh: source: habi on 127.0.0.1:5432 as habi
pg-backup.sh: auth: PGPASSWORD environment variable
pg-backup.sh: encryption: age (0 inline recipient(s), 1 recipient file(s))
pg-backup.sh: archive: /var/backups/habi/habi-20261103T120114Z.dump.age
pg-backup.sh: bytes: 1042
pg-backup.sh: sha256: 9a5c…ciphertext hash…
pg-backup.sh: checksum_file: /var/backups/habi/habi-20261103T120114Z.dump.age.sha256
pg-backup.sh: verified_file: /var/backups/habi/habi-20261103T120114Z.dump.age.verified
pg-backup.sh: toc_entries: 3
pg-backup.sh: dump_seconds: 1
pg-backup.sh: backup: ok
```

`backup: ok` is the only success signal. It is printed only after:

1. `pg_dump` completed and wrote a non-empty custom-format archive;
2. `pg_restore --list` parsed that archive's TOC;
3. age encrypted it to a non-empty file with the age header;
4. the ciphertext was renamed into place and its SHA-256 sidecar verified; and
5. the verification receipt names the published ciphertext and its hash.

On failure no published archive, sidecar, or receipt is reported: temporary
files are removed, and a file that had been renamed into place is removed too.
A plaintext dump exists only transiently as a mode-0600 dotfile during the run
and is deleted before success; it never carries a publishable name.

Archive, sidecar, and receipt are written mode 0600; the output directory is
created under `umask 077`.

### Archive format

| File | Contents |
| --- | --- |
| `<database>-<UTC timestamp>.dump.age` | `pg_dump` custom format, encrypted with age |
| `….dump.age.sha256` | `<sha256>  <archive filename>` — the hash is of the **ciphertext** |
| `….dump.age.verified` | `format=habi-backup-verified-v1`, archive name, ciphertext SHA-256, `toc_entries`, `verified_at` |

The sidecar proves integrity of the bytes on disk. It does not prove
authenticity: anyone who can rewrite both the ciphertext and the sidecar can
forge a matching pair. The age ciphertext is authenticated encryption, so a
wrong key or modified ciphertext fails to decrypt rather than yielding altered
data.

### If the host has no PostgreSQL client tools or age

Two options:

1. Install the matching client tools and `age` (`brew install postgresql@18 age`
   on macOS; distribution package or PGDG repository on Linux).
2. Run the client inside a throwaway container on the same Docker network as the
   database, mounting the scripts and an output directory and installing `age`.
   Do not bake the database password into an image or a `docker run` argument;
   pass it through the environment or a mounted `.pgpass`. Do not put the age
   private key in the container: backups need only the public key.

## Verify a checksum manually

The sidecar is two space-separated fields: SHA-256, then the archive filename.
It hashes the ciphertext.

```bash
cd /var/backups/habi
sha256sum --check habi-20261103T120114Z.dump.age.sha256       # Linux
shasum -a 256 --check habi-20261103T120114Z.dump.age.sha256  # macOS
```

`OK` means the ciphertext bytes match what was written. A mismatch means the
archive was truncated, edited, or replaced; discard it and take a new backup.
This check says nothing about whether the archive decrypts or restores; only a
rehearsal with the private key proves that.

## Retention: GFS prune

[`pg-prune.sh`](../../scripts/backup/pg-prune.sh) applies the 7/4/6 policy.
**Dry-run is the default.** Nothing is deleted unless `--apply` is passed.

```bash
scripts/backup/pg-prune.sh --dir /var/backups/habi            # report only
scripts/backup/pg-prune.sh --dir /var/backups/habi --apply    # delete surplus
```

Options: `--keep-daily N` (default 7), `--keep-weekly N` (default 4),
`--keep-monthly N` (default 6), and `--now TIMESTAMP` (reference time; default:
the newest archive). `BACKUP_KEEP_DAILY`, `BACKUP_KEEP_WEEKLY`, and
`BACKUP_KEEP_MONTHLY` are the environment equivalents.

### Exact algorithm

An archive is recognized only if its name matches
`^<database>-(YYYYMMDDTHHMMSSZ)\.dump\.age$`. The timestamp is the UTC time the
dump started.

The retention windows end at an **anchor**:

- `--now TIMESTAMP` if given (ISO 8601 UTC, for example
  `2026-11-09T12:00:00Z`; a bare `2026-11-09` means midnight UTC), or
- the timestamp of the newest archive if `--now` is omitted.

Anchoring at the newest archive by default, rather than the wall clock, means a
prune run after a stalled schedule does not age out history merely because it
ran late.

For each tier, the script keeps the newest archive in each **calendar period**
of the window ending at the anchor:

| Tier | Period key | Default slots | Window |
| --- | --- | --- | --- |
| daily | UTC date `YYYY-MM-DD` | 7 | the 7 dates ending on the anchor's date |
| weekly | ISO week `GGGG-Www` (UTC) | 4 | the 4 ISO weeks ending in the anchor's ISO week |
| monthly | UTC month `YYYY-MM` | 6 | the 6 months ending in the anchor's month |

A period with no archive leaves its slot empty; it does not pull in an older
archive. The union of the three keep-sets, plus the single newest archive
overall, is retained. Every other recognized archive is a deletion candidate.
The newest archive is always kept so a stalled schedule cannot delete the last
remaining backup.

This is calendar-based on purpose. A "newest N periods that contain archives"
rule would let a sparse schedule stretch the monthly window past 6 calendar
months, which would break the deleted-data bound below. A future-dated archive
(clock skew) sorts as newest and would become the default anchor; pass `--now`
or check the VM clock if that happens.

Worked example. With `--now 2026-11-09T12:00:00Z`, suppose the directory
contains:

- one archive per day from 2 November to 9 November 2026 (eight days);
- 26, 19, and 12 October 2026;
- 15 and 1 September 2026;
- 15 August, 15 July, 15 June, and 15 May 2026.

| Tier | Kept |
| --- | --- |
| daily (7) | 3–9 November (2 November is the eighth day) |
| weekly (4) | weeks 46, 45, 44, 43 → 9 November, 8 November, 26 October, 19 October |
| monthly (6) | months 11–06 → 9 November, 26 October, 15 September, 15 August, 15 July, 15 June |

Survivors: the thirteen archives named above. Deletion candidates: 2 November,
12 October, 1 September, and 15 May.

### Verification before deletion

The prune host has no private key, so it cannot run `pg_restore --list` on the
ciphertext. Instead, deletion requires **all** of:

- a `.sha256` sidecar that names the archive and matches its current bytes; and
- a `.verified` receipt written by `pg-backup.sh`, with the expected format,
  the same archive name, the same ciphertext SHA-256, and a numeric
  `toc_entries`.

The receipt exists only because `pg_restore --list` parsed the plaintext dump
immediately before encryption. The receipt binds that creation-time check to the
published ciphertext hash. An archive with no receipt, a stale hash, a missing
sidecar, or an unrecognized name is **never deleted**: apply mode prints
`REFUSE` and exits non-zero. A dry run prints the same refusal and deletes
nothing.

If you want a stronger check before a high-stakes prune, run the restore
rehearsal with the private key for the archives you intend to keep; that proves
decryption and restore, which the receipt cannot.

### Prune output

```text
pg-prune.sh: retention: daily=7 weekly=4 monthly=6
pg-prune.sh: anchor: 2026-11-09T12:00:00Z
pg-prune.sh: archives: total=17
KEEP    habi-20261109T000000Z.dump.age  (daily,weekly,monthly,newest)
...
WOULD DELETE  habi-20261102T000000Z.dump.age  (verified; dry-run)
pg-prune.sh: keep: 13
pg-prune.sh: delete: 4
pg-prune.sh: refuse: 0
pg-prune.sh: prune: dry-run (nothing deleted; re-run with --apply to delete)
```

With `--apply`, `WOULD DELETE` becomes `DELETE` and the archive, sidecar, and
receipt are removed together. Apply mode exits `1` if any candidate was refused,
so a scheduled wrapper can alert instead of silently leaving retention
incomplete.

## Deleted account data in backups

The owner's decision, stated plainly:

> Deleting an account removes it from the live database immediately. A copy
> survives in any encrypted archive created before the deletion, and it stays
> there until that archive ages out under the retention policy. There is no
> immediate purge from backups.

### Worst-case window

The longest retention tier is monthly: the 6 calendar months ending at the
anchor. An archive in the oldest retained month `M` (the anchor is in month
`M+5`) is displaced when the anchor advances to `M+6`, because the window then
becomes `M+1 … M+6`.

Take an archive `A` created at the start of 1 March (UTC), and a deletion later
that same day. `A` is March's representative and survives until the first
September archive exists and prune runs, moving the anchor to September:

```text
1 Mar → 1 Sep = 31 (Mar) + 30 (Apr) + 31 (May) + 30 (Jun) + 31 (Jul) + 31 (Aug)
              = 184 days
```

Six consecutive calendar months are at most 184 days. A span that includes
February is shorter: 182–183 days in a leap year and 181–182 in a non-leap
year. The worst case is therefore **184 days in either kind of year**.

Therefore, with 6 monthly archives retained:

- **Worst-case deleted-data window: 184 days (about 6 months), measured from
  the deletion to the prune that removes the last archive containing it.**
- The daily tier (7 days) and weekly tier (4 weeks, about 28 days) are shorter
  and do not extend this bound.
- The number assumes a monthly-or-more-frequent backup schedule and prune
  running promptly after the new month's archive appears. If the first archive
  in month `M+6` is delayed, the containing archive remains until it arrives.
  If the schedule stops entirely, the default anchor stays at the newest
  archive, no further aging occurs, and the newest archive is always kept; the
  last copy can then outlive the bound. Running prune with an explicit later
  `--now` after a stall does age out older months.
- Copies the owner takes off the VM are outside the local retention policy. They
  survive for as long as the owner keeps them. The window above applies to the
  archives in the prune directory, not to those copies.

No document or script claims that deleting an account purges backups
immediately. Issue #32's export/delete work must repeat this caveat to users.

## Restore rehearsal

A rehearsal creates `habi_rehearsal_<random>`, decrypts, restores into it,
asserts, and always drops it. It refuses any target name that does not match
`habi_rehearsal_[a-z0-9_]{6,}`, and refuses the source database name,
`postgres`, `template0`, and `template1`.

The private key is required and is supplied at invocation. It is never read
from the archive directory, committed to the repository, or placed in an
environment variable.

```bash
read -r -s -p 'DB password: ' PGPASSWORD; echo; export PGPASSWORD

scripts/backup/pg-restore-rehearsal.sh \
  --archive /var/backups/habi/habi-20261103T120114Z.dump.age \
  --identity /home/owner/habi-backup.key \
  --host 127.0.0.1 \
  --port 5432 \
  --user habi \
  --expect public.users=3 \
  --expect public.conversations=2
```

To read the key from stdin instead of a file:

```bash
some-secret-tool read habi-backup | \
  scripts/backup/pg-restore-rehearsal.sh --archive … --identity - …
```

`--identity -` refuses to read from a terminal, stages the key in a mode-0600
file inside the rehearsal's private temp directory, and removes it with the
directory. The decrypted plaintext archive is also staged there and removed
after `pg_restore` reads it.

At least one assertion is required. A rehearsal with no assertions is not a
rehearsal and the script exits non-zero.

Expectations can also come from a file, one `TABLE=ROWS` per line; blank lines
and `#` comments are ignored:

```bash
scripts/backup/pg-restore-rehearsal.sh --archive … --identity … --expect-file checks.sql
```

The file is **not** arbitrary SQL. It is a declarative `table=count` list so a
rehearsal never executes untrusted SQL against a restored database. Table names
must be lowercase/unquoted-safe, optionally `schema.table`.

`PGDATABASE` (default `habi`) is used only to refuse a target that matches the
live database name; it is never the restore target. Set it if the database you
backed up is not named `habi`. The restore target is always the disposable
`--database` value.

Expected output:

```text
pg-restore-rehearsal.sh: decryption: age using file: /home/owner/habi-backup.key
pg-restore-rehearsal.sh: checksum: verified sha256 9a5c…
pg-restore-rehearsal.sh: server: 127.0.0.1:5432 as habi (source db name for the safety check: habi)
pg-restore-rehearsal.sh: auth: PGPASSWORD environment variable
pg-restore-rehearsal.sh: archive: …dump.age (age ciphertext, 3 TOC entries)
pg-restore-rehearsal.sh: created disposable database: habi_rehearsal_43fde80ffdc5
pg-restore-rehearsal.sh: restore: ok (1s)
PASS  public.users  rows=3 expected=3
pg-restore-rehearsal.sh: assertions: 1 passed
pg-restore-rehearsal.sh: restore_seconds: 1
pg-restore-rehearsal.sh: assertion_seconds: 0
pg-restore-rehearsal.sh: rehearsal: PASS
pg-restore-rehearsal.sh: cleanup: dropped disposable database habi_rehearsal_43fde80ffdc5
pg-restore-rehearsal.sh: cleanup: removed temp working directory
```

Exit codes:

- `0` — decrypt, checksum, restore, and every assertion passed; disposable
  database and temp files removed.
- `1` — decryption, checksum, archive readability, restore, or an assertion
  failed. Cleanup still ran; the FAIL lines and exit code are the evidence.
- `2` — usage error, missing identity, unsafe target name, or malformed
  expectation. Nothing was created.

The disposable database is dropped in an EXIT trap, including after failure and
on `INT`/`TERM`. If the drop itself fails the script warns and exits non-zero;
inspect `psql -c '\l'` and drop the `habi_rehearsal_*` database by hand.

### Ownership

By default the restore preserves owner and ACL statements from the archive. That
works when the roles exist on the target cluster. If the target lacks roles, the
restore fails; pass `--no-owner` to restore without ownership, accepting that
ownership information from the backup is discarded. `--no-owner` is the correct
choice only when you deliberately restore into a cluster without those roles,
not as a default.

### Automating the rehearsal

[`backup.test.mjs`](../../scripts/backup/backup.test.mjs) exercises the full
path with Docker: it starts a disposable `postgres:18.6-alpine` container on a
random loopback port, generates a throwaway age keypair, seeds a table with
three rows, backs it up, changes the source, restores into a new database with
the private key, asserts the backup rows return, asserts a corrupt ciphertext, a
wrong key, a missing key, and a checksum mismatch fail, and asserts cleanup
leaves no container, disposable database, or temp file. Run it with:

```bash
node --test scripts/backup/backup.test.mjs
```

[`backup-prune.test.mjs`](../../scripts/ci/backup-prune.test.mjs) tests the GFS
plan, dry-run default, deletion of exactly the surplus, and refusal to delete
unverified archives without Docker or age:

```bash
node --test scripts/ci/backup-prune.test.mjs
```

`backup.test.mjs` skips cleanly when Docker, the PostgreSQL client tools, or
`age`/`age-keygen` are unavailable. `backup-prune.test.mjs` needs only bash and
a SHA-256 tool (`sha256sum` or `shasum`). Neither is part of
`pnpm verify:foundation` and neither runs in CI; wiring them into CI is a
separate change. They never touch the Compose database: they create their own
container and database names and remove them.

## Interpreting a failing rehearsal

| Symptom | Meaning | Action |
| --- | --- | --- |
| `no decryption identity` | No `--identity` | Supply the owner-held private key; do not put it beside the archive |
| `identity file is not readable` | Wrong path or permissions | Fix the path/mode; the key must be readable by the operator only |
| `identity file … has mode …` | Group/other-readable key | `chmod 600` it |
| `archive is not an age-encrypted backup` | Plaintext or foreign file | Only `*.dump.age` archives are supported; re-dump with this tooling |
| `decryption failed` | Wrong key or corrupt/truncated ciphertext | Try the correct key; if it still fails, treat the archive as lost |
| `no password source` | No `PGPASSWORD`, `PGPASSFILE`, or `~/.pgpass` | Provide one; do not add a password flag |
| `.pgpass` warning about mode | Mode is not 0600, so libpq ignores the file | `chmod 600 ~/.pgpass` |
| `could not create disposable database` | Maintenance connection or `CREATEDB` privilege missing | Use a role with `CREATEDB`; check `MAINTENANCE_DB` |
| `checksum mismatch` | Ciphertext changed or sidecar belongs to another file | Discard and restore from a known-good copy |
| `decrypted archive is not a readable pg_restore archive` | Truncated/corrupt file, or a plain-SQL dump | Re-dump in custom format; investigate the copy that moved it |
| `restore failed` with role errors | Target cluster is missing roles recorded in the archive | Create roles, or deliberately use `--no-owner` |
| `FAIL … missing after restore` | Expected table absent from the archive | The expectation is wrong or the dump is incomplete |
| `FAIL … rows=N expected=M` | Data mismatch | Treat the backup as untrustworthy; do not rely on it |
| `refusing to restore over` | Target name is not disposable | Let the script generate the name |

## Restoring for real (not rehearsed here)

No production or staging host exists, and no live restore has been performed.
The intended shape, once a host and owner authorization exist:

1. Verify the ciphertext sidecar checksum.
2. Decrypt with the owner-held private key into a private temp location.
3. Provision a clean target (new database, or a new host for host loss).
4. Restore with `pg_restore --exit-on-error --single-transaction --no-owner` if
   the roles are not present, or with roles present to keep ownership.
5. Re-run the same assertions the rehearsal used, plus application-level checks:
   a known account can read its own conversations, and another account cannot.
6. Remove the decrypted plaintext and the staged key.
7. Record wall-clock restore time and archive size so the operational target is
   measured, not assumed.

Step 5 is not implementable yet: authentication, conversations, and ownership
enforcement are not built. Treat the application-level acceptance criteria in
issue #12 as open.

## Manual copy discipline

Archives stay on the VM. Until the owner copies them off, the VM disk is a
single point of failure: host loss, disk failure, or loss of the Docker volume
loses the backups too.

When copying:

1. Copy the archive **and** its `.sha256` and `.verified` sidecars together.
   Prune treats a missing sidecar or receipt as unverified and will not delete
   that archive, but a restore without the sidecar requires `--no-checksum`.
2. Verify the checksum after the copy (`sha256sum --check` / `shasum -a 256
   --check`). A copy is not a backup until the bytes match.
3. Keep the copy on media or a host with access controls at least as strong as
   the VM. The archive is ciphertext, but the private key is the only thing
   protecting it; treat both with care.
4. Independent copies are outside the GFS policy. They are not pruned by
   `pg-prune.sh`, and their deleted-data window is however long the owner keeps
   them. Record where they are and when they were last verified.

The scripts do not upload anything. There is no S3, SFTP, or object-storage
code path, by owner decision.

## Failure modes for the backup job

| Failure | Current behavior | Owner follow-up |
| --- | --- | --- |
| Connection refused / timeout | `pg_dump` fails, non-zero exit, no archive | Alerting/scheduling not implemented |
| Disk full during dump or encryption | Temporary files removed, non-zero exit, no published archive | Monitor free space; off-VM copy is manual |
| Invalid or missing recipient | Fails before dumping, non-zero exit | Fix the public-key file |
| age encryption fails | Temporary ciphertext removed, non-zero exit | Check `age` install and recipient |
| Dump succeeds, ciphertext truncated later | Detected by checksum verify and, at restore, by decryption failure | Verify copies; rehearse |
| Encryption succeeds, sidecar write fails | Published files removed, non-zero exit | Check output-directory permissions |
| Process killed between renames | A ciphertext may exist without its sidecar or receipt | Inspect and decrypt/rehearse manually; prune will not delete it without a receipt |
| Backup role lacks privileges | `pg_dump` fails loudly, non-zero exit | Grant a backup role |
| Archive lists 0 entries | Warning; `backup: ok` still reported | Confirm the database is intentionally empty, otherwise the target was wrong |
| Prune candidate unverified | `REFUSE` line; not deleted; apply exits 1 | Investigate the missing receipt/sidecar before deleting |
| Password helper misconfigured | Script exits with an actionable message; never prompts interactively | — |

## Security notes

- Passwords are accepted only through `PGPASSWORD`, `PGPASSFILE`, or `~/.pgpass`.
  There is no `--password` flag: process arguments appear in `ps`, shell
  history, and CI logs.
- The scripts never print the password. The tests assert it does not leak to
  stdout/stderr.
- The age **private** key never appears in the repository, a script, a
  container, or an environment variable. Pass it at invocation with
  `--identity FILE`, or pipe it with `--identity -`.
- `pg-backup.sh` needs only the public key. It never reads a private key and has
  no decrypt path.
- The transient plaintext dump (a mode-0600 dotfile in the output directory),
  the decrypted plaintext, and a stdin-staged key (both inside the rehearsal's
  private temp directory) are removed on exit, including on failure. They are
  not encrypted at rest while they exist; a crash could leave a temp file.
  Inspect `TMPDIR` and the output directory after a hard kill. The published
  archive is always ciphertext.
- Archives contain all data in the database at dump time, including rows deleted
  after the dump. Treat them as at least as sensitive as the database itself.
- Archive, sidecar, and receipt are mode 0600; the output directory is created
  under `umask 077`. A shared directory may still expose the file to its owner
  only — verify ownership before handing a backup to another account.
- Never commit a backup, checksum, receipt, `.pgpass`, age key, or connection
  string.

## Limits of this rehearsal

A local rehearsal is necessary but not sufficient. It does not prove:

- Recovery after host loss, disk failure, or loss of the Docker volume.
- Correctness of a manual off-VM copy, transfer integrity, or key escrow.
- Behavior on production data volume; the synthetic rehearsal takes seconds and
  says nothing about RTO.
- That the restore path works without the original cluster's roles when
  `--no-owner` is used (ownership is discarded, not restored).
- That application-level ownership and cross-user isolation survive a restore;
  those features and their tests do not exist yet.
- Artifact/attachment recovery, since those objects are not backed up.
- That scheduled backups run, that prune runs, that failures alert, or that
  retention actually deletes anything on a host.
- Transport security to a remote destination; the rehearsal is loopback only.

Record measured restore time and archive size for each rehearsal; the
operational target is an owner decision that needs those numbers.

## Still owner-held

- **The age private key.** Generate it off-VM, escrow it, and never place it on
  the backup host.
- **The public key on the VM.** Put it at a stable path (for example
  `/etc/habi/backup-recipient.pub`) and update it on rotation.
- **Manual copy discipline.** Copy archives, sidecars, and receipts off the VM,
  verify checksums, and record where copies live. Until then, the VM is a
  single point of failure.
- **Scheduling and alerting.** No cron/systemd timer and no failure
  notification exist. A failed backup or prune fails silently unless someone
  runs it.
- **A rehearsal against the real volume.** The Docker rehearsal uses synthetic
  data. Measure restore time and archive size on the real database before
  relying on the RTO/RPO.
- **Key rotation and escrow.** No rotation tooling; losing the key loses the
  archives.
