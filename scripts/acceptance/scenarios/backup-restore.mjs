/**
 * H-025 scenario: backup and restore.
 *
 * Uses the H-012 scripts, which publish age ciphertext only:
 *   - `pg-backup.sh` dumps, verifies, and encrypts to `*.dump.age` with a
 *     ciphertext SHA-256 sidecar and a `.verified` receipt. The VM needs only
 *     the owner's public key.
 *   - `pg-restore-rehearsal.sh` decrypts with the private key supplied at
 *     invocation and asserts exact table counts, then drops its database.
 * The scenario generates a throwaway keypair so no real key is ever involved.
 *
 * The rehearsal script drops its target, so ownership is verified on a second
 * direct restore into a database this harness owns. That restore uses the same
 * `pg_restore` invocation the rehearsal uses; only the lifetime differs.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  REPOSITORY_ROOT,
  requireBackendModule,
  run,
} from '../lib/process.mjs';
import {
  createDatabase,
  dropDatabase,
  postgresClientAvailable,
} from '../lib/docker.mjs';
import { loadBackendModules } from '../lib/seed.mjs';
import { blocked, runCheck } from './_check.mjs';

const TABLES = [
  'users',
  'bots',
  'conversations',
  'messages',
  'runs',
  'run_events',
  'artifacts',
  'artifact_versions',
  'attachments',
  'memories',
  'skills',
];

async function count(pool, table) {
  const result = await pool.query(`SELECT count(*)::int AS count FROM ${table}`);

  return result.rows[0]?.count ?? 0;
}

function scriptEnv(postgres) {
  return {
    ...process.env,
    PGPASSWORD: postgres.password,
    PGHOST: postgres.host,
    PGPORT: String(postgres.port),
    PGUSER: postgres.user,
    PGDATABASE: postgres.database,
  };
}

export const backupRestoreScenario = {
  id: 'backup-restore',
  title: 'Backup restore preserves ownership and denies cross-user access',
  async run(ctx) {
    const checks = [];
    const world = await ctx.ensureWorld();
    const modules = await loadBackendModules();

    if (!postgresClientAvailable()) {
      return {
        checks: [
          blocked(
            'H-012 backup and restore can run',
            'pg_dump, pg_restore, and psql are not all available on PATH.',
          ),
        ],
        blockers: ['PostgreSQL client tools are missing on this host.'],
      };
    }

    const ageTools = run('bash', ['-lc', 'command -v age age-keygen'], { timeoutMs: 15_000 });

    if (ageTools.status !== 0) {
      return {
        checks: [
          blocked(
            'H-012 encrypted backup and restore can run',
            'age and age-keygen are not both available on PATH.',
          ),
        ],
        blockers: ['The age encryption tools are missing on this host.'],
      };
    }

    const work = await mkdtemp(join(tmpdir(), 'habi-acceptance-backup-'));
    const backupDir = join(work, 'backups');
    const restoreDbName = `habi_acceptance_restore_${randomBytes(6).toString('hex')}`;
    let restoredPool;
    let archive;
    let sourceCounts;
    const identityFile = join(work, 'throwaway-identity.txt');
    const recipientFile = join(work, 'throwaway-recipient.txt');

    // A throwaway keypair stands in for the owner's. The private key exists
    // only inside `work` and is removed with it in `finally`.
    const keygen = run('age-keygen', ['-o', identityFile], { timeoutMs: 15_000 });

    if (keygen.status !== 0) {
      throw new Error(`age-keygen failed (${keygen.status}): ${(keygen.stderr ?? '').trim()}`);
    }

    const identityText = await readFile(identityFile, 'utf8');
    const publicKey = identityText
      .split('\n')
      .find((line) => line.startsWith('# public key:'))
      ?.replace('# public key:', '')
      .trim();

    assert.ok(publicKey, 'age-keygen produced no public key');
    await writeFile(recipientFile, `${publicKey}\n`, { mode: 0o600 });

    try {
      sourceCounts = {};

      for (const table of TABLES) {
        sourceCounts[table] = await count(ctx.pool, table);
      }

      await runCheck(checks, 'H-012 backup writes an encrypted, checksummed archive', async () => {
        const result = run(
          'bash',
          [
            join(REPOSITORY_ROOT, 'scripts/backup/pg-backup.sh'),
            '--host',
            ctx.postgres.host,
            '--port',
            String(ctx.postgres.port),
            '--database',
            ctx.postgres.database,
            '--user',
            ctx.postgres.user,
            '--output-dir',
            backupDir,
            '--recipient-file',
            recipientFile,
          ],
          { env: scriptEnv(ctx.postgres), timeoutMs: 120_000 },
        );

        if (result.status !== 0) {
          throw new Error(
            `pg-backup.sh failed (${result.status}): ${(result.stderr ?? '').trim().slice(0, 2000)}`,
          );
        }

        const files = await readdir(backupDir);
        const dump = files.find((file) => file.endsWith('.dump.age'));

        assert.ok(dump, 'no .dump.age archive was written');
        archive = join(backupDir, dump);

        assert.ok(files.some((file) => file.endsWith('.dump.age.sha256')), 'no SHA-256 sidecar was written');
        assert.ok(files.some((file) => file.endsWith('.dump.age.verified')), 'no verified receipt was written');

        const bytes = await readFile(archive);

        assert.ok(
          bytes.subarray(0, 30).toString('utf8').includes('age-encryption.org'),
          'the archive does not carry an age header',
        );
        assert.ok(
          !bytes.toString('latin1').includes('PostgreSQL database dump'),
          'the archive contains plaintext dump bytes',
        );

        return {
          archive: dump,
          checksumSidecar: true,
          verifiedReceipt: true,
          ciphertextNotPlaintext: true,
        };
      });

      await runCheck(checks, 'H-012 rehearsal restores exact table counts', async () => {
        const args = [
          join(REPOSITORY_ROOT, 'scripts/backup/pg-restore-rehearsal.sh'),
          '--archive',
          archive,
          '--identity',
          identityFile,
          '--host',
          ctx.postgres.host,
          '--port',
          String(ctx.postgres.port),
          '--user',
          ctx.postgres.user,
        ];

        for (const table of TABLES) {
          args.push('--expect', `${table}=${sourceCounts[table]}`);
        }

        const result = run('bash', args, {
          env: scriptEnv(ctx.postgres),
          timeoutMs: 120_000,
        });

        if (result.status !== 0) {
          throw new Error(
            `pg-restore-rehearsal.sh failed (${result.status}):\n` +
              `${(result.stdout ?? '').slice(-3000)}\n${(result.stderr ?? '').slice(-3000)}`,
          );
        }

        assert.match(result.stdout, /PASS/i);

        return {
          stdoutTail: (result.stdout ?? '')
            .trim()
            .split('\n')
            .slice(-6)
            .join(' | '),
          tablesChecked: TABLES.length,
        };
      });

      await runCheck(checks, 'a second restore preserves every owner column', async () => {
        const restoredUrl = createDatabase(ctx.postgres, restoreDbName);
        const { Pool } = requireBackendModule('pg');
        const plaintext = join(work, 'restored.dump');

        const decrypt = run('age', ['-d', '-i', identityFile, '-o', plaintext, archive], {
          timeoutMs: 60_000,
        });

        if (decrypt.status !== 0) {
          throw new Error(
            `age decryption failed (${decrypt.status}): ${(decrypt.stderr ?? '').trim().slice(0, 2000)}`,
          );
        }

        const restore = run(
          'pg_restore',
          [
            '--host',
            ctx.postgres.host,
            '--port',
            String(ctx.postgres.port),
            '--username',
            ctx.postgres.user,
            '--no-password',
            '--single-transaction',
            '--exit-on-error',
            '--dbname',
            restoredUrl,
            plaintext,
          ],
          { env: scriptEnv(ctx.postgres), timeoutMs: 120_000 },
        );

        if (restore.status !== 0) {
          throw new Error(
            `pg_restore failed (${restore.status}): ${(restore.stderr ?? '').trim().slice(0, 2000)}`,
          );
        }

        restoredPool = new Pool({ connectionString: restoredUrl, max: 4 });

        // Counts and ownership are read from the restored database, not the
        // source, so this is not a tautology.
        for (const table of TABLES) {
          assert.equal(await count(restoredPool, table), sourceCounts[table], table);
        }

        const bots = new modules.BotRepository(restoredPool);
        const conversations = new modules.ConversationRepository(restoredPool);
        const messages = new modules.MessageRepository(restoredPool);
        const events = new modules.RunEventStore(restoredPool);
        const artifacts = new modules.ArtifactService(restoredPool);
        const memory = new modules.MemoryService(restoredPool);
        const skills = new modules.SkillService(restoredPool);

        assert.equal((await bots.get(world.users.A, world.bots.A.id)).id, world.bots.A.id);
        assert.equal((await artifacts.get(world.users.A, world.artifacts.A.artifact.id)).artifact.id, world.artifacts.A.artifact.id);
        assert.ok((await messages.list(world.users.A, world.conversations.A.id)).messages.length >= 2);
        assert.ok((await events.read(world.users.A, world.runs.A.runId)).events.length >= 1);
        assert.equal((await memory.get(world.users.A, world.memories.A.id)).id, world.memories.A.id);
        assert.equal((await skills.get(world.users.A, world.skills.A.id)).id, world.skills.A.id);

        for (const [label, action] of [
          ['bot', () => bots.get(world.users.B, world.bots.A.id)],
          ['conversation', () => conversations.get(world.users.B, world.conversations.A.id)],
          ['messages', () => messages.list(world.users.B, world.conversations.A.id)],
          ['run events', () => events.read(world.users.B, world.runs.A.runId)],
          ['artifact', () => artifacts.get(world.users.B, world.artifacts.A.artifact.id)],
          ['memory', () => memory.get(world.users.B, world.memories.A.id)],
          ['skill', () => skills.get(world.users.B, world.skills.A.id)],
        ]) {
          try {
            await action();
            assert.fail(`restored ${label} was readable by the wrong account`);
          } catch (error) {
            if (error?.code !== 'not_found') {
              throw error;
            }
          }
        }

        return {
          restoredDatabase: restoreDbName,
          countsMatch: true,
          ownerReads: 7,
          crossUserDenials: 7,
        };
      });
    } finally {
      if (restoredPool !== undefined) {
        await restoredPool.end().catch(() => {});
      }

      dropDatabase(ctx.postgres, restoreDbName);
      await rm(work, { recursive: true, force: true }).catch(() => {});
    }

    return {
      checks,
      evidence: {
        sourceCounts,
        backupScript: 'scripts/backup/pg-backup.sh',
        restoreRehearsalScript: 'scripts/backup/pg-restore-rehearsal.sh',
        encryption: 'age, throwaway keypair generated per run; the private key exists only inside the scenario temp dir',
      },
      residualRisks: [
        'The rehearsal script drops its disposable database; ownership assertions use a second direct pg_restore because the H-012 script has no keep-open mode.',
        'In-memory sessions are not part of the backup. Post-restore checks use the real services with the restored pool; they do not replay a browser session.',
      ],
    };
  },
};
