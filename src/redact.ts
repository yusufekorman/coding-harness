export function redact(s: string): string {
  return s
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-***")
    .replace(/ctx7sk-[A-Za-z0-9_-]{8,}/g, "ctx7sk-***")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "AKIA***")
    .replace(/Bearer\s+[A-Za-z0-9._-]{8,}/gi, "Bearer ***")
    .replace(/(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s"',}]+/gi, "$1=***")
    .replace(/-----BEGIN [A-Z ]+ PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+ PRIVATE KEY-----/g, "***private-key***");
}
