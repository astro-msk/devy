// One redaction routine for everything Devy writes outside the box: Slack
// alerts built from tmux output, triage reports, chat replies, and PR bodies
// built from Codex output. Two copies used to drift (one missed the token in
// "Authorization: Bearer <token>" because it only scrubbed the word "Bearer").

const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;

// `name = value` / `name: value` where the name says it is a credential. The
// optional Bearer prefix keeps the scheme word out of the redacted value so the
// token after it does not survive as a second word.
const LABELLED_SECRET =
  /\b(token|secret|passwd|password|api[_-]?key|authorization|client[_-]?secret|access[_-]?key|private[_-]?key)\b\s*[:=]\s*["']?(?:Bearer\s+)?[\w./+=:~-]+["']?/gi;

const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g;

// Well-known credential shapes. Each is redacted regardless of length because
// the prefix alone identifies the issuer.
const KNOWN_TOKENS = [
  /\bxox[abeoprs]-[A-Za-z0-9-]+/g, // Slack bot/user/app tokens
  /\bxapp-[A-Za-z0-9-]+/g, // Slack app-level tokens
  /\bgh[opsur]_[A-Za-z0-9_]{16,}/g, // GitHub classic tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g, // GitHub fine-grained tokens
  /\bglpat-[A-Za-z0-9_-]{16,}/g, // GitLab
  /\bsk-[A-Za-z0-9_-]{16,}/g, // OpenAI / Anthropic (sk-ant-...)
  /\bnpm_[A-Za-z0-9]{30,}/g, // npm
  /\bA(?:KIA|SIA)[0-9A-Z]{16}\b/g, // AWS access key ids
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API keys
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g // JWTs
];

export type RedactOptions = {
  /**
   * Any bare run of token-ish characters at least this long is redacted, on
   * the theory that nothing humans type looks like that. Slack alerts built
   * from tmux output use 32; Codex prose uses 40 to spare more identifiers.
   */
  minTokenLength?: number;
};

export function redactSecrets(value: string, options: RedactOptions = {}): string {
  const minTokenLength = options.minTokenLength ?? 40;
  let out = value.replace(PRIVATE_KEY_BLOCK, "[redacted private key]");
  out = out.replace(LABELLED_SECRET, "$1=[redacted]");
  out = out.replace(BEARER, "Bearer [redacted]");
  for (const pattern of KNOWN_TOKENS) out = out.replace(pattern, "[redacted]");
  return out.replace(new RegExp(`\\b[A-Za-z0-9_-]{${minTokenLength},}\\b`, "g"), "[redacted]");
}
