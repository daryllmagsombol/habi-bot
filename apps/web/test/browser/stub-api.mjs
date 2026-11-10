/**
 * A settable stand-in for the Nest chat API, for the live browser suite.
 *
 * It is modelled on the stub in `test/api-proxy.test.mjs` (same fixtures, same
 * paths, same `{ error: { code } }` envelope, CSRF checked the same way) with one
 * difference the browser suite needs: the answer is chosen per test from a
 * process-level mode, so one `next start` process and one Chromium can serve the
 * healthy, 401, 500, dropped-connection, and preflight-failure states without a
 * restart. `setMode` flips the mode; `requests` records every forwarded call so a
 * test can assert what the browser actually asked for.
 *
 * Nothing here is product code: it is a fixture server, and it never decides
 * what the UI should say.
 */
import { createServer as createHttpServer } from 'node:http';

export const BOT_ID = '11111111-1111-4111-8111-111111111111';
export const THREAD_ID = '33333333-3333-4333-8333-333333333333';
export const RUN_ID = '44444444-4444-4444-8444-444444444444';
export const ATTACHMENT_ID = '22222222-2222-4222-8222-222222222222';
export const MISSING_BYTES_ID = '55555555-5555-4555-8555-555555555555';
export const ARTIFACT_ID = '66666666-6666-4666-8666-666666666666';
export const MEMORY_ID = '77777777-7777-4777-8777-777777777777';
export const SKILL_ID = '88888888-8888-4888-8888-888888888888';
/** The record a create answers with; it is not in the list the page starts on. */
export const NEW_BOT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const NEW_THREAD_ID = 'abababab-abab-4bab-8bab-abababababab';
/** The skill a create answers with; distinct from the listed skill's id. */
export const NEW_SKILL_ID = 'dededede-dede-4ded-8ded-dededededede';
export const CSRF = 'csrf-test-token';
export const SESSION = 'session-test-secret';
export const EXPORT_FILENAME = 'habi-account-export-20261104T060000Z.json';
const NOW = '2026-11-04T06:00:00.000Z';

