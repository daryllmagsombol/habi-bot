/**
 * Shared acceptance fixtures, created through the real backend services.
 *
 * Two accounts own one Bot, conversation, message, run, event stream, artifact,
 * attachment, memory, and skill each. Search text is unique per account so a
 * cross-user result is unambiguous.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BACKEND_ROOT } from './process.mjs';

export { requireBackendModule } from './process.mjs';

export const ACCOUNT_A = 'account-a';
export const ACCOUNT_B = 'account-b';

const dist = (name) =>
  pathToFileURL(join(BACKEND_ROOT, 'dist', name)).href;

let cached;

export async function loadBackendModules() {
  if (cached !== undefined) {
    return cached;
  }

  const [
    bots,
    persistence,
    events,
    api,
    artifacts,
    attachments,
    memory,
    skills,
    search,
    limits,
    runs,
  ] = await Promise.all([
    import(dist('bots/index.js')),
    import(dist('persistence/index.js')),
    import(dist('events/index.js')),
    import(dist('api/api-service.js')),
    import(dist('artifacts/index.js')),
    import(dist('attachments/index.js')),
    import(dist('memory/index.js')),
    import(dist('skills/index.js')),
    import(dist('search/index.js')),
    import(dist('limits/index.js')),
    import(dist('runs/index.js')),
  ]);

  cached = {
    BotRepository: bots.BotRepository,
    ConversationRepository: persistence.ConversationRepository,
    MessageRepository: persistence.MessageRepository,
    PersistenceNotFoundError: persistence.PersistenceNotFoundError,
    RunEventStore: events.RunEventStore,
    ApiService: api.ApiService,
    ArtifactService: artifacts.ArtifactService,
    AttachmentService: attachments.AttachmentService,
    LocalAttachmentStorage: attachments.LocalAttachmentStorage,
    MemoryService: memory.MemoryService,
    SkillService: skills.SkillService,
    SearchService: search.SearchService,
    ConversationSearchService: search.ConversationSearchService,
    UsageLimitService: limits.UsageLimitService,
    RunRepository: runs.RunRepository,
  };

  return cached;
}

async function* bytes(text) {
  yield Buffer.from(text, 'utf8');
}

async function seedAccount(pool) {
  const { randomUUID } = await import('node:crypto');
  const userId = randomUUID();

  await pool.query('INSERT INTO users (id) VALUES ($1)', [userId]);

  return userId;
}

export async function seedWorld(pool) {
  const modules = await loadBackendModules();
  const storageRoot = await mkdtemp(join(tmpdir(), 'habi-acceptance-files-'));
  const storage = new modules.LocalAttachmentStorage(storageRoot);
  const bots = new modules.BotRepository(pool);
  const conversations = new modules.ConversationRepository(pool);
  const messages = new modules.MessageRepository(pool);
  const events = new modules.RunEventStore(pool);
  const api = new modules.ApiService(pool);
  const artifacts = new modules.ArtifactService(pool);
  const attachments = new modules.AttachmentService(pool, storage);
  const memory = new modules.MemoryService(pool);
  const skills = new modules.SkillService(pool);
  const search = new modules.SearchService(pool);
  const conversationSearch = new modules.ConversationSearchService(pool);

  const userA = await seedAccount(pool);
  const userB = await seedAccount(pool);

  const botA = await bots.create(userA, {
    name: 'Acceptance Alpha',
    description: 'Alpha account bot.',
    instructionsMarkdown: '# Alpha\n\nAcceptance fixture.',
  });
  const botB = await bots.create(userB, {
    name: 'Acceptance Beta',
    description: 'Beta account bot.',
    instructionsMarkdown: '# Beta\n\nAcceptance fixture.',
  });

  const conversationA = await conversations.create(userA, {
    botId: botA.id,
    title: 'Alpha thread',
  });
  const conversationB = await conversations.create(userB, {
    botId: botB.id,
    title: 'Beta thread',
  });

  const messageA = await messages.append(userA, {
    conversationId: conversationA.id,
    role: 'user',
    content: 'zebraalpha isolation marker',
    clientMessageId: 'acceptance-a-1',
  });
  await messages.append(userA, {
    conversationId: conversationA.id,
    role: 'assistant',
    content: 'alpha answer',
    clientMessageId: 'acceptance-a-2',
  });
  const messageB = await messages.append(userB, {
    conversationId: conversationB.id,
    role: 'user',
    content: 'zebrabeta isolation marker',
    clientMessageId: 'acceptance-b-1',
  });
  await messages.append(userB, {
    conversationId: conversationB.id,
    role: 'assistant',
    content: 'beta answer',
    clientMessageId: 'acceptance-b-2',
  });

  // Runs are created through the real chat composition, which also reserves
  // allowance. No worker is started for this fixture, so they stay queued.
  const runA = await api.postMessage(userA, conversationA.id, {
    content: 'zebraalpha run fixture',
    clientMessageId: 'acceptance-run-a',
  });
  const runB = await api.postMessage(userB, conversationB.id, {
    content: 'zebrabeta run fixture',
    clientMessageId: 'acceptance-run-b',
  });

  for (const [owner, runId, text] of [
    [userA, runA.runId, 'alpha event'],
    [userB, runB.runId, 'beta event'],
  ]) {
    await events.append(owner, {
      runId,
      type: 'run.created',
      payload: { dispatchState: 'not_dispatched' },
    });
    await events.append(owner, {
      runId,
      type: 'message.delta',
      payload: { text },
    });
    await events.append(owner, {
      runId,
      type: 'run.completed',
      payload: { errorCode: null },
    });
  }

  // Fixture Runs are terminal so a worker started by a later scenario cannot
  // claim them and consume that scenario's stub behavior. Their three events
  // are already persisted; the terminal row matches the stream.
  await pool.query(
    `UPDATE runs
        SET status = 'completed',
            dispatch_state = 'dispatched',
            finished_at = now(),
            last_event_seq = 3
      WHERE id = ANY($1::uuid[])`,
    [[runA.runId, runB.runId]],
  );

  const artifactA = await artifacts.create(userA, {
    kind: 'markdown',
    title: 'Alpha artifact',
    content: '# Alpha artifact\n\nzebraalpha',
    conversationId: conversationA.id,
  });
  const artifactB = await artifacts.create(userB, {
    kind: 'text',
    title: 'Beta artifact',
    content: 'zebrabeta artifact',
    conversationId: conversationB.id,
  });

  const attachmentA = await attachments.createUpload(userA, conversationA.id, {
    filename: 'alpha.txt',
    contentType: 'text/plain',
    source: bytes('zebraalpha attachment'),
  });
  await attachments.finalize(userA, attachmentA.id);
  const attachmentB = await attachments.createUpload(userB, conversationB.id, {
    filename: 'beta.txt',
    contentType: 'text/plain',
    source: bytes('zebrabeta attachment'),
  });
  await attachments.finalize(userB, attachmentB.id);

  const memoryA = await memory.propose(userA, {
    botId: botA.id,
    conversationId: conversationA.id,
    sourceMessageId: messageA.id,
    content: 'zebraalpha memory fact',
  });
  const memoryB = await memory.propose(userB, {
    botId: botB.id,
    conversationId: conversationB.id,
    sourceMessageId: messageB.id,
    content: 'zebrabeta memory fact',
  });

  const skillA = await skills.create(userA, {
    name: 'Alpha skill',
    description: 'Alpha-owned skill.',
    bodyMarkdown: '# Alpha skill\n\nzebraalpha',
    botId: botA.id,
    status: 'active',
  });
  const skillB = await skills.create(userB, {
    name: 'Beta skill',
    description: 'Beta-owned skill.',
    bodyMarkdown: '# Beta skill\n\nzebrabeta',
    botId: botB.id,
    status: 'active',
  });

  return {
    users: { A: userA, B: userB },
    bots: { A: botA, B: botB },
    conversations: { A: conversationA, B: conversationB },
    messages: { A: messageA, B: messageB },
    runs: { A: runA, B: runB },
    artifacts: { A: artifactA, B: artifactB },
    attachments: { A: attachmentA, B: attachmentB },
    memories: { A: memoryA, B: memoryB },
    skills: { A: skillA, B: skillB },
    services: {
      bots,
      conversations,
      messages,
      events,
      api,
      artifacts,
      attachments,
      memory,
      skills,
      search,
      conversationSearch,
    },
    storageRoot,
  };
}

/** Regex that never matches a generated id, for malformed-id probes. */
export const MALFORMED_ID = 'not-a-uuid';
