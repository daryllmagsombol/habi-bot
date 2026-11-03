/**
 * Spike-only. Not product code. Enabled only when HABI_SPIKE_MODE=1.
 *
 * Fixture bearer-token authentication for the two-user ownership spike. The
 * two opaque tokens are deliberately hard-coded and insecure: they exist only
 * to give local tests two distinct identities. No client-supplied user id is
 * ever read; identity comes solely from the token map.
 */
import { Injectable, UnauthorizedException } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

const FIXTURE_TOKENS: ReadonlyMap<string, string> = new Map([
  ['spike-token-a', 'user-a'],
  ['spike-token-b', 'user-b'],
]);

export interface SpikeRequest extends Request {
  spikeUserId?: string;
}

function readBearerToken(header: string | undefined): string | undefined {
  if (typeof header !== 'string') {
    return undefined;
  }

  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1];
}

@Injectable()
export class SpikeAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<SpikeRequest>();
    const token = readBearerToken(request.headers.authorization);
    const userId = token === undefined ? undefined : FIXTURE_TOKENS.get(token);

    if (userId === undefined) {
      throw new UnauthorizedException({ error: { code: 'unauthenticated' } });
    }

    request.spikeUserId = userId;
    return true;
  }
}

export function getSpikeUserId(request: SpikeRequest): string {
  if (request.spikeUserId === undefined) {
    throw new UnauthorizedException({ error: { code: 'unauthenticated' } });
  }

  return request.spikeUserId;
}
