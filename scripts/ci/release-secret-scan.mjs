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
import { existsSync, readFileSync, statSync } from 'node:fs';
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
 * The scanner's own `git` subprocess never inherits the caller's PATH or other
 * environment: only these system directories are searched for `git`.
 */
export const SYSTEM_PATH_DIRECTORIES = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];

/**
 * Credential patterns. Each rule is high signal on purpose: a false positive
 * makes the required check untrustworthy, so generic value matching is limited
 * to keyword assignments and skips deliberate test fixtures.
 *
 * These rules are literal provider prefixes only, so a match is always a
 * credential regardless of where it appears.
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
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_\w{40,})\b/g,
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
];

/**
 * Keyword shapes accepted before an assigned literal value. The shape is
 * deliberately loose and is narrowed to the exact documented keyword set by
 * `CREDENTIAL_KEYWORDS`, so no extra keywords are reported.
 */
const CREDENTIAL_KEYWORD_PATTERN = /\b(?:api|access|auth|client)?[_-]?(?:key|token|secret|passwd|password)\b/gi;

/** Assignment keywords the generic rule accepts, compared with `_`/`-` removed. */
const CREDENTIAL_KEYWORDS = new Set([
  'apikey',
  'secret',
  'passwd',
  'password',
  'token',
  'accesstoken',
  'authtoken',
  'clientsecret',
]);

/** An assignment operator followed by a long literal value; matched sticky. */
const CREDENTIAL_VALUE_PATTERN = /\s*[:=]\s*["'`]?([\w+/=.~!@#$%^&*-]{16,})["'`]?/y;

/** Rule id for a credential-like literal assigned to a credential keyword. */
export const ASSIGNED_CREDENTIAL_RULE = 'assigned-credential';

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

/** Identifier characters only; one unbounded quantifier keeps matching linear. */
const IDENTIFIER_SHAPE_PATTERN = /^\w+$/;
const LOWERCASE_FIRST_PATTERN = /^[a-z]/;
const UPPERCASE_PATTERN = /[A-Z]/;

/**
 * True for camelCase-like identifiers: an identifier-shaped value that starts
 * lowercase and contains an uppercase letter. The shape, prefix, and uppercase
 * checks are separate so no nested quantifier can backtrack super-linearly on
 * untrusted input.
 */
export function isCamelCaseIdentifier(value) {
  return (
    IDENTIFIER_SHAPE_PATTERN.test(value) &&
    LOWERCASE_FIRST_PATTERN.test(value) &&
    UPPERCASE_PATTERN.test(value)
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
    value.startsWith('process[') ||
    /^(?:[A-Za-z_$][\w$]*\.)+[A-Za-z_$][\w$]*$/.test(value) ||
    /^[A-Z][A-Z0-9_]{15,}$/.test(value) ||
    isCamelCaseIdentifier(value)
  );
}

export function isBinaryContent(buffer) {
  return buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

/** Runs a single boolean match on a line, resetting any global `lastIndex`. */
function lineMatches(pattern, line) {
  pattern.lastIndex = 0;
  return pattern.test(line);
}

/** Collects provider-pattern findings and records the lines they occupy. */
function collectProviderFindings(lines, providerLines) {
  const findings = [];
  for (const rule of FINDING_RULES) {
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
    for (let index = 0; index < lines.length; index += 1) {
      if (!lineMatches(pattern, lines[index])) {
        continue;
      }
      findings.push({ rule: rule.id, line: index + 1 });
      providerLines.add(index);
    }
  }
  return findings;
}

/** Strips keyword separators so `api-key`, `api_key`, and `apikey` agree. */
function normalizeKeyword(keyword) {
  return keyword.toLowerCase().replaceAll(/[_-]/g, '');
}

/**
 * True when a line assigns a long literal value to an accepted credential
 * keyword. The value is inspected in place and never returned or logged.
 */
function hasAssignedCredential(line) {
  for (const match of line.matchAll(CREDENTIAL_KEYWORD_PATTERN)) {
    if (!CREDENTIAL_KEYWORDS.has(normalizeKeyword(match[0]))) {
      continue;
    }
    CREDENTIAL_VALUE_PATTERN.lastIndex = match.index + match[0].length;
    const assigned = CREDENTIAL_VALUE_PATTERN.exec(line);
    if (!assigned) {
      continue;
    }
    const value = assigned[1] ?? '';
    if (isPlaceholderValue(value) || isVariableReference(value)) {
      continue;
    }
    return true;
  }
  return false;
}

/** Generic fallback rule, limited to lines no provider rule already claimed. */
function collectAssignedFindings(lines, providerLines) {
  const findings = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (providerLines.has(index) || !hasAssignedCredential(lines[index])) {
      continue;
    }
    findings.push({ rule: ASSIGNED_CREDENTIAL_RULE, line: index + 1 });
  }
  return findings;
}

/**
 * Scans one text file and returns findings without the matched secret values.
 */
export function scanText(relativePath, text) {
  const lines = text.split('\n');
  /** Lines already matched by a specific provider rule; the generic rule is a fallback. */
  const providerLines = new Set();

  const findings = collectProviderFindings(lines, providerLines);
  // Deliberate fake credentials live in test fixtures; provider-pattern rules
  // still scan test files, only the generic rule skips them.
  if (!isTestFixturePath(relativePath)) {
    findings.push(...collectAssignedFindings(lines, providerLines));
  }

  return findings.map((finding) => ({ ...finding, path: relativePath }));
}

/**
 * The fixed environment for the scanner's `git` subprocess: an explicit PATH
 * containing only existing system directories, with nothing inherited from the
 * caller's environment.
 */
export function scannerEnvironment() {
  return {
    PATH: SYSTEM_PATH_DIRECTORIES.filter((directory) => existsSync(directory)).join(path.delimiter),
    LC_ALL: 'C',
    GIT_OPTIONAL_LOCKS: '0',
  };
}

/**
 * Resolves the `git` executable from the fixed system directories instead of a
 * PATH lookup, so an untrusted PATH cannot select the binary that runs.
 */
export function resolveGitExecutable() {
  const executable = SYSTEM_PATH_DIRECTORIES.map((directory) => path.join(directory, 'git')).find((candidate) =>
    existsSync(candidate),
  );
  if (!executable) {
    throw new UsageError('git executable not found in the system directories.');
  }
  return executable;
}

/**
 * Lists tracked files from git, newest index state included, without touching
 * the filesystem walk order or untracked files.
 */
export function collectTrackedFiles(root) {
  const result = spawnSync(resolveGitExecutable(), ['-C', root, 'ls-files', '-z', '--cached'], {
    encoding: 'buffer',
    env: scannerEnvironment(),
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
    .sort((left, right) => left.localeCompare(right));
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
