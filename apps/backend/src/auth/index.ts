export { AuthModule } from './auth.module.js';
export { authSpikeModules } from './auth-spike-modules.js';
export {
  AUTH_SPIKE_ENV,
  REGISTRATION_MODE_ENV,
  isAuthSpikeEnabled,
  readRegistrationMode,
  type RegistrationMode,
} from './auth-config.js';
export { AuthError, authErrorBody, type AuthErrorCode } from './auth-errors.js';
export { canonicalizeEmail, MAX_EMAIL_LENGTH } from './email.js';
export {
  DUMMY_PASSWORD_HASH,
  hashPassword,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  validatePassword,
  verifyPassword,
  type PasswordPolicyFailure,
} from './password.js';
export { hashToken, mintToken, TOKEN_HASH_PATTERN } from './tokens.js';
export {
  AUTH_RATE_LIMITS,
  FixedWindowRateLimiter,
  rateLimitKey,
  type RateLimitDecision,
  type RateLimitRule,
} from './rate-limit.js';
export type {
  AuthRequestContext,
  AuthServiceOptions,
  LoginInput,
  RecoveryRequestInput,
  SignupInput,
} from './auth-service.js';
export { AuthService, RECOVERY_TOKEN_TTL_MS } from './auth-service.js';
export type {
  AuthAccount,
  AuthCredential,
  AuthIdentity,
  AuthRepositoryPort,
  AuthSessionResult,
  CreateAccountWithInviteInput,
  CreateRecoveryTokenInput,
} from './auth-types.js';
export type {
  AuthSessionObserver,
  AuthSessionPort,
  IssuedAuthSession,
} from './auth-session-port.js';
export { AUTH_SESSION_PORT } from './auth-session-port.js';
export { CoreSessionPort } from './core-session-port.js';
export { AuthRepository } from './auth-repository.js';
export { AuthRuntime } from './auth-runtime.js';
export { AuthSpikeGuard } from './auth-spike.guard.js';
