/**
 * H-025 scenario: VM impact.
 *
 * There is no deployed acceptance VM in this repository's current state. With
 * no host configured, the only honest result is `blocked`; this harness never
 * estimates host memory or CPU from the local container.
 *
 * When `HABI_ACCEPTANCE_VM_HOST` is set, the scenario makes a read-only SSH
 * check, looks for the Habi Compose containers, and samples `docker stats` plus
 * `/proc/stat`. If the stack is not actually running there, it stays blocked
 * rather than measuring an unrelated host workload.
 */
import { run } from '../lib/process.mjs';
import { blocked, runCheck } from './_check.mjs';

const H007_MEMORY_MIB = 1434; // 1.4 GiB across api + worker + web + postgres ceilings
const H007_CPU_PERCENT = 150; // 1.5 vCPU

function ssh(host, command, timeoutMs = 30_000) {
  return run(
    'ssh',
    [
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=5',
      '-o',
      'ServerAliveInterval=5',
      host,
      command,
    ],
    { timeoutMs },
  );
}

function parseStats(stdout) {
  const samples = [];

  for (const line of stdout.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);

    if (parts.length < 4) {
      continue;
    }

    const memory = parts[3]?.replaceAll(/[^\d.]/g, '');
    const cpu = parts[2]?.replaceAll(/[^\d.]/g, '');

    if (memory !== undefined && memory !== '' && cpu !== undefined && cpu !== '') {
      samples.push({ name: parts[0], memoryMiB: Number(memory), cpuPercent: Number(cpu) });
    }
  }

  return samples;
}

export const vmImpactScenario = {
  id: 'vm-impact',
  title: 'VM impact against the H-007 limits',
  async run() {
    const checks = [];
    const host = process.env.HABI_ACCEPTANCE_VM_HOST?.trim() ?? '';

    if (host === '') {
      checks.push(
        blocked(
          'a deployed VM is available for impact measurement',
          'HABI_ACCEPTANCE_VM_HOST is not set. No deployment exists in this repository state; the harness does not estimate host memory or CPU.',
          { hostConfigured: false },
        ),
      );

      return {
        checks,
        blockers: ['No acceptance VM host is configured.'],
        residualRisks: [
          'Local container resource use is not a VM measurement and is deliberately not reported as one.',
        ],
      };
    }

    const reachable = ssh(host, 'printf ok');

    if (reachable.status !== 0) {
      checks.push(
        blocked(
          'the configured VM is reachable',
          'SSH BatchMode failed; no measurement was taken.',
          { hostConfigured: true, reachable: false },
        ),
      );

      return {
        checks,
        blockers: ['The configured VM host was not reachable over non-interactive SSH.'],
      };
    }

    const containers = ssh(
      host,
      "docker ps --format '{{.Names}} {{.Image}}' | grep -Ei 'habi' || true",
    );
    const names = (containers.stdout ?? '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    if (names.length === 0) {
      checks.push(
        blocked(
          'the Habi stack is running on the configured VM',
          'The host is reachable but no Habi container is running; host-wide numbers would not be acceptance evidence.',
          { hostConfigured: true, reachable: true, habiContainers: 0 },
        ),
      );

      return {
        checks,
        blockers: [
          'The configured host does not run this acceptance stack; deploy it before measuring VM impact.',
        ],
      };
    }

    await runCheck(checks, 'Habi container CPU and memory stay within the H-007 caps', async () => {
      const stats = ssh(
        host,
        `docker stats --no-stream --format '{{.Name}} {{.CPUPerc}} {{.MemUsage}}' ${
          names.map((line) => line.split(/\s+/)[0]).join(' ')
        }`,
      );

      if (stats.status !== 0) {
        throw new Error(`docker stats failed: ${(stats.stderr ?? '').trim().slice(0, 500)}`);
      }

      const samples = parseStats(stats.stdout ?? '');

      if (samples.length === 0) {
        throw new Error('docker stats returned no parseable sample');
      }

      const memoryMiB = samples.reduce((total, sample) => total + sample.memoryMiB, 0);
      const cpuPercent = samples.reduce((total, sample) => total + sample.cpuPercent, 0);

      if (memoryMiB > H007_MEMORY_MIB) {
        throw new Error(
          `Habi containers used ${memoryMiB.toFixed(1)} MiB, above the ${H007_MEMORY_MIB} MiB H-007 ceiling`,
        );
      }

      if (cpuPercent > H007_CPU_PERCENT) {
        throw new Error(
          `Habi containers peaked at ${cpuPercent.toFixed(1)}% CPU, above the ${H007_CPU_PERCENT}% H-007 ceiling`,
        );
      }

      return {
        samples: samples.length,
        memoryMiB: Number(memoryMiB.toFixed(1)),
        cpuPercent: Number(cpuPercent.toFixed(1)),
        limits: { memoryMiB: H007_MEMORY_MIB, cpuPercent: H007_CPU_PERCENT },
      };
    });

    return {
      checks,
      evidence: {
        hostConfigured: true,
        habiContainers: names.length,
        measurement: 'read-only docker stats --no-stream',
      },
      residualRisks: [
        'A single short sample is not a sustained load or peak-hour measurement; it cannot prove provider CPU-policy compliance.',
      ],
    };
  },
};
