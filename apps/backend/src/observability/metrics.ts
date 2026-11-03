/**
 * In-process request counters for H-013 (#13), plus a Prometheus text
 * formatter.
 *
 * Deliberately small: counts by status class, current in-flight requests, and
 * a duration sum/count pair. There is no HTTP route, no persistence, and no
 * background exporter yet, so nothing here is a metric stack that outgrows a
 * shared VM. Values reset on process restart and are per process; a scrape
 * endpoint, aggregation, and retention remain open work on #13.
 */
import { Inject, Injectable } from '@nestjs/common';
import { OBSERVABILITY_CONFIG } from './observability-config.js';
import type { ObservabilityConfig } from './observability-config.js';

export const METRIC_PREFIX = 'habi';

export type StatusClass = '1xx' | '2xx' | '3xx' | '4xx' | '5xx' | 'other';

const STATUS_CLASSES: readonly StatusClass[] = Object.freeze([
  '1xx',
  '2xx',
  '3xx',
  '4xx',
  '5xx',
  'other',
]);

export function statusClassOf(status: number): StatusClass {
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    return 'other';
  }

  const candidate = `${Math.trunc(status / 100)}xx`;
  return STATUS_CLASSES.find((value) => value === candidate) ?? 'other';
}

export interface MetricsSnapshot {
  readonly service: string;
  readonly inFlight: number;
  readonly total: number;
  readonly byStatusClass: Readonly<Record<StatusClass, number>>;
  readonly durationMsSum: number;
  readonly durationMsCount: number;
}

@Injectable()
export class RequestMetrics {
  private readonly service: string;
  private readonly counters = new Map<StatusClass, number>();
  private inFlight = 0;
  private durationMsSum = 0;
  private durationMsCount = 0;

  constructor(@Inject(OBSERVABILITY_CONFIG) config: ObservabilityConfig) {
    this.service = config.service;
  }

  beginRequest(): void {
    this.inFlight += 1;
  }

  endRequest(status: number, durationMs: number): void {
    if (this.inFlight > 0) {
      this.inFlight -= 1;
    }

    const statusClass = statusClassOf(status);
    this.counters.set(statusClass, (this.counters.get(statusClass) ?? 0) + 1);

    if (Number.isFinite(durationMs) && durationMs >= 0) {
      this.durationMsSum += durationMs;
      this.durationMsCount += 1;
    }
  }

  snapshot(): MetricsSnapshot {
    const byStatusClass = Object.fromEntries(
      STATUS_CLASSES.map((statusClass) => [
        statusClass,
        this.counters.get(statusClass) ?? 0,
      ]),
    ) as Record<StatusClass, number>;

    let total = 0;

    for (const statusClass of STATUS_CLASSES) {
      total += byStatusClass[statusClass];
    }

    return {
      service: this.service,
      inFlight: this.inFlight,
      total,
      byStatusClass,
      durationMsSum: this.durationMsSum,
      durationMsCount: this.durationMsCount,
    };
  }

  /** Prometheus text exposition format (version 0.0.4), newline-terminated. */
  toPrometheus(): string {
    const snapshot = this.snapshot();
    const service = escapeLabelValue(snapshot.service);
    const lines: string[] = [
      `# HELP ${METRIC_PREFIX}_http_requests_in_flight HTTP requests currently being handled.`,
      `# TYPE ${METRIC_PREFIX}_http_requests_in_flight gauge`,
      `${METRIC_PREFIX}_http_requests_in_flight{service="${service}"} ${snapshot.inFlight}`,
      `# HELP ${METRIC_PREFIX}_http_requests_total HTTP requests handled, by status class.`,
      `# TYPE ${METRIC_PREFIX}_http_requests_total counter`,
    ];

    for (const statusClass of STATUS_CLASSES) {
      lines.push(
        `${METRIC_PREFIX}_http_requests_total{service="${service}",status_class="${statusClass}"} ${snapshot.byStatusClass[statusClass]}`,
      );
    }

    lines.push(
      `# HELP ${METRIC_PREFIX}_http_request_duration_ms Request handling duration in milliseconds.`,
      `# TYPE ${METRIC_PREFIX}_http_request_duration_ms summary`,
      `${METRIC_PREFIX}_http_request_duration_ms_sum{service="${service}"} ${formatNumber(snapshot.durationMsSum)}`,
      `${METRIC_PREFIX}_http_request_duration_ms_count{service="${service}"} ${snapshot.durationMsCount}`,
    );

    return `${lines.join('\n')}\n`;
  }
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return '0';
  }

  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(3)));
}
