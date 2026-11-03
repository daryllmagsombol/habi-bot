#!/usr/bin/env node
/**
 * H-010 release secret scan.
 *
 * Deterministic, offline repository scan for committed credentials. It reads
 * only files tracked by git (`git ls-files`), so untracked local `.env` files
 * and build output cannot create findings, and it needs no network access,
 * provider token, or third-party service.
 *
 * Findings never print the matched value: only the rule id and file:line are
 * reported, so a real credential cannot be copied into CI logs.
 *
 * Usage:
 *   node scripts/ci/release-secret-scan.mjs [--root <dir>] [--max-bytes <n>] [--help]
 *
 * Exit codes: 0 clean, 1 findings, 2 usage or preflight failure.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const SCRIPT_PATH = fileURLToPath(import.meta.url);
export const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..', '..');
export const EXIT_OK = 0;
export const EXIT_FINDINGS = 1;
export const EXIT_USAGE = 2;
/** Files above this size are skipped rather than scanned; they are build output, not source. */
export const MAX_FILE_BYTES = 1_048_576;
/** A NUL byte in the leading bytes marks a binary asset, which is not scanned. */
export const BINARY_SNIFF_BYTES = 8_000;
export const ENV_EXAMPLE_FILENAME = '.env.example';

/**
 * Credential patterns. Each rule is high signal on purpose: a false positive
 * makes the required check untrustworthy, so generic value matching is limited
 * to keyword assignments and skips deliberate test fixtures.
 */
