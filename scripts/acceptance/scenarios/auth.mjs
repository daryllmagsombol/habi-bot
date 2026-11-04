/**
 * H-025 scenario: signup, login, logout, recovery, and session continuity.
 *
 * Runs the real auth HTTP surface in a child API process against the same
 * disposable database. Also checks the one thing a unit test cannot: whether a
 * session issued by `/auth/login` is accepted by the P1 chat surface when both
 * modules are enabled in one deployment.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createClient, sessionFromResponse, startApiChild } from '../lib/http.mjs';
import { runCheck } from './_check.mjs';

const PASSWORD = 'acceptance horse battery staple';
const KNOWN_EMAIL = 'known-acceptance@example.test';
const UNKNOWN_EMAIL = 'unknown-acceptance@example.test';

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

async function seedInvite(pool, email) {
  const token = randomBytes(32).toString('base64url');

  await pool.query(
    `INSERT INTO invites (email, token_hash, expires_at)
     VALUES ($1, $2, now() + interval '1 hour')`,
    [email, hashToken(token)],
  );

  return token;
}

function expectCode(result, status, code, label) {
  assert.equal(result.status, status, `${label}: the server said ${result.status}`);
  assert.deepEqual(result.body, { error: { code } }, `${label}: body`);
}

export const authScenario = {
  id: 'auth',
  title: 'Signup, login, logout, recovery, and session continuity',
  async run(ctx) {
    const checks = [];
    const api = await startApiChild({
      HABI_AUTH_SPIKE: '1',
      HABI_P1_API: '1',
      DATABASE_URL: ctx.postgres.url,
    });

    try {
      const request = createClient(api.base);
      const invite = await seedInvite(ctx.pool, KNOWN_EMAIL);
      let signupSession;

      await runCheck(checks, 'signup creates an account and a real session', async () => {
        const result = await request('/auth/signup', {
          body: {
            email: KNOWN_EMAIL,
            password: PASSWORD,
            inviteToken: invite,
          },
        });

        assert.equal(result.status, 201, JSON.stringify(result.body));
        signupSession = sessionFromResponse(result);
        assert.ok(signupSession.cookie, 'signup must set the session cookie');
        assert.ok(signupSession.csrfToken, 'signup must return a CSRF token');

        const me = await createClient(api.base, signupSession)('/auth/me');

        assert.equal(me.status, 200);
        assert.equal(me.body.user.email, KNOWN_EMAIL);

        return {
          status: result.status,
          setCookie: true,
          csrfHeader: true,
          meStatus: me.status,
          userId: me.body.user.userId,
        };
      });

      await runCheck(checks, 'an invite is single-use', async () => {
        const result = await request('/auth/signup', {
          body: {
            email: KNOWN_EMAIL,
            password: PASSWORD,
            inviteToken: invite,
          },
        });

        expectCode(result, 409, 'signup_unavailable', 'reused invite');

        return { status: result.status, code: result.body.error.code };
      });

      await runCheck(checks, 'unknown email and wrong password are indistinguishable', async () => {
        const wrong = await request('/auth/login', {
          body: { email: KNOWN_EMAIL, password: 'wrong password value' },
        });
        const unknown = await request('/auth/login', {
          body: { email: UNKNOWN_EMAIL, password: 'wrong password value' },
        });

        expectCode(wrong, 401, 'invalid_credentials', 'wrong password');
        expectCode(unknown, 401, 'invalid_credentials', 'unknown email');

        return {
          wrongPassword: { status: wrong.status, code: wrong.body.error.code },
          unknownEmail: { status: unknown.status, code: unknown.body.error.code },
          identicalBodies: JSON.stringify(wrong.body) === JSON.stringify(unknown.body),
        };
      });

      let loginSession;

      await runCheck(checks, 'login issues a new usable session', async () => {
        const result = await request('/auth/login', {
          body: { email: KNOWN_EMAIL, password: PASSWORD },
        });

        assert.equal(result.status, 200, JSON.stringify(result.body));
        loginSession = sessionFromResponse(result);
        assert.ok(loginSession.cookie);
        assert.ok(loginSession.csrfToken);

        const me = await createClient(api.base, loginSession)('/auth/me');

        assert.equal(me.status, 200);

        return { status: result.status, meStatus: me.status, newSession: true };
      });

      await runCheck(checks, 'logout requires CSRF and revokes the session', async () => {
        const withoutCsrf = await createClient(api.base, signupSession)('/auth/logout', {
          method: 'POST',
        });

        assert.equal(withoutCsrf.status, 403);
        assert.equal(withoutCsrf.body.error.code, 'csrf_invalid');

        const withCsrf = await createClient(api.base, signupSession)('/auth/logout', {
          method: 'POST',
          csrf: true,
        });

        assert.equal(withCsrf.status, 200);
        assert.deepEqual(withCsrf.body, { ok: true });

        const after = await createClient(api.base, signupSession)('/auth/me');

        assert.equal(after.status, 401);

        return {
          withoutCsrf: withoutCsrf.status,
          withCsrf: withCsrf.status,
          afterLogoutMe: after.status,
        };
      });

      await runCheck(checks, 'recovery is acknowledgement-only for known and unknown addresses', async () => {
        const before = await ctx.pool.query(
          'SELECT count(*)::int AS count FROM password_reset_tokens',
        );
        const known = await request('/auth/recovery/request', {
          body: { email: KNOWN_EMAIL },
        });
        const unknown = await request('/auth/recovery/request', {
          body: { email: UNKNOWN_EMAIL },
        });
        const after = await ctx.pool.query(
          'SELECT count(*)::int AS count FROM password_reset_tokens',
        );

        assert.equal(known.status, 200);
        assert.equal(unknown.status, 200);
        assert.deepEqual(known.body, { ok: true });
        assert.deepEqual(unknown.body, { ok: true });
        assert.equal(after.rows[0].count, before.rows[0].count + 1);

        const tokenShape = await ctx.pool.query(
          `SELECT token_hash ~ '^[0-9a-f]{64}$' AS shaped
             FROM password_reset_tokens
            ORDER BY created_at DESC
            LIMIT 1`,
        );

        assert.equal(tokenShape.rows[0]?.shaped, true, 'stored token must be hashed');

        return {
          knownStatus: known.status,
          unknownStatus: unknown.status,
          tokensAdded: after.rows[0].count - before.rows[0].count,
          storedTokenIsHashed: true,
          responseCarriesToken: false,
        };
      });

      // This is the integration check a per-module unit test cannot make. The
      // auth module and the P1 API module each provide their own in-memory
      // SessionService, so a login cookie is expected to be accepted here only
      // if deployment wiring shares one session core.
      await runCheck(
        checks,
        'login session is accepted by the P1 chat surface',
        async () => {
          const result = await createClient(api.base, loginSession)('/api/bots');

          assert.equal(
            result.status,
            200,
            `login session reached /api/bots as ${result.status} ` +
              `(${JSON.stringify(result.body)}); auth and chat do not share a session store`,
          );

          return { status: result.status, botCount: result.body.bots.length };
        },
      );
    } finally {
      await api.stop();
    }

    return {
      checks,
      evidence: {
        apiBase: '127.0.0.1 (child process, ephemeral port)',
        email: KNOWN_EMAIL,
        rawPasswordIncluded: false,
        rawInviteTokenIncluded: false,
      },
      residualRisks: [
        'Email delivery is not implemented; recovery records a hashed token but no message is sent.',
        'Auth and chat each own an in-memory SessionService in this commit; logout is not shared across those modules either.',
        'Auth rate limits are in-process, not a distributed deployment control.',
      ],
    };
  },
};
