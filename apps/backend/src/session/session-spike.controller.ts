/**
 * Session spike surface for H-017 (#17). Not product authentication.
 *
 * Enabled only when HABI_SESSION_SPIKE=1; AppModule does not import the module
 * otherwise, so none of these routes exist in the default app.
 *
 * Fixture tokens (`session-fixture-a` / `session-fixture-b`) stand in for a
 * real authentication result until #14 ships login. They are deliberately
 * hard-coded and insecure, exactly like the H-005 spike fixtures: they exist
 * only to give local tests two identities. No password is verified, no DB is
 * touched, and no session id is ever placed in a JSON body.
 */
import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { SessionAuthGuard } from './session-auth.guard.js';
import { SessionCsrfGuard } from './session-csrf.guard.js';
import {
  clearSessionCookie,
  isProductionEnvironment,
  readRequestSessionCookie,
  serializeSessionCookie,
} from './session-cookie.js';
import { readBearerToken, readUserAgent, requestNow, requireSession } from './session-request.js';
import type { SessionRequest } from './session-request.js';
import { SessionService, toSessionView } from './session.service.js';
import type { IssuedSession, SessionObserver, SessionView } from './session.service.js';

/** Test fixtures only. Real authentication is #14. */
const FIXTURE_TOKENS: ReadonlyMap<string, string> = new Map([
  ['session-fixture-a', 'user-a'],
  ['session-fixture-b', 'user-b'],
]);

interface SessionResponseBody {
  user: { userId: string };
  csrfToken: string;
  session: SessionView;
}

function cookieMaxAgeSeconds(issued: IssuedSession, at: number): number {
  return Math.floor((issued.record.absoluteExpiresAt - at) / 1000);
}

function writeSessionCookie(
  response: Response,
  issued: IssuedSession,
  at: number,
  production = isProductionEnvironment(),
): void {
  response.setHeader(
    'set-cookie',
    serializeSessionCookie(issued.sessionId, cookieMaxAgeSeconds(issued, at), production),
  );
}

@Controller('session-spike')
export class SessionSpikeController {
  constructor(@Inject(SessionService) private readonly sessions: SessionService) {}

  /**
   * Bootstraps a fixture identity into a brand-new session family. A session
   * cookie the client already holds is never adopted (fixation, design §6).
   */
  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(
    @Req() request: SessionRequest,
    @Res({ passthrough: true }) response: Response,
  ): SessionResponseBody {
    const fixtureToken = readBearerToken(request.headers.authorization);
    const userId = fixtureToken === undefined ? undefined : FIXTURE_TOKENS.get(fixtureToken);

    if (userId === undefined) {
      throw new UnauthorizedException({ error: { code: 'unauthenticated' } });
    }

    const at = requestNow(request);
    const observer: SessionObserver = {};
    const userAgent = readUserAgent(request);

    if (userAgent !== undefined) {
      observer.userAgent = userAgent;
    }

    if (typeof request.ip === 'string') {
      observer.ip = request.ip;
    }

    const issued = this.sessions.create(userId, observer, at);

    writeSessionCookie(response, issued, at);
    response.setHeader('x-csrf-token', issued.csrfToken);

    return {
      user: { userId: issued.record.userId },
      csrfToken: issued.csrfToken,
      session: toSessionView(issued.record, true),
    };
  }

  /** Returns the synchronizer token bound to the validated session. */
  @Get('csrf')
  @UseGuards(SessionAuthGuard)
  getCsrf(
    @Req() request: SessionRequest,
    @Res({ passthrough: true }) response: Response,
  ): { csrfToken: string } {
    const { record } = requireSession(request);

    response.setHeader('x-csrf-token', record.csrfToken);
    return { csrfToken: record.csrfToken };
  }

  @Get('me')
  @UseGuards(SessionAuthGuard)
  getMe(@Req() request: SessionRequest): {
    user: { userId: string };
    session: SessionView;
  } {
    const session = requireSession(request);

    return {
      user: { userId: session.userId },
      session: toSessionView(session.record, true),
    };
  }

  /** Single-use rotation: the presented secret stops working immediately. */
  @Post('rotate')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SessionAuthGuard, SessionCsrfGuard)
  rotate(
    @Req() request: SessionRequest,
    @Res({ passthrough: true }) response: Response,
  ): SessionResponseBody {
    const sessionId = readRequestSessionCookie(request);

    if (sessionId === undefined) {
      throw new UnauthorizedException({ error: { code: 'unauthenticated' } });
    }

    const at = requestNow(request);
    const issued = this.sessions.rotate(sessionId, at);

    if (issued === undefined) {
      throw new UnauthorizedException({ error: { code: 'unauthenticated' } });
    }

    writeSessionCookie(response, issued, at);
    response.setHeader('x-csrf-token', issued.csrfToken);

    return {
      user: { userId: issued.record.userId },
      csrfToken: issued.csrfToken,
      session: toSessionView(issued.record, true),
    };
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SessionAuthGuard, SessionCsrfGuard)
  logout(
    @Req() request: SessionRequest,
    @Res({ passthrough: true }) response: Response,
  ): { ok: true } {
    const sessionId = readRequestSessionCookie(request);

    if (sessionId !== undefined) {
      this.sessions.revoke(sessionId, requestNow(request));
    }

    response.setHeader('set-cookie', clearSessionCookie());
    return { ok: true };
  }

  /** Revokes every live session for the caller, across devices. */
  @Post('logout-all')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SessionAuthGuard, SessionCsrfGuard)
  logoutAll(
    @Req() request: SessionRequest,
    @Res({ passthrough: true }) response: Response,
  ): { ok: true; revoked: number } {
    const { userId } = requireSession(request);
    const revoked = this.sessions.revokeAllForUser(userId, requestNow(request));

    response.setHeader('set-cookie', clearSessionCookie());
    return { ok: true, revoked };
  }

  /** Self-scoped device list: live records for the caller only. */
  @Get('sessions')
  @UseGuards(SessionAuthGuard)
  listSessions(@Req() request: SessionRequest): { sessions: SessionView[] } {
    const session = requireSession(request);
    const at = requestNow(request);

    return {
      sessions: this.sessions
        .listForUser(session.userId, at)
        .map((record) => toSessionView(record, record.recordId === session.record.recordId)),
    };
  }
}