export const FINDING_RULES = [
  {
    id: 'private-key-block',
    description: 'PEM or OpenSSH private key block',
    pattern: /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/g,
  },
  {
    id: 'aws-access-key-id',
    description: 'AWS access key identifier',
    pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g,
  },
  {
    id: 'github-token',
    description: 'GitHub personal access or app token',
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/g,
  },
  {
    id: 'slack-token',
    description: 'Slack API token',
    pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g,
  },
  {
    id: 'google-api-key',
    description: 'Google API key',
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
  },
  {
    id: 'stripe-live-key',
    description: 'Stripe live secret or restricted key',
    pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/g,
  },
  {
    id: 'openai-api-key',
    description: 'OpenAI API key',
    pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/g,
  },
  {
    id: 'anthropic-api-key',
    description: 'Anthropic API key',
    pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    id: 'npm-token',
    description: 'npm automation token',
    pattern: /\bnpm_[A-Za-z0-9]{36}\b/g,
  },
  {
    id: 'assigned-credential',
    description: 'credential-like value assigned to a credential keyword',
    // Deliberate fake credentials live in test fixtures; provider-pattern rules
    // still scan test files, only this generic rule skips them.
    skipTestFiles: true,
    valueGroup: 1,
    pattern:
      /\b(?:api[_-]?key|secret|passwd|password|token|access[_-]?token|auth[_-]?token|client[_-]?secret)\b\s*[:=]\s*["'`]?([A-Za-z0-9_+/=.~!@#$%^&*-]{16,})["'`]?/gi,
  },
];

/** Lower-case placeholders that are documentation, not credentials. */
export const PLACEHOLDER_PREFIXES = [
  'replace',
  'change',
  'example',
  'placeholder',
  'dummy',
  'redacted',
  'your',
  'test',
  'fake',
  'sample',
  'xxxx',
];

export function isTestFixturePath(relativePath) {
  return (
    /(^|\/)(?:test|tests|__tests__|fixtures|__fixtures__)\//.test(relativePath) ||
    /\.(?:test|spec)\.[A-Za-z0-9]+$/.test(relativePath)
  );
}

/**
 * True for tracked environment files that must never be committed.
 * `.env.example` is documentation and is allowed; every other `.env` or
 * `.env.*` name is a finding.
 */
export function isDotEnvFile(relativePath) {
  const base = path.posix.basename(relativePath);
  if (base === ENV_EXAMPLE_FILENAME) {
    return false;
  }
  return /^\.env(?:$|\.)/.test(base);
}

export function isPlaceholderValue(value) {
  const normalized = value.toLowerCase();
  return (
    PLACEHOLDER_PREFIXES.some((prefix) => normalized.startsWith(prefix)) ||
    /^(?:<\$\{|\$\{|\{\{|<)/.test(value) ||
    value.includes('...') ||
    /^(.)\1{3,}$/.test(value)
  );
}

/**
 * True when an assigned value is a reference to another variable rather than a
 * literal credential, for example `process.env.GITHUB_TOKEN`, `env.TOKEN`, or a
 * constant identifier. References are not findings.
 */
export function isVariableReference(value) {
  return (
    /^(?:process|env|os|window|globalThis|import)\./.test(value) ||
    /^process\[/.test(value) ||
    /^(?:[A-Za-z_$][\w$]*\.)+[A-Za-z_$][\w$]*$/.test(value) ||
    /^[A-Z][A-Z0-9_]{15,}$/.test(value) ||
    /^[a-z][A-Za-z0-9_]*[A-Z][A-Za-z0-9_]*$/.test(value)
  );
}

export function isBinaryContent(buffer) {
  return buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

/**
 * Scans one text file and returns findings without the matched secret values.
 */
export function scanText(relativePath, text) {
  const findings = [];
  const testFixture = isTestFixturePath(relativePath);
  const lines = text.split('\n');
  /** Lines already matched by a specific provider rule; the generic rule is a fallback. */
  const providerLines = new Set();

  for (const rule of FINDING_RULES) {
    if (rule.skipTestFiles && testFixture) {
      continue;
    }
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      for (const match of line.matchAll(pattern)) {
        if (rule.valueGroup) {
          const value = match[rule.valueGroup] ?? '';
          if (value.length < 16 || isPlaceholderValue(value) || isVariableReference(value)) {
            continue;
          }
          if (providerLines.has(index)) {
            continue;
          }
        }
        findings.push({ rule: rule.id, path: relativePath, line: index + 1 });
        if (!rule.valueGroup) {
          providerLines.add(index);
        }
      }
    }
  }

  return findings;
}

/**
 * Lists tracked files from git, newest index state included, without touching
 * the filesystem walk order or untracked files.
 */
export function collectTrackedFiles(root) {
  const result = spawnSync('git', ['-C', root, 'ls-files', '-z', '--cached'], {
    encoding: 'buffer',
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    maxBuffer: 32 * 1_048_576,
  });

  if (result.error || result.status !== 0) {
    throw new UsageError(
      `git ls-files failed in ${root}: ${(result.stderr ?? '').toString().trim() || result.error?.message || 'unknown error'}`,
    );
  }

  return result.stdout
    .toString('utf8')
    .split('\0')
    .filter((entry) => entry.length > 0)
    .sort();
}

/**
 * Scans every tracked text file under `root`. Returns findings plus counters
 * for the summary line, and never throws for an unreadable skipped file.
 */
export function scanRepository(root, { maxBytes = MAX_FILE_BYTES } = {}) {
  const tracked = collectTrackedFiles(root);
  const findings = [];
  const skipped = [];

  for (const relativePath of tracked) {
    if (isDotEnvFile(relativePath)) {
      findings.push({ rule: 'dotenv-file', path: relativePath, line: 1 });
      continue;
    }

    const absolutePath = path.join(root, relativePath);
    let stat;
    try {
      stat = statSync(absolutePath);
    } catch {
      skipped.push({ path: relativePath, reason: 'unreadable' });
      continue;
    }
    if (!stat.isFile()) {
      skipped.push({ path: relativePath, reason: 'not-a-regular-file' });
      continue;
    }
    if (stat.size > maxBytes) {
      skipped.push({ path: relativePath, reason: `size ${stat.size} > ${maxBytes}` });
      continue;
    }

    let buffer;
    try {
      buffer = readFileSync(absolutePath);
    } catch {
      skipped.push({ path: relativePath, reason: 'unreadable' });
      continue;
    }
    if (isBinaryContent(buffer)) {
      skipped.push({ path: relativePath, reason: 'binary' });
      continue;
    }

    findings.push(...scanText(relativePath, buffer.toString('utf8')));
  }

  return { trackedCount: tracked.length, findings, skipped };
}

export class UsageError extends Error {}

export function parseArgs(argv) {
  const options = { root: REPO_ROOT, maxBytes: MAX_FILE_BYTES, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--root') {
      const value = argv[index + 1];
      if (!value) throw new UsageError('--root requires a directory.');
      options.root = path.resolve(value);
      index += 1;
    } else if (arg === '--max-bytes') {
      const value = Number(argv[index + 1]);
      if (!Number.isInteger(value) || value <= 0) {
        throw new UsageError('--max-bytes requires a positive integer.');
      }
      options.maxBytes = value;
      index += 1;
    } else {
      throw new UsageError(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

export function formatFinding(finding) {
  return `release-secret-scan: finding rule=${finding.rule} file=${finding.path}:${finding.line}`;
}

export function usageText() {
  return [
    'Usage: node scripts/ci/release-secret-scan.mjs [--root <dir>] [--max-bytes <n>] [--help]',
    '',
    'Scans files tracked by git for committed credential patterns and .env files.',
    'Tracked .env.example is allowed; matched values are never printed.',
  ].join('\n');
}

export function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`release-secret-scan: ${error.message}`);
      console.error(usageText());
      return EXIT_USAGE;
    }
    throw error;
  }

  if (options.help) {
    console.log(usageText());
    return EXIT_OK;
  }

  let result;
  try {
    result = scanRepository(options.root, { maxBytes: options.maxBytes });
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`release-secret-scan: ${error.message}`);
      return EXIT_USAGE;
    }
    throw error;
  }

  for (const skipped of result.skipped) {
    console.log(`release-secret-scan: skipped ${skipped.path} (${skipped.reason})`);
  }
  for (const finding of result.findings) {
    console.log(formatFinding(finding));
  }

  const scannedCount = result.trackedCount - result.skipped.length;
  console.log(
    `release-secret-scan: scanned ${scannedCount}/${result.trackedCount} tracked file(s), ${result.findings.length} finding(s)`,
  );

  if (result.findings.length > 0) {
    console.error('release-secret-scan: committed credentials or .env files found; remove them before merging.');
    return EXIT_FINDINGS;
  }

  return EXIT_OK;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  process.exitCode = main();
}
