// Narrow repairs for provider JSONL drift. Semantic validation remains in
// translation.js; this module only repairs transport syntax without inventing
// positions or spoken content.
(() => {
  "use strict";
  if (globalThis.YTDS_SHARED) return;
  const internal = globalThis["__captionAiDuoSharedModulesV1__"];
  if (!internal) throw new Error("CaptionAI shared modules loaded out of order");

  function repairArraySyntax(value) {
    const source = String(value || "");
    if (!/^\s*\[/.test(source)) return "";
    let repaired = "";
    let inString = false;
    let escaped = false;
    for (let index = 0; index < source.length; index++) {
      const char = source[index];
      if (inString) {
        if (escaped) {
          if (char === "\r" || char === "\n") {
            repaired += "\\n";
            if (char === "\r" && source[index + 1] === "\n") index++;
          } else if (/[“”‘’]/.test(char)) {
            // Models sometimes escape typographic quotes as \“...\”. The
            // slash is not part of the translation and is not valid JSON.
            repaired += char;
          } else {
            repaired += `\\${char}`;
          }
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === '"') {
          repaired += char;
          inString = false;
        } else if (char === "\r" || char === "\n") {
          repaired += "\\n";
          if (char === "\r" && source[index + 1] === "\n") index++;
        } else if (char === "\t") {
          repaired += "\\t";
        } else if (char.charCodeAt(0) < 0x20) {
          repaired += `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
        } else {
          repaired += char;
        }
        continue;
      }
      if (char === '"') {
        repaired += char;
        inString = true;
      } else if (char === ",") {
        let next = index + 1;
        while (next < source.length && /\s/.test(source[next])) next++;
        if (source[next] === "," || source[next] === "]" || source[next] === "}") continue;
        repaired += char;
      } else {
        repaired += char;
      }
    }
    if (escaped) repaired += "\\";
    return repaired === source ? "" : repaired;
  }

  function compactJsonlCoordinate(value) {
    if (typeof value === "number") {
      return Number.isSafeInteger(value) && value >= 0 ? value : null;
    }
    const text = typeof value === "string" ? value.trim() : "";
    if (!/^\d+$/.test(text)) return null;
    const parsed = Number(text);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }

  function coordinateLike(value) {
    return compactJsonlCoordinate(value) != null;
  }

  function tupleLike(value) {
    if (!Array.isArray(value)) return false;
    if (value.length >= 3 && coordinateLike(value[0]) && coordinateLike(value[1]) &&
        typeof value[2] === "string") return true;
    return value.length === 2 && typeof value[0] === "string" &&
      /^\s*\d+\s*[,:-]\s*\d+\s*$/.test(value[0]) && typeof value[1] === "string";
  }

  function parseArray(value) {
    for (const candidate of [String(value || ""), repairArraySyntax(value)]) {
      if (!candidate) continue;
      try {
        const parsed = JSON.parse(candidate);
        if (Array.isArray(parsed)) return parsed;
      } catch (_e) { /* the caller will keep the malformed tail rejected */ }
    }
    return null;
  }

  // If an outer array is unbalanced or has a bad separator, recover only
  // complete tuple leaves from its leading structural prefix. A non-structural
  // prose gap, empty completion marker, or tuple-shaped invalid array ends the
  // recovery; no arbitrary text is interpreted as JSON.
  function extractLeadingTupleArrays(value) {
    const source = String(value || "").trim();
    if (!/^\s*\[/.test(source)) return [];
    const stack = [];
    const tuples = [];
    let inString = false;
    let escaped = false;
    let lastEnd = 0;
    const structural = (text) => !/[^\s,\[\]]/.test(text);
    for (let index = 0; index < source.length; index++) {
      const char = source[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') { inString = true; continue; }
      if (char === "[") { stack.push(index); continue; }
      if (char !== "]" || !stack.length) continue;
      const start = stack.pop();
      const raw = source.slice(start, index + 1);
      if (raw.trim() === "[]") {
        if (tuples.length) break;
        continue;
      }
      const parsed = parseArray(raw);
      if (parsed && tupleLike(parsed)) {
        if (!structural(source.slice(lastEnd, start))) break;
        tuples.push(parsed);
        lastEnd = index + 1;
      } else if (/^\s*\[\s*(?:\d+|")/.test(raw)) {
        break;
      }
    }
    return tuples;
  }

  // HTTP/SSE chunks and model-generated newlines are independent of JSON
  // array boundaries. Frame complete top-level JSON values instead of
  // assuming that every physical line is a complete JSON value. A non-empty
  // top-level array is one semantic unit; [] is the completion marker.
  function aiJsonlObjects(value, flush) {
    const input = String(value || "");
    const objects = [];
    let cursor = 0;
    let start = -1;
    const brackets = [];
    let inString = false;
    let escaped = false;
    for (let index = 0; index < input.length; index++) {
      const char = input[index];
      if (start < 0) {
        if (char === "{" || char === "[") {
          start = index;
          brackets.push(char);
          inString = false;
          escaped = false;
        }
        continue;
      }
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') {
        inString = true;
      } else if (char === "{" || char === "[") {
        brackets.push(char);
      } else if (char === "}" || char === "]") {
        const opening = char === "}" ? "{" : "[";
        if (brackets[brackets.length - 1] === opening) brackets.pop();
        if (!brackets.length) {
          objects.push(input.slice(start, index + 1));
          cursor = index + 1;
          start = -1;
        }
      }
    }
    let rest = start >= 0 ? input.slice(start) : input.slice(cursor);
    if (flush) {
      const tail = rest.trim();
      const recovered = aiJsonlRecoverIncompleteUnit(tail);
      if (recovered) {
        objects.push(recovered);
      } else if (tail && !/^```(?:jsonl?|ndjson)?$/i.test(tail) && tail !== "```") {
        objects.push(tail);
      }
      rest = "";
    }
    return { objects, rest };
  }

  // Some providers occasionally stop after the final aligned chunk and omit
  // the unit array's closing `]`. The chunks before the missing bracket are
  // still complete JSON values. Recover only that narrow shape and only from
  // a complete chunk boundary; arbitrary malformed output remains rejected by
  // the normal record validator.
  function aiJsonlRecoverIncompleteUnit(value) {
    const text = String(value || "").trim();
    if (!/^\[\s*\[/i.test(text)) return "";
    const brackets = [];
    let inString = false;
    let escaped = false;
    let lastChunkEnd = -1;
    for (let index = 0; index < text.length; index++) {
      const char = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') {
        inString = true;
      } else if (char === "{" || char === "[") {
        brackets.push(char);
      } else if (char === "}" || char === "]") {
        const opening = char === "}" ? "{" : "[";
        if (brackets[brackets.length - 1] !== opening) return "";
        if (opening === "[" && brackets.length === 2 &&
            brackets[0] === "[" && brackets[1] === "[") {
          lastChunkEnd = index + 1;
        }
        brackets.pop();
      }
    }
    if (lastChunkEnd < 0) return "";
    try {
      const parsed = JSON.parse(`${text.slice(0, lastChunkEnd)}]`);
      if (Array.isArray(parsed) && parsed.length) return JSON.stringify(parsed);
    } catch (_e) { /* the last complete chunk may still have malformed data */ }
    return "";
  }

  // Normalize a direct range tuple, a flat tuple sequence, or appended
  // metadata without inventing text or coordinates.
  function aiJsonlTupleParts(value) {
    if (!Array.isArray(value)) return null;
    if (value.length === 2 && typeof value[0] === "string" &&
        typeof value[1] === "string") {
      const pair = value[0].match(/^\s*(\d+)\s*[,:-]\s*(\d+)\s*$/);
      if (pair) return [[pair[1], pair[2], value[1]]];
    }
    if (value.length < 3 || compactJsonlCoordinate(value[0]) == null ||
        compactJsonlCoordinate(value[1]) == null || typeof value[2] !== "string") {
      return null;
    }
    const first = [value[0], value[1], value[2]];
    const tail = value.slice(3);
    if (tail.length >= 3 && tail.length % 3 === 0) {
      const parts = [first];
      for (let index = 0; index < tail.length; index += 3) {
        const part = tail.slice(index, index + 3);
        if (compactJsonlCoordinate(part[0]) == null ||
            compactJsonlCoordinate(part[1]) == null || typeof part[2] !== "string") {
          return [first];
        }
        parts.push(part);
      }
      return parts;
    }
    return [first];
  }

  function aiJsonlDecodedRecords(value, depthValue) {
    const valueArray = Array.isArray(value) ? value : null;
    const depth = Math.max(0, Math.floor(Number(depthValue) || 0));
    if (!valueArray || depth > 3) return null;
    if (!valueArray.length) return [{ type: "done" }];

    const directTuple = aiJsonlTupleParts(valueArray);
    if (directTuple) return [{ type: "unit", chunks: directTuple }];

    // Preserve unambiguous nested unit boundaries; normal chunks start with
    // scalar coordinates.
    const nested = valueArray.some((child) => Array.isArray(child) && child.length > 0) &&
      valueArray.every((child) => Array.isArray(child) &&
        (!child.length || Array.isArray(child[0])));
    if (nested) {
      const records = [];
      for (const child of valueArray) {
        const childRecords = aiJsonlDecodedRecords(child, depth + 1);
        if (!childRecords) return null;
        records.push(...childRecords);
      }
      return records.length ? records : [{ type: "done" }];
    }

    const chunks = [];
    for (const child of valueArray) {
      // Drop a misplaced empty completion marker without adding coverage.
      if (Array.isArray(child) && !child.length) continue;
      const parts = aiJsonlTupleParts(child);
      chunks.push(...(parts || [child]));
    }
    return chunks.length ? [{ type: "unit", chunks }] : [{ type: "done" }];
  }

  function aiJsonlRecordFromLine(value) {
    const line = String(value || "").trim();
    if (!line || /^```(?:jsonl?|ndjson)?$/i.test(line) || line === "```") {
      return { ignored: true, record: null, error: "" };
    }
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (_e) {
      const repaired = repairArraySyntax(line);
      if (repaired) {
        try { parsed = JSON.parse(repaired); } catch (_repairError) { /* recover prefix below */ }
      }
      if (!Array.isArray(parsed)) {
        const candidates = extractLeadingTupleArrays(line);
        const chunks = candidates.flatMap((candidate) => aiJsonlTupleParts(candidate) || []);
        if (chunks.length) {
          return { ignored: false, record: { type: "unit", chunks }, error: "", recovered: true };
        }
        return { ignored: false, record: null, error: "invalid JSONL line" };
      }
    }
    if (!Array.isArray(parsed)) {
      return { ignored: false, record: null, error: "JSONL line must be a chunk array" };
    }
    const records = aiJsonlDecodedRecords(parsed, 0);
    if (!records || !records.length) {
      return { ignored: false, record: null, error: "invalid JSONL line" };
    }
    if (records.length === 1) {
      return { ignored: false, record: records[0], error: "" };
    }
    return { ignored: false, records, record: null, error: "" };
  }

  Object.assign(internal, {
    compactJsonlCoordinate,
    aiJsonlObjects,
    aiJsonlRecordFromLine
  });
})();
