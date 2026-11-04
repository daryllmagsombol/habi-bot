/**
 * Structured worker logging.
 *
 * One JSON object per line, same shape as the API's runtime logs. Entries carry
 * Run identifiers and normalized codes only: never prompt text, session data,
 * provider payloads, or the Hermes gateway key.
 */
export interface WorkerLogEntry {
  readonly event: string;
  readonly [field: string]: unknown;
}

export interface WorkerLogger {
  log(entry: WorkerLogEntry): void;
}

export const consoleJsonLogger: WorkerLogger = {
  log(entry: WorkerLogEntry): void {
    console.log(JSON.stringify(entry));
  },
};

export const silentWorkerLogger: WorkerLogger = {
  log(): void {
    // Test/diagnostic logger: the caller inspects state, not log output.
  },
};
