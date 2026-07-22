// Pure diagnostic redaction shared by every extension execution world.
(() => {
  "use strict";
  const root = globalThis;
  const internalKey = "__captionAiDuoSharedModulesV1__";
  const internal = root[internalKey] || (root[internalKey] = {});
  const REDACTED = "[REDACTED]";
  const SECRET_KEY_NAMES = new Set([
    "authorization", "proxyauthorization", "apikey", "xapikey", "password",
    "secret", "token", "accesstoken", "refreshtoken", "idtoken", "cookie",
    "setcookie", "credentials", "credential", "aiapikeys",
    "aiconfigprofilestorev1"
  ]);

  function compactDiagnosticKey(value) {
    return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  function isDiagnosticSecretKey(value) {
    return SECRET_KEY_NAMES.has(compactDiagnosticKey(value));
  }

  function isConnectionProfile(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const keys = new Set(Object.keys(value).map(compactDiagnosticKey));
    return keys.has("baseurl") && keys.has("model") &&
      (keys.has("apikey") || keys.has("extrabody") || keys.has("thinking"));
  }

  function replaceAllLiteral(value, needle, replacement) {
    if (!needle || !value.includes(needle)) return value;
    return value.split(needle).join(replacement);
  }

  function sanitizeDiagnosticString(value, secrets, maxStringChars) {
    let text = String(value || "");
    for (const secret of secrets) text = replaceAllLiteral(text, secret, REDACTED);
    text = text
      .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [REDACTED]")
      .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, REDACTED)
      .replace(/\bAIza[A-Za-z0-9_-]{12,}\b/g, REDACTED)
      .replace(/([?&](?:api[_-]?key|access[_-]?token|token|secret|password)=)[^&#\s]*/gi,
        "$1[REDACTED]")
      .replace(/(["'](?:api[_-]?key|authorization|access[_-]?token|secret|password)["']\s*:\s*["'])[^"']*/gi,
        "$1[REDACTED]");
    if (/^https?:\/\/\S+$/i.test(text)) {
      try {
        const url = new URL(text);
        if (url.username) url.username = REDACTED;
        if (url.password) url.password = REDACTED;
        for (const key of Array.from(url.searchParams.keys())) {
          if (isDiagnosticSecretKey(key)) url.searchParams.set(key, REDACTED);
        }
        text = url.toString();
      } catch (_e) { /* a log message may merely start with a URL */ }
    }
    if (text.length > maxStringChars) {
      return `${text.slice(0, maxStringChars)}…[TRUNCATED:${text.length}]`;
    }
    return text;
  }

  function sanitizeDiagnosticValue(value, options) {
    const opts = options && typeof options === "object" ? options : {};
    const secrets = Array.from(new Set(Array.from(opts.secrets || [], (secret) =>
      String(secret || "").trim()).filter((secret) => secret.length >= 4)))
      .sort((a, b) => b.length - a.length);
    const maxDepth = Math.max(2, Math.min(12, Number(opts.maxDepth) || 8));
    const maxKeys = Math.max(8, Math.min(256, Number(opts.maxKeys) || 80));
    const maxArray = Math.max(8, Math.min(512, Number(opts.maxArray) || 160));
    const maxStringChars = Math.max(256,
      Math.min(30000, Number(opts.maxStringChars) || 12000));
    const seen = new Set();

    function visit(current, depth, keyHint) {
      if (isDiagnosticSecretKey(keyHint)) return REDACTED;
      if (current == null || typeof current === "boolean") return current;
      if (typeof current === "number") return Number.isFinite(current) ? current : String(current);
      if (typeof current === "bigint") return String(current);
      if (typeof current === "string") {
        return sanitizeDiagnosticString(current, secrets, maxStringChars);
      }
      if (typeof current !== "object") return String(current);
      if (depth >= maxDepth) return "[MAX_DEPTH]";
      if (seen.has(current)) return "[CIRCULAR]";
      if (isConnectionProfile(current)) return { redacted: "connection-profile" };
      seen.add(current);
      let result;
      if (Array.isArray(current)) {
        result = current.slice(0, maxArray).map((item) => visit(item, depth + 1, ""));
        if (current.length > maxArray) result.push(`[TRUNCATED:${current.length}]`);
      } else {
        result = {};
        const keys = Object.keys(current).slice(0, maxKeys);
        const headerName = typeof current.name === "string" &&
          isDiagnosticSecretKey(current.name);
        for (const key of keys) {
          const compactKey = compactDiagnosticKey(key);
          const safeKey = ["proto", "prototype", "constructor"].includes(compactKey)
            ? "[UNSAFE_KEY]" : sanitizeDiagnosticString(key, secrets, 160);
          result[safeKey] = headerName && compactDiagnosticKey(key) === "value"
            ? REDACTED : visit(current[key], depth + 1, key);
        }
        if (Object.keys(current).length > maxKeys) {
          result.__truncatedKeys = Object.keys(current).length - maxKeys;
        }
      }
      seen.delete(current);
      return result;
    }

    return visit(value, 0, "");
  }

  Object.assign(internal, { sanitizeDiagnosticValue });
})();