const BOT = {
  id: BOT_ID,
  name: 'Live Field Notes',
  description: 'Reads what you attach.',
  avatarRef: null,
  instructionsMarkdown: 'Cite the document.',
  status: 'active',
  archivedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const THREAD = {
  id: THREAD_ID,
  botId: BOT_ID,
  title: 'Live thread about ordering',
  status: 'active',
  lastMessageSeq: 2,
  createdAt: NOW,
  updatedAt: NOW,
};

/** The thread a create answers with; the list only carries it after that write. */
const THREAD_2 = {
  ...THREAD,
  id: NEW_THREAD_ID,
  title: 'Fresh thread',
  lastMessageSeq: 0,
};

const ATTACHMENT = {
  id: ATTACHMENT_ID,
  conversationId: THREAD_ID,
  messageId: null,
  originalFilename: 'live-notes.md',
  contentType: 'text/markdown',
  byteSize: 64,
  sha256: 'a'.repeat(64),
  status: 'stored',
  createdAt: NOW,
  storedAt: NOW,
  deletedAt: null,
};

const MISSING_ATTACHMENT = {
  id: MISSING_BYTES_ID,
  conversationId: THREAD_ID,
  messageId: null,
  originalFilename: 'not-stored.txt',
  contentType: 'text/plain',
  byteSize: 12,
  sha256: 'b'.repeat(64),
  status: 'stored',
  createdAt: NOW,
  storedAt: NOW,
  deletedAt: null,
};

const MEMORY = {
  id: MEMORY_ID,
  botId: BOT_ID,
  conversationId: THREAD_ID,
  content: 'Prefers short sections over bullet dumps.',
  sourceMessageId: null,
  status: 'accepted',
  botApproved: true,
  conversationApproved: false,
  provenanceState: 'live',
  provenanceTombstonedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  deletedAt: null,
};

const ARTIFACT = {
  id: ARTIFACT_ID,
  conversationId: THREAD_ID,
  runId: null,
  kind: 'markdown',
  title: 'Ordering note',
  currentVersion: 1,
  status: 'draft',
  createdAt: NOW,
  updatedAt: NOW,
  deletedAt: null,
};

const ARTIFACT_VERSION = {
  artifactId: ARTIFACT_ID,
  version: 1,
  content: '# Ordering note\n\nThe cursor is the sequence, not the clock.',
  contentSha256: 'c'.repeat(64),
  byteSize: 58,
  createdBy: 'user-1',
  createdAt: NOW,
};

const ARTIFACT_DETAIL = { artifact: ARTIFACT, version: ARTIFACT_VERSION };

/** The second row the `paged-artifacts` mode appends behind the first cursor. */
const ARTIFACT_2 = {
  ...ARTIFACT,
  id: '99999999-9999-4999-8999-999999999999',
  title: 'Second ordering note',
  currentVersion: 1,
};

const ARTIFACTS_CURSOR = 'artifacts-page-2';

/** The head version in `paged-versions`; the older page is version 1. */
const ARTIFACT_VERSION_HEAD = {
  artifactId: ARTIFACT_ID,
  version: 2,
  contentSha256: 'd'.repeat(64),
  byteSize: 58,
  createdBy: 'user-1',
  createdAt: NOW,
};

const VERSIONS_CURSOR = 'versions-page-2';

/** The second memory behind the `paged-memories` cursor. */
const MEMORY_2 = {
  ...MEMORY,
  id: 'efefefef-efef-4efe-8efe-efefefefefef',
  content: 'Wants a one-line summary at the end of long replies.',
};

const MEMORIES_CURSOR = 'memories-page-2';

/** The second hit behind the `paged-search` cursor. */
const SEARCH_HIT_2 = {
  messageId: 'message-2',
  conversationId: THREAD_ID,
  conversationTitle: THREAD.title,
  botId: BOT_ID,
  role: 'assistant',
  seq: 2,
  createdAt: NOW,
  score: 0.25,
  snippet: 'Streamed <mark>live</mark> reply.',
};

const SEARCH_CURSOR = 'search-page-2';

const SKILL = {
  id: SKILL_ID,
  botId: null,
  name: 'Plain verbs',
  description: 'Prefer plain verbs over nominalisations.',
  bodyMarkdown: 'Use plain verbs.',
  version: 1,
  status: 'active',
  archivedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  deletedAt: null,
};

/** The second skill behind the `paged-skills` cursor. */
const SKILL_2 = {
  ...SKILL,
  id: 'cdcdcdcd-cdcd-4cdc-8cdc-cdcdcdcdcdcd',
  name: 'Short sentences',
  description: 'Keep every sentence short.',
  bodyMarkdown: 'One clause per sentence.',
};

const SKILLS_CURSOR = 'skills-page-2';

const RUN = {
  id: RUN_ID,
  conversationId: THREAD_ID,
  status: 'queued',
  dispatchState: 'not_dispatched',
  errorCode: null,
  lastEventSeq: 0,
  createdAt: NOW,
  updatedAt: NOW,
  startedAt: null,
  finishedAt: null,
  usage: {
    status: 'unknown',
    grossPromptTokens: null,
    grossCompletionTokens: null,
    cachedPromptTokens: null,
    reasoningTokens: null,
    totalTokens: null,
    costStatus: 'unknown',
  },
};

function message(id, role, content, seq) {
  return {
    id,
    conversationId: THREAD_ID,
    role,
    content,
    seq,
    status: 'final',
    clientMessageId: null,
    createdAt: NOW,
    finalizedAt: NOW,
  };
}

const BASE_MESSAGES = [
  message('message-1', 'user', 'First live question', 1),
  message('message-2', 'assistant', 'First live reply.\n\nSecond paragraph.', 2),
];

const DELETION = {
  deleted: true,
  accountId: 'user-1',
  deletedAt: NOW,
  alreadyDeleted: false,
  sessionsRevoked: 1,
  removed: {
    attachments: 2,
    attachmentText: 2,
    memories: 1,
    memoryAudit: 0,
    artifacts: 1,
    artifactVersions: 1,
    messages: 2,
    skills: 1,
    skillVersions: 1,
    runs: 1,
    runEvents: 0,
    conversations: 1,
    bots: 1,
    usageBuckets: 0,
    usageReservations: 0,
    usageAudit: 0,
    ssoIdentities: 0,
    ssoPending: 0,
    passwordResetTokens: 0,
  },
  backupRetention: {
    encrypted: true,
    encryption: 'age',
    policy: '7 daily / 4 weekly / 6 monthly',
    maximumDays: 184,
    disclosure:
      "A copy of this account's data survives in age-encrypted backups created before this deletion until those archives age out under the 7 daily / 4 weekly / 6 monthly retention policy — up to 184 days. Nothing is purged from an existing archive.",
  },
};

function json(response, status, body) {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  response.end(text);
}

function readBody(request) {
  return new Promise((resolve) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => resolve(body));
  });
}

