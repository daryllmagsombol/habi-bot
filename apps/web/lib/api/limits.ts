/**
 * Transport bounds shared by the artifact editor and its client calls.
 *
 * The artifact service stores up to 1 MiB, but the HTTP surface caps one request
 * body at 100 KB. The editor enforces the transport bound so a save is refused
 * with an explanation instead of failing with a bare `413`.
 */
export const ARTIFACT_CONTENT_MAX_BYTES = 100 * 1024;

const ENCODER = new TextEncoder();

export function utf8Bytes(value: string): number {
  return ENCODER.encode(value).byteLength;
}
