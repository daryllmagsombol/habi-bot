import { authScenario } from './auth.mjs';
import { backupRestoreScenario } from './backup-restore.mjs';
import { isolationScenario } from './isolation.mjs';
import { providerExhaustionScenario } from './provider-exhaustion.mjs';
import { reconnectScenario } from './reconnect.mjs';
import { runLifecycleScenario } from './run-lifecycle.mjs';
import { ssoScenario } from './sso.mjs';
import { vmImpactScenario } from './vm-impact.mjs';

/**
 * Execution order is deliberate: isolation first (the hard gate), then the
 * session/auth surface, then streaming and lifecycle behavior, then backup
 * restore, then environment-only checks that do not depend on Docker.
 */
export const scenarios = [
  isolationScenario,
  authScenario,
  ssoScenario,
  reconnectScenario,
  runLifecycleScenario,
  providerExhaustionScenario,
  backupRestoreScenario,
  vmImpactScenario,
];

export const scenarioIds = scenarios.map((scenario) => scenario.id);
