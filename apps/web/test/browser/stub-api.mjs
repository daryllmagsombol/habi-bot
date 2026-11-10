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
 */
export function createStub() {
  const requests = [];
  const sent = [];
  let mode = 'ok';
  let accountReadsLeft = 1;
  let streamAttempts = 0;

  function setMode(next) {
    mode = next;

    if (next === 'preflight-fail') {
      accountReadsLeft = 1;
    }

    if (next === 'stream-drop') {
      streamAttempts = 0;
    }
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
              name: BOT.name,
              purpose: 'Reads what you attach and names the paragraph behind every claim.',
              status: 'active',
              avatarRef: null,
              conversationCount: 1,
              lastActivityAt: NOW,
              updatedAt: NOW,
            },
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

        json(response, 201, { bot: BOT });
        return;
      }

      if (method === 'GET' && path === `/api/bots/${BOT_ID}`) {
        json(response, 200, {
          bot: BOT,
          purpose: 'Reads what you attach.',
          conversationCount: 1,
          lastActivityAt: NOW,
        });
        return;
      }

      if (
        (method === 'PATCH' || method === 'DELETE') &&
        path === `/api/bots/${BOT_ID}`
      ) {
        if (!csrfOk) {
          json(response, 403, { error: { code: 'csrf_invalid' } });
          return;
        }

        json(response, 200, { bot: { ...BOT, ...payload } });
        return;
      }

      if (method === 'GET' && path === `/api/bots/${BOT_ID}/threads`) {
        json(response, 200, { threads: [THREAD], nextCursor: null });
        return;
      }

      if (method === 'POST' && path === `/api/bots/${BOT_ID}/threads`) {
        if (!csrfOk) {
          json(response, 403, { error: { code: 'csrf_invalid' } });
          return;
        }

        json(response, 201, { thread: THREAD });
        return;
      }

      if (method === 'GET' && path === `/api/bots/${BOT_ID}/memories`) {
        json(response, 200, { memories: [MEMORY], nextCursor: null });
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

        json(response, 200, {
          memory: { ...MEMORY, botApproved: true, conversationApproved: true },
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
        json(response, 200, { artifacts: [ARTIFACT], nextCursor: null });
        return;
      }

      if (method === 'POST' && path === '/api/artifacts') {
        if (!csrfOk) {
          json(response, 403, { error: { code: 'csrf_invalid' } });
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

        json(response, 200, { artifact: ARTIFACT_DETAIL });
        return;
      }

      if (method === 'GET' && path === '/api/skills') {
        json(response, 200, { skills: [SKILL], nextCursor: null });
        return;
      }

      if (method === 'POST' && path === '/api/skills') {
        if (!csrfOk) {
          json(response, 403, { error: { code: 'csrf_invalid' } });
          return;
        }

        json(response, 201, { skill: { ...SKILL, ...payload } });
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

        json(response, 200, { run: { ...RUN, status: 'cancelled' } });
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
    mode: () => mode,
    /** Forgets recorded requests; called between tests so assertions stay local. */
    clearRequests() {
      requests.length = 0;
    },
  };
}
