export const MEMORY_SCHEMA_VERSION = 1;

const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ["private key", /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i],
  ["API token", /\b(?:sk|ghp|github_pat)-[A-Za-z0-9._-]{16,}\b/i],
  ["VLESS URL", /\bvless:\/\//i],
  ["credential UUID", /(?:\buuid\b|\bvless\b)[^\r\n]{0,40}\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i],
  ["pairing code", /(?:pairing(?:[- ]?code)?|配对码)[^\r\n]{0,40}\b\d{6}\b/i],
  ["root/password literal", /\broot\/password\b/i],
  ["authorization header", /\bauthorization\s*:\s*\S[^\r\n]*/i],
  ["bearer token", /\bbearer\s+[A-Za-z0-9._~+/=-]{16,}/i],
  ["cookie header", /\b(?:cookie|set-cookie)\s*:\s*\S[^\r\n]*/i],
  ["credential assignment", /(?:password|passwd|api[_ -]?key|secret|token|cookie|密码)\s*[:=]\s*["']?(?!\[?(?:redacted|removed)|见\b|see\b|待轮换\b|路径\b|location\b|file\b)[^\s,;|`"']{4,}/i],
  ["URL credentials", /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/i],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ["GitLab PAT", /\bglpat-[A-Za-z0-9_-]{20,}\b/],
];

export function findSecretRisk(text: string): string | null {
  for (const [name, pattern] of SECRET_PATTERNS) {
    if (pattern.test(String(text ?? ""))) return name;
  }
  return null;
}

export function findControlRisk(text: string): string | null {
  return /<\/?project_memory_[a-z0-9_-]*\s*>/i.test(String(text ?? ""))
    ? "memory control delimiter"
    : null;
}

export function findContentRisk(text: string): string | null {
  return findSecretRisk(text) ?? findControlRisk(text);
}

export function calendarAgeDays(isoDate: string, now = new Date()): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate ?? ""));
  if (!match) return Number.POSITIVE_INFINITY;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const value = Date.UTC(year, month - 1, day);
  const normalized = new Date(value);
  if (normalized.getUTCFullYear() !== year || normalized.getUTCMonth() !== month - 1 || normalized.getUTCDate() !== day) {
    return Number.POSITIVE_INFINITY;
  }
  const current = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.floor((current - value) / 86_400_000);
}

export function isExpired(isoDate: string, ttlDays: number, now = new Date()): boolean {
  const age = calendarAgeDays(isoDate, now);
  return !Number.isFinite(age) || age > Number(ttlDays);
}
