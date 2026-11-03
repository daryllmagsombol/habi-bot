# Backups and restore rehearsal

Status: local tooling and procedure only. No schedule, off-VM destination,
encryption, alerting, or live restore has been performed. H-012 is not closed by
this document; the gaps are listed as owner decisions and limits below.

This runbook covers the PostgreSQL logical backup path implemented in
[`scripts/backup/`](../../scripts/backup/). It assumes the reader did not build
it. Anyone able to connect to the database with a backup role can follow it.

## What is and is not covered

Covered today:

- `pg_dump` custom-format archive of one database, written as
  `<database>-<UTC timestamp>.dump`.
- A SHA-256 sidecar (`…dump.sha256`) written beside the archive.
- A pre-success check that the archive is non-empty and readable by
  `pg_restore --list`.
- A rehearsal that restores the archive into a disposable database, asserts
  expected tables and row counts, and always drops the database.

Not covered today:

- Artifact/attachment objects: those features do not exist yet (see AGENTS.md).
- Roles and cluster-global objects. `pg_dump` records object ownership and ACLs
  but does not dump `pg_authid`; a restore into a cluster without the same roles
  needs `--no-owner` or pre-created roles.
- Encryption at rest or in transit beyond whatever the connection and filesystem
  already provide.
- Off-VM copies, scheduling, retention enforcement, alerting, monitoring.
- Restoring over a live database. That is deliberately unsupported here.

## Prerequisites

- PostgreSQL client tools: `pg_dump`, `pg_restore`, and `psql` on `PATH`.
  Client major version should be >= the server major version. The stack uses
  `postgres:18.6-alpine`; `pg_dump` 18 is the safe choice.
- A database role allowed to read every object being dumped.
- A password source that is not the command line:
  - `PGPASSWORD` exported in the current shell (not in a file that gets
    committed), or
  - `PGPASSFILE` pointing at a mode-0600 file, or
  - `~/.pgpass` with mode 0600. libpq silently ignores other modes; the scripts
    warn when they notice a bad mode.

`docker` is needed only for the automated rehearsal test, not for backups.

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
  --output-dir /var/backups/habi
```

Environment equivalents: `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`,
`BACKUP_DIR`, `BACKUP_COMPRESS_LEVEL` (0-9, default 6), and
`BACKUP_LOCK_TIMEOUT` (default `60s`). Flags win over environment variables.

Do not point `--output-dir` inside the repository. A repository-relative
`./backups` default exists for smoke tests only; backups contain user data and
must not be committed. If you must keep a local directory, add it to
`.git/info/exclude` rather than editing tracked files.

Expected output (paths and timings vary):

```text
pg-backup.sh: source: habi on 127.0.0.1:5432 as habi
pg-backup.sh: auth: PGPASSWORD environment variable
pg-backup.sh: archive: /var/backups/habi/habi-20261103T120114Z.dump
pg-backup.sh: bytes: 1726
pg-backup.sh: sha256: 1e14c8fb3b8898be877889a3eca4215d2b45c73b6f0f445b1218305439465f56
pg-backup.sh: checksum_file: /var/backups/habi/habi-20261103T120114Z.dump.sha256
pg-backup.sh: toc_entries: 3
pg-backup.sh: dump_seconds: 1
pg-backup.sh: backup: ok
```

`backup: ok` is the only success signal. It is printed only after the archive
exists, is non-empty, is readable by `pg_restore --list`, and its sidecar
verifies against the archive. On failure no published archive is reported: the
partial file is removed and the exit status is non-zero.

Archive and sidecar are written mode 0600.

### If the host has no PostgreSQL client tools

Two options:

1. Install the matching client tools (`brew install postgresql@18` on macOS,
   distribution package or PGDG repository on Linux).
2. Run the client inside a throwaway container on the same Docker network as the
   database, mounting the scripts and an output directory. Do not bake the
   password into an image or a `docker run` argument; pass it through the
   environment or a mounted `.pgpass`.

## Verify a checksum manually

The sidecar is two space-separated fields: SHA-256, then the archive filename.

```bash
cd /var/backups/habi
sha256sum --check habi-20261103T120114Z.dump.sha256   # Linux
shasum -a 256 --check habi-20261103T120114Z.dump.sha256  # macOS
```

`OK` means the bytes match what was written. A mismatch means the archive was
truncated, edited, or replaced; discard it and take a new backup. The sidecar
proves integrity against accidental damage, not authenticity: anyone who can
rewrite both files can forge a matching pair.

## Restore rehearsal

A rehearsal creates `habi_rehearsal_<random>`, restores into it, asserts, and
always drops it. It refuses any target name that does not match
`habi_rehearsal_[a-z0-9_]{6,}`, and refuses the source database name,
`postgres`, `template0`, and `template1`.

At least one assertion is required. A rehearsal with no assertions is not a
rehearsal and the script exits non-zero.

```bash
read -r -s -p 'DB password: ' PGPASSWORD; echo; export PGPASSWORD