function parseJson(body) {
  try {
    return JSON.parse(body);
  } catch {
    return {};
  }
}

/**
 * One stub server with a per-test mode.
 *
 * Modes:
 *   `ok`              the full healthy surface; a request without a session is 401.
 *   `unauthenticated` every request is 401, with or without a session cookie.
 *   `error`           every request is 500 `internal`.
 *   `drop`            the connection is destroyed, so the BFF sees a transport
 *                     failure (`unavailable`) rather than a response.
 *   `preflight-fail`  the first `GET /api/account` succeeds (the page render),
 *                     later ones answer 503 `api_unavailable`, so the export
 *                     preflight can fail after the page has loaded.
 *   `stream-drop`     the first run-event connection ends after one delta with
 *                     no terminal event; the next one finishes the run, so the
 *                     reconnect path can be observed with its resume cursor.
 *   `stream-exhaust`  every run-event connection ends after one distinct delta
 *                     with no terminal event, so the client's bounded
 *                     reconnect loop runs out and must show its terminal state.
 *   `paged-artifacts` `GET /api/artifacts` answers a first page with a
 *                     `nextCursor` and a second page that ends the list.
 *   `paged-skills`    `GET /api/skills` answers two cursor pages.
 *   `paged-memories`  `GET /api/bots/:id/memories` answers two cursor pages, so
 *                     the server-rendered page starts with a `nextCursor`.
 *   `paged-versions`  the selected artifact is at version 2, whose version list
 *                     answers a second, older page.
 *   `paged-search`    `GET /api/search` answers two cursor pages.
 *   `artifact-413`    `POST /api/artifacts` answers the API's `413`
 *                     `invalid_input` refusal, which the BFF must relay.
 *   `stream-hold`     the run-event connection sends one delta and then stays
 *                     open, so a streaming run can be cancelled.
 *   `stream-hold-terminal` the same held stream, but `/cancel` answers a run the
 *                     server already finished, so the client must show that
 *                     terminal state instead of a local "stopped" label.
 *   `approval-hold`   an approval write is recorded but the server keeps both
 *                     memory gates off, so a client can be shown discarding its
 *                     optimistic switch for the server's answer.
 *
 * `setDelay` holds every answer for that many milliseconds, so a busy state can
 * be observed instead of raced. It is 0 by default.
 *
 * Writes are stateful where a follow-up read would otherwise contradict them: a
 * `PATCH /api/bots/:id` rewrites the profile the list and detail routes serve,
 * and a skill create is answered with a new id and added to the served list.
 * `setMode('ok')` restores all of that state.
 */
