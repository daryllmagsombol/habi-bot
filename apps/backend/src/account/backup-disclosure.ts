/**
 * H-032 (#32) backup disclosure, written once and returned verbatim.
 *
 * Owner decisions (2026-11-09):
 *   - backups are age-encrypted client-side with an owner-held key; the VM
 *     holds only the public key;
 *   - retention is GFS: 7 daily / 4 weekly / 6 monthly;
 *   - a deleted account's data survives inside archives created before the
 *     deletion until those archives age out, worst case 184 days;
 *   - nothing rewrites or purges an existing archive.
 *
 * The API must never claim immediate removal from backups. This text is the
 * single source of that statement for the delete response.
 */

export const BACKUP_RETENTION_POLICY = '7 daily / 4 weekly / 6 monthly';

/**
 * Worst-case archive age under the GFS policy. Six monthly archives span at
 * most 184 days (for example 1 July to 1 January), which is longer than the
 * daily and weekly windows.
 */
export const BACKUP_RETENTION_MAX_DAYS = 184;

export const BACKUP_ENCRYPTION =
  'age, encrypted client-side with an owner-held key; the server holds only the public key';

export const BACKUP_RETENTION_DISCLOSURE =
  'This removes the account and its data from the live database. A copy of ' +
  "this account's data survives in age-encrypted backups created before this " +
  'deletion until those archives age out under the 7 daily / 4 weekly / ' +
  '6 monthly retention policy — up to 184 days. Nothing is purged from an ' +
  'existing archive.';