scripts/backup/pg-restore-rehearsal.sh \
  --archive /var/backups/habi/habi-20261103T120114Z.dump \
  --host 127.0.0.1 \
  --port 5432 \
  --user habi \
  --expect public.users=3 \
  --expect public.conversations=2
```

Expectations can also come from a file, one `TABLE=ROWS` per line; blank lines
and `#` comments are ignored:

```bash
scripts/backup/pg-restore-rehearsal.sh --archive … --expect-file checks.sql
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
pg-restore-rehearsal.sh: checksum: verified sha256 1e14c8fb…
pg-restore-rehearsal.sh: server: 127.0.0.1:5432 as habi (source db name for the safety check: habi)
pg-restore-rehearsal.sh: auth: PGPASSWORD environment variable
pg-restore-rehearsal.sh: archive: /var/backups/habi/habi-20261103T120114Z.dump (3 TOC entries)
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

- `0` — restore succeeded, every assertion passed, disposable database and temp
  files removed.
- `1` — checksum, archive readability, restore, or an assertion failed. Cleanup
  still ran; the FAIL lines and exit code are the evidence.
- `2` — usage error, unsafe target name, or malformed expectation. Nothing was
  created.

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

`scripts/backup/backup.test.mjs` exercises the full path with Docker: it starts a
disposable `postgres:18.6-alpine` container on a random loopback port, seeds a
table with three rows, backs it up, mutates the source, restores into a new
database, asserts the backup rows return, asserts a corrupt archive and a
checksum mismatch fail, and asserts cleanup leaves no container, disposable
database, or temp file. Run it with:

```bash
node --test scripts/backup/backup.test.mjs
```

It skips cleanly when Docker or `pg_dump`/`pg_restore`/`psql` are unavailable.
It is not part of `pnpm verify:foundation` and runs no CI job; wiring it into CI
is a separate change. It never touches the Compose database: it creates its own
container and database names and removes them.

## Interpreting a failing rehearsal

| Symptom | Meaning | Action |
| --- | --- | --- |
| `no password source` | No `PGPASSWORD`, `PGPASSFILE`, or `~/.pgpass` | Provide one; do not add a password flag |
| `.pgpass` warning about mode | Mode is not 0600, so libpq ignores the file | `chmod 600 ~/.pgpass` |
| `could not create disposable database` | Maintenance connection or `CREATEDB` privilege missing | Use a role with `CREATEDB`; check `MAINTENANCE_DB` |
| `checksum mismatch` | Archive changed or sidecar belongs to another file | Discard and re-dump; check storage integrity |
| `not a readable pg_restore archive` | Truncated/corrupt file, or a plain-SQL dump | Re-dump in custom format; investigate the CI/copy that moved it |
| `restore failed` with role errors | Target cluster is missing roles recorded in the archive | Create roles, or deliberately use `--no-owner` |
| `restore failed` with duplicate object | Restore ran twice into the same database | The script refuses an existing target; inspect and drop the leftover |
| `FAIL … missing after restore` | Expected table absent from the archive | The expectation is wrong or the dump is incomplete |
| `FAIL … rows=N expected=M` | Data mismatch | Treat the backup as untrustworthy; do not rely on it |
| `refusing to restore over` | Target name is not disposable | Let the script generate the name |

## Restoring for real (not rehearsed here)

No production or staging host exists, and no live restore has been performed.
The intended shape, once a host and owner authorization exist:

1. Verify the sidecar checksum.
2. Provision a clean target (new database, or a new host for host loss).
3. Restore with `pg_restore --exit-on-error --single-transaction --no-owner` if
   the roles are not present, or with roles present to keep ownership.
4. Re-run the same assertions the rehearsal used, plus application-level checks:
   a known account can read its own conversations, and another account cannot.
5. Record wall-clock restore time and archive size so the operational target is
   measured, not assumed.

Step 4 is not implementable yet: authentication, conversations, and ownership
enforcement are not built. Treat the application-level acceptance criteria in
issue #12 as open.

## Failure modes for the backup job

| Failure | Current behavior | Owner follow-up |
| --- | --- | --- |
| Connection refused / timeout | `pg_dump` fails, non-zero exit, no archive | Alerting/scheduling not implemented |
| Disk full during dump | Partial file removed, non-zero exit | Off-VM destination decision outstanding |
| Dump succeeds, archive truncated later | Detected by checksum verify and `pg_restore --list` at rehearsal | Monitoring of stored archives outstanding |
| Backup role lacks privileges | `pg_dump` fails loudly, non-zero exit | Grant a backup role |
| Archive lists 0 entries | Warning; `backup: ok` still reported | Confirm the database is intentionally empty, otherwise the target was wrong |
| Password helper misconfigured | Script exits with an actionable message; never prompts interactively | — |

## Security notes

- Passwords are accepted only through `PGPASSWORD`, `PGPASSFILE`, or `~/.pgpass`.
  There is no `--password` flag: process arguments appear in `ps`, shell
  history, and CI logs.
- The scripts never print the password, and the test asserts it does not leak to
  stdout/stderr.
- Archives contain all data in the database, including deleted rows that have not
  been vacuumed away. Treat them as sensitive as the database itself.
- Archive and sidecar are mode 0600; the output directory is created under
  `umask 077`. A shared directory may still expose the file to its owner only —
  verify ownership before handing a backup to another account.
- Never commit a backup, checksum, `.pgpass`, or connection string.

## Retention, off-host storage, encryption, and alerting (owner decisions)

None of these are implemented, and this runbook does not choose a vendor. They
are decisions that need an owner, recorded here so the gap is visible:

- **Off-VM destination**: must not be the same disk, RAID array, or same-host
  snapshot. Object storage, a second host, or removable media are all plausible;
  none is chosen. Access credentials must come from the host environment or a
  secret store, never the repository.
- **Encryption in transit and at rest**: transport TLS and an at-rest mechanism
  (for example `age`/`gpg` before upload) are unchosen. Key ownership, escrow,
  and rotation are unchosen. This tooling writes plaintext archives and does not
  implement encryption.
- **Retention and frequency**: no schedule, no expiry, no deletion job. Decide
  RPO/RTO, how many copies, and where they live. Include how deleted account data
  ages out of retained backups: the current archive keeps whatever existed at
  dump time, so retention duration is a data-deletion commitment, not only an
  operations preference.
- **Automation and alerting**: no cron/systemd timer, no failure notification.
  A failed backup currently fails silently unless someone runs it.
- **Key escrow**: required before any encrypted backup can be restored by
  someone other than its creator.

## Limits of this rehearsal

A local rehearsal is necessary but not sufficient. It does not prove:

- Recovery after host loss, disk failure, or loss of the Docker volume.
- Correctness of an off-VM copy, transfer integrity, or encryption/decryption.
- Behavior on production data volume; the synthetic rehearsal takes seconds and
  says nothing about RTO.
- That the restore path works without the original cluster's roles when
  `--no-owner` is used (ownership is discarded, not restored).
- That application-level ownership and cross-user isolation survive a restore;
  those features and their tests do not exist yet.
- Artifact/attachment recovery, since those objects are not backed up.
- That scheduled backups run, that failures alert, or that retention deletes
  anything.
- Transport security to a remote destination; the rehearsal is loopback only.

Record measured restore time and archive size for each rehearsal; the
operational target is an owner decision that needs those numbers.