export function createStub() {
  const requests = [];
  const sent = [];
  let mode = 'ok';
  let delayMs = 0;
  let accountReadsLeft = 1;
  let streamAttempts = 0;
  // The server's memory gates; `POST …/approvals` moves them and the Bot's
  // memory read reports them, exactly as the real API would after a write.
  let memoryGates = { bot: true, thread: false };
  // Records the browser created. The list routes include them only after the
  // write, which is what "the card appears after the server answers" means.
  let createdBots = [];
  let createdThreads = [];
  let createdSkills = [];
  // The profile the API serves. A `PATCH /api/bots/:id` rewrites it, so the
  // refreshed page can only show what the server answered.
  let botProfile = { ...BOT };
  // The gallery's one-line purpose is longer than the profile description the
  // detail route serves; a patch moves both, as the API would.
  let botPurpose = 'Reads what you attach and names the paragraph behind every claim.';
  let threadTitle = THREAD.title;

  function setMode(next) {
    mode = next;

    if (next === 'preflight-fail') {
      accountReadsLeft = 1;
    }

    if (next === 'stream-drop' || next === 'stream-exhaust') {
      streamAttempts = 0;
    }

    if (next === 'ok') {
      memoryGates = { bot: true, thread: false };
      createdBots = [];
      createdThreads = [];
      createdSkills = [];
      botProfile = { ...BOT };
      botPurpose = 'Reads what you attach and names the paragraph behind every claim.';
      threadTitle = THREAD.title;
    }
  }

  function setDelay(next) {
    delayMs = next;
  }

  const server = createHttpServer((request, response) => {
    void (async () => {
      const body = await readBody(request);
      const cookie = request.headers.cookie ?? '';

      requests.push({
        method: request.method,
        url: request.url,
        headers: { ...request.headers },
        body,
      });

      if (delayMs > 0) {
        await new Promise((resolve) => {
          setTimeout(resolve, delayMs);
        });
      }

      if (mode === 'drop') {
        request.socket.destroy();
        return;
      }

      if (mode === 'error') {
        json(response, 500, { error: { code: 'internal' } });
        return;
      }

      if (mode === 'unauthenticated' || !cookie.includes('habi_session=')) {
        json(response, 401, { error: { code: 'unauthenticated' } });
        return;
      }

      const url = new URL(request.url, 'http://stub.test');
      const path = url.pathname;
      const method = request.method;
      const csrfOk = request.headers['x-csrf-token'] === CSRF;
      const payload = parseJson(body);

      if (method === 'GET' && path === '/api/account') {
        if (mode === 'preflight-fail') {
          if (accountReadsLeft <= 0) {
            json(response, 503, { error: { code: 'api_unavailable' } });
            return;
          }

          accountReadsLeft -= 1;
        }

        json(response, 200, {
          account: {
            userId: 'user-1',
            email: 'owner@example.test',
            status: 'active',
            createdAt: NOW,
            updatedAt: NOW,
            emailVerifiedAt: NOW,
          },
        });
        return;
      }

      if (method === 'GET' && path === '/api/account/export') {
        const text = JSON.stringify({ manifest: { schemaVersion: 1 }, profile: {} }, null, 2);
        response.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'content-length': Buffer.byteLength(text),
          'content-disposition': `attachment; filename="${EXPORT_FILENAME}"`,
          'cache-control': 'no-store',
        });
        response.end(text);
        return;
      }

      if (method === 'DELETE' && path === '/api/account') {
        if (!csrfOk) {
          json(response, 403, { error: { code: 'csrf_invalid' } });
          return;
        }

        json(response, 200, DELETION);
        return;
      }

      if (method === 'GET' && path === '/api/bots') {
        json(response, 200, {
          bots: [
            {
              id: BOT_ID,
              name: botProfile.name,
              purpose: botPurpose,
              status: 'active',
              avatarRef: null,
              conversationCount: 1,
              lastActivityAt: NOW,
              updatedAt: NOW,
            },
            ...createdBots,
          ],
          nextCursor: null,
        });
        return;
      }

      if (method === 'POST' && path === '/api/bots') {
        if (!csrfOk) {
          json(response, 403, { error: { code: 'csrf_invalid' } });
          return;
        }

        const bot = {
          ...BOT,
          id: NEW_BOT_ID,
          name: typeof payload.name === 'string' ? payload.name : BOT.name,
          description: typeof payload.description === 'string' ? payload.description : '',
          instructionsMarkdown:
            typeof payload.instructionsMarkdown === 'string' ? payload.instructionsMarkdown : '',
        };

        createdBots = [
          ...createdBots,
          {
            id: bot.id,
            name: bot.name,
            purpose: bot.description,
            status: bot.status,
            avatarRef: null,
            conversationCount: 0,
            lastActivityAt: NOW,
            updatedAt: NOW,
          },
        ];

        json(response, 201, { bot });
        return;
      }

      if (method === 'GET' && path === `/api/bots/${BOT_ID}`) {
        json(response, 200, {
          bot: botProfile,
          purpose: botProfile.description,
          conversationCount: 1,
          lastActivityAt: NOW,
        });
        return;
      }

      // A patch is applied to the served profile, and answered with it: a page
      // that refreshed can only show the server's version, never its own draft.
      if (method === 'PATCH' && path === `/api/bots/${BOT_ID}`) {
        if (!csrfOk) {
          json(response, 403, { error: { code: 'csrf_invalid' } });
          return;
        }

        if (typeof payload.name === 'string') {
          botProfile = { ...botProfile, name: payload.name };
        }

        if (typeof payload.description === 'string') {
          botProfile = { ...botProfile, description: payload.description };
          botPurpose = payload.description;
        }

        if (typeof payload.instructionsMarkdown === 'string') {
          botProfile = { ...botProfile, instructionsMarkdown: payload.instructionsMarkdown };
        }

        botProfile = { ...botProfile, updatedAt: NOW };

        json(response, 200, { bot: botProfile });
        return;
      }

      if (method === 'DELETE' && path === `/api/bots/${BOT_ID}`) {
        if (!csrfOk) {
          json(response, 403, { error: { code: 'csrf_invalid' } });
          return;
        }

        json(response, 200, { bot: { ...botProfile, status: 'archived' } });
        return;
      }

      if (method === 'GET' && path === `/api/bots/${BOT_ID}/threads`) {
        json(response, 200, {
          threads: [{ ...THREAD, title: threadTitle }, ...createdThreads],
          nextCursor: null,
        });
        return;
      }

      if (method === 'POST' && path === `/api/bots/${BOT_ID}/threads`) {
        if (!csrfOk) {
          json(response, 403, { error: { code: 'csrf_invalid' } });
          return;
        }

        const thread = {
          ...THREAD_2,
          title:
            typeof payload.title === 'string' && payload.title.length > 0
              ? payload.title
              : 'New conversation',
        };

        createdThreads = [...createdThreads, thread];

        json(response, 201, { thread });
        return;
      }

      if (method === 'GET' && path === `/api/bots/${BOT_ID}/memories`) {
        if (mode === 'paged-memories') {
          if (url.searchParams.get('cursor') === MEMORIES_CURSOR) {
            json(response, 200, { memories: [MEMORY_2], nextCursor: null });
            return;
          }

          json(response, 200, {
            memories: [
              {
                ...MEMORY,
                botApproved: memoryGates.bot,
                conversationApproved: memoryGates.thread,
              },
            ],
            nextCursor: MEMORIES_CURSOR,
          });
          return;
        }

        json(response, 200, {
          memories: [
            {
              ...MEMORY,
              botApproved: memoryGates.bot,
              conversationApproved: memoryGates.thread,
            },
          ],
          nextCursor: null,
        });
        return;
      }

      if (method === 'POST' && path === `/api/bots/${BOT_ID}/memories`) {
        if (!csrfOk) {
          json(response, 403, { error: { code: 'csrf_invalid' } });
          return;
        }

        json(response, 201, { memory: MEMORY });
        return;
      }

      if (method === 'POST' && path === `/api/memories/${MEMORY_ID}/approvals`) {
        if (!csrfOk) {
          json(response, 403, { error: { code: 'csrf_invalid' } });
          return;
        }

        // The server's answer is authoritative: `approval-hold` refuses both
        // gates even when the request asked for them.
        memoryGates =
          mode === 'approval-hold'
            ? { bot: false, thread: false }
            : { bot: payload.bot === true, thread: payload.thread === true };

        json(response, 200, {
          memory: {
            ...MEMORY,
            botApproved: memoryGates.bot,
            conversationApproved: memoryGates.thread,
          },
        });
        return;
      }

      if (method === 'GET' && path === `/api/threads/${THREAD_ID}/messages`) {
        json(response, 200, {
          messages: [...BASE_MESSAGES, ...sent],
          beforeCursor: null,
          afterCursor: null,
          hasMoreBefore: false,
          hasMoreAfter: false,
        });
        return;
      }

      if (
        method === 'GET' &&
        createdThreads.some((thread) => path === `/api/threads/${thread.id}/messages`)
      ) {
        json(response, 200, {
          messages: [],
          beforeCursor: null,
          afterCursor: null,
          hasMoreBefore: false,
          hasMoreAfter: false,
        });
        return;
      }

      if (method === 'POST' && path === `/api/threads/${THREAD_ID}/messages`) {
        if (!csrfOk) {
          json(response, 403, { error: { code: 'csrf_invalid' } });
          return;
        }

        const user = {
          ...message(`message-${3 + sent.length * 2}`, 'user', payload.content ?? '', 3 + sent.length * 2),
          clientMessageId: payload.clientMessageId ?? null,
        };
        const reply = message(
          `message-${4 + sent.length * 2}`,
          'assistant',
          'Streamed reply.',
          4 + sent.length * 2,
        );

        sent.push(user, reply);

        json(response, 201, { message: user, runId: RUN_ID, run: RUN });
        return;
      }

      if (
        (method === 'PATCH' || method === 'DELETE') &&
        path === `/api/threads/${THREAD_ID}`
      ) {
        if (!csrfOk) {
          json(response, 403, { error: { code: 'csrf_invalid' } });
          return;
        }

        if (method === 'PATCH' && typeof payload.title === 'string') {
          threadTitle = payload.title;
        }

        json(response, 200, { thread: { ...THREAD, ...payload } });
        return;
      }

      if (method === 'GET' && path === `/api/threads/${THREAD_ID}/attachments`) {
        json(response, 200, {
          attachments: [ATTACHMENT, MISSING_ATTACHMENT],
          nextCursor: null,
        });
        return;
      }

      if (method === 'GET' && path === `/api/attachments/${ATTACHMENT_ID}`) {
        json(response, 200, { attachment: ATTACHMENT });
        return;
      }

      if (method === 'GET' && path === `/api/attachments/${ATTACHMENT_ID}/content`) {
        const text = '# Live notes\n\nThe stored paragraph mentions ordering.\n\nSecond paragraph.';
        response.writeHead(200, {
          'content-type': 'text/markdown; charset=utf-8',
          'content-length': Buffer.byteLength(text),
          'cache-control': 'no-store',
        });
        response.end(text);
        return;
      }

      if (method === 'GET' && path === `/api/attachments/${MISSING_BYTES_ID}/content`) {
        json(response, 503, { error: { code: 'api_unavailable' } });
        return;
      }

      if (method === 'GET' && path === '/api/artifacts') {
        if (mode === 'paged-versions') {
          json(response, 200, {
            artifacts: [{ ...ARTIFACT, currentVersion: 2 }],
            nextCursor: null,
          });
          return;
        }

        if (mode !== 'paged-artifacts') {
          json(response, 200, { artifacts: [ARTIFACT], nextCursor: null });
          return;
        }

        if (url.searchParams.get('cursor') === ARTIFACTS_CURSOR) {
          json(response, 200, { artifacts: [ARTIFACT_2], nextCursor: null });
          return;
        }

        json(response, 200, { artifacts: [ARTIFACT], nextCursor: ARTIFACTS_CURSOR });
        return;
      }

      if (method === 'POST' && path === '/api/artifacts') {
        if (!csrfOk) {
          json(response, 403, { error: { code: 'csrf_invalid' } });
          return;
        }

        // The transport bound is enforced by the API and the BFF relays it; the
        // editor's own cap cannot know a server-side refusal.
        if (mode === 'artifact-413') {
          json(response, 413, { error: { code: 'invalid_input' } });
          return;
        }

        json(response, 201, {
          artifact: {
            artifact: { ...ARTIFACT, title: payload.title ?? ARTIFACT.title },
            version: { ...ARTIFACT_VERSION, content: payload.content ?? '' },
          },
        });
        return;
      }

      if (method === 'GET' && path === `/api/artifacts/${ARTIFACT_ID}`) {
        if (mode === 'paged-versions') {
          json(response, 200, {
            artifact: {
              artifact: { ...ARTIFACT, currentVersion: 2 },
              version: { ...ARTIFACT_VERSION, version: 2 },
            },
          });
          return;
        }

        json(response, 200, { artifact: ARTIFACT_DETAIL });
        return;
      }

      if (method === 'PATCH' && path === `/api/artifacts/${ARTIFACT_ID}`) {
        if (!csrfOk) {
          json(response, 403, { error: { code: 'csrf_invalid' } });
          return;
        }

        const content = typeof payload.content === 'string' ? payload.content : ARTIFACT_VERSION.content;

        json(response, 200, {
          artifact: {
            artifact: {
              ...ARTIFACT,
              ...(typeof payload.title === 'string' ? { title: payload.title } : {}),
              ...(typeof payload.kind === 'string' ? { kind: payload.kind } : {}),
              ...(typeof payload.status === 'string' ? { status: payload.status } : {}),
              currentVersion: 2,
            },
            version: { ...ARTIFACT_VERSION, version: 2, content },
          },
        });
        return;
      }

      if (method === 'GET' && path === `/api/artifacts/${ARTIFACT_ID}/versions`) {
        if (mode === 'paged-versions') {
          if (url.searchParams.get('cursor') === VERSIONS_CURSOR) {
            json(response, 200, {
              versions: [
                {
                  artifactId: ARTIFACT_ID,
                  version: 1,
                  contentSha256: ARTIFACT_VERSION.contentSha256,
                  byteSize: ARTIFACT_VERSION.byteSize,
                  createdBy: ARTIFACT_VERSION.createdBy,
                  createdAt: NOW,
                },
              ],
              nextCursor: null,
            });
            return;
          }

          json(response, 200, {
            versions: [ARTIFACT_VERSION_HEAD],
            nextCursor: VERSIONS_CURSOR,
          });
          return;
        }

        json(response, 200, {
          versions: [
            {
              artifactId: ARTIFACT_ID,
              version: 1,
              contentSha256: ARTIFACT_VERSION.contentSha256,
              byteSize: ARTIFACT_VERSION.byteSize,
              createdBy: ARTIFACT_VERSION.createdBy,
              createdAt: NOW,
            },
          ],
          nextCursor: null,
        });
        return;
      }

      if (method === 'POST' && path === `/api/artifacts/${ARTIFACT_ID}/restore`) {
        if (!csrfOk) {
          json(response, 403, { error: { code: 'csrf_invalid' } });
          return;
        }

        // A restore is an append: the stored history is never rewritten, so the
        // answer is a new version number carrying the restored body.
        json(response, 200, {
          artifact: {
            artifact: { ...ARTIFACT, currentVersion: 3 },
            version: { ...ARTIFACT_VERSION, version: 3 },
          },
        });
        return;
      }

      if (method === 'GET' && path === '/api/skills') {
        if (mode === 'paged-skills') {
          if (url.searchParams.get('cursor') === SKILLS_CURSOR) {
            json(response, 200, { skills: [SKILL_2], nextCursor: null });
            return;
          }

          json(response, 200, { skills: [SKILL], nextCursor: SKILLS_CURSOR });
          return;
        }

        json(response, 200, { skills: [SKILL, ...createdSkills], nextCursor: null });
        return;
      }

      if (method === 'POST' && path === '/api/skills') {
        if (!csrfOk) {
          json(response, 403, { error: { code: 'csrf_invalid' } });
          return;
        }

        // A create answers a new record: a fresh id, version 1, and the Bot the
        // form attached it to (or the library when it named none).
        const skill = {
          ...SKILL,
          name: typeof payload.name === 'string' ? payload.name : SKILL.name,
          description: typeof payload.description === 'string' ? payload.description : '',
          bodyMarkdown: typeof payload.bodyMarkdown === 'string' ? payload.bodyMarkdown : '',
          botId: typeof payload.botId === 'string' ? payload.botId : null,
          id: NEW_SKILL_ID,
          version: 1,
        };

        createdSkills = [...createdSkills, skill];

        json(response, 201, { skill });
        return;
      }

      if (method === 'GET' && path === `/api/skills/${SKILL_ID}`) {
        json(response, 200, { skill: SKILL });
        return;
      }

      if (
        method === 'POST' &&
        (path === `/api/skills/${SKILL_ID}/attach` ||
          path === `/api/skills/${SKILL_ID}/detach`)
      ) {
        if (!csrfOk) {
          json(response, 403, { error: { code: 'csrf_invalid' } });
          return;
        }

        json(response, 200, {
          skill: {
            ...SKILL,
            botId: path.endsWith('/attach') ? BOT_ID : null,
          },
        });
        return;
      }

      if (method === 'PATCH' && path === `/api/skills/${SKILL_ID}`) {
        if (!csrfOk) {
          json(response, 403, { error: { code: 'csrf_invalid' } });
          return;
        }

        json(response, 200, {
          skill: { ...SKILL, ...payload, version: SKILL.version + 1, updatedAt: NOW },
        });
        return;
      }

      if (method === 'GET' && path === '/api/search') {
        if (mode === 'paged-search') {
          if (url.searchParams.get('cursor') === SEARCH_CURSOR) {
            json(response, 200, { results: [SEARCH_HIT_2], nextCursor: null });
            return;
          }

          json(response, 200, {
            results: [
              {
                messageId: 'message-1',
                conversationId: THREAD_ID,
                conversationTitle: THREAD.title,
                botId: BOT_ID,
                role: 'user',
                seq: 1,
                createdAt: NOW,
                score: 0.5,
                snippet: 'First <mark>live</mark> question',
              },
            ],
            nextCursor: SEARCH_CURSOR,
          });
          return;
        }

        json(response, 200, {
          results: [
            {
              messageId: 'message-1',
              conversationId: THREAD_ID,
              conversationTitle: THREAD.title,
              botId: BOT_ID,
              role: 'user',
              seq: 1,
              createdAt: NOW,
              score: 0.5,
              snippet: 'First <mark>live</mark> question',
            },
          ],
          nextCursor: null,
        });
        return;
      }

      if (method === 'GET' && path === `/api/runs/${RUN_ID}/events`) {
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
        });

        const frame = (seq, type, payload) =>
          `id: e1.${RUN_ID}.${seq}\nevent: ${type}\ndata: ${JSON.stringify({
            id: `event-${seq}`,
            runId: RUN_ID,
            seq,
            type,
            payload,
            createdAt: NOW,
          })}\n\n`;

        if (mode === 'stream-exhaust') {
          streamAttempts += 1;

          // Every connection ends after one distinct delta and no terminal
          // event: the client must exhaust its bounded retries, keep the text
          // it already applied, and show its retry affordance.
          response.write(
            frame(3 + streamAttempts, 'message.delta', {
              text: `attempt ${streamAttempts} `,
            }),
          );
          response.end();
          return;
        }

        if (mode === 'stream-hold' || mode === 'stream-hold-terminal') {
          // One delta, then no terminal event: the run stays live until the
          // browser cancels it. The connection closes with the client.
          response.write(frame(4, 'message.delta', { text: 'Streaming ' }));
          response.on('close', () => {
            if (!response.writableEnded) {
              response.end();
            }
          });
          return;
        }

        if (mode === 'stream-drop') {
          streamAttempts += 1;

          // The first connection drops after one delta, without a terminal
          // event, so the client must resume from this frame's `id:`.
          if (streamAttempts === 1) {
            response.write(frame(4, 'message.delta', { text: 'Streamed ' }));
            response.end();
            return;
          }

          response.write(frame(5, 'message.delta', { text: 'reply.' }));
          response.write(frame(6, 'run.completed', {}));
          response.end();
          return;
        }

        response.write(frame(4, 'message.delta', { text: 'Streamed ' }));
        response.write(frame(5, 'message.delta', { text: 'reply.' }));
        response.write(frame(6, 'run.completed', {}));
        response.end();
        return;
      }

      if (method === 'POST' && path === `/api/runs/${RUN_ID}/cancel`) {
        if (!csrfOk) {
          json(response, 403, { error: { code: 'csrf_invalid' } });
          return;
        }

        // `stream-hold-terminal` answers a run the server already finished, so a
        // client that relabels locally would claim a cancel the server refused.
        json(response, 200, {
          run: { ...RUN, status: mode === 'stream-hold-terminal' ? 'completed' : 'cancelled' },
        });
        return;
      }

      json(response, 404, { error: { code: 'not_found' } });
    })();
  });

  return {
    server,
    requests,
    /** The messages this stub has accepted, so a test can assert what was sent. */
    sent,
    setMode,
    /** Holds every answer for `ms`, so an in-flight state can be asserted. */
    setDelay,
    mode: () => mode,
    /** Forgets recorded requests; called between tests so assertions stay local. */
    clearRequests() {
      requests.length = 0;
    },
  };
}
