/**
 * Per-request flag check for the auth slice.
 *
 * `AuthModule` is meant to be imported only when `HABI_AUTH_SPIKE=1`
 * (`authSpikeModules`). This guard is the second control: if the module is ever
 * imported unconditionally, every auth route still behaves as absent. It runs
 * before session validation so a disabled surface reveals nothing about the
 * caller's cookie.
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import type { CanActivate } from '@nestjs/common';
import { isAuthSpikeEnabled } from './auth-config.js';

@Injectable()
export class AuthSpikeGuard implements CanActivate {
  canActivate(): boolean {
    if (!isAuthSpikeEnabled()) {
      throw new NotFoundException({ error: { code: 'not_found' } });
    }

    return true;
  }
}
