// Small runtime helpers for causal cue groups and SSE framing.
(() => {
  "use strict";
  if (globalThis.YTDS_SHARED) return;
  const internal = globalThis["__captionAiDuoSharedModulesV1__"];
  if (!internal) throw new Error("CaptionAI shared modules loaded out of order");

  function causalCueGroups(cues) {
    return cues.map((cue, index) => ({
      startIdx: index,
      endIdx: index,
      text: cue.text,
      start: cue.start,
      end: cue.end,
      lastOff: cue.lastOff,
      dur: cue.dur
    }));
  }

  function deepSeekSseEvents(value, flush) {
    const input = String(value || "");
    const events = [];
    let cursor = 0;
    while (true) {
      const match = /\r?\n\r?\n/g;
      match.lastIndex = cursor;
      const boundary = match.exec(input);
      if (!boundary) break;
      const block = input.slice(cursor, boundary.index);
      cursor = boundary.index + boundary[0].length;
      const data = block.split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      if (data) events.push(data);
    }
    let rest = input.slice(cursor);
    if (flush && rest.trim()) {
      const data = rest.split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      if (data) events.push(data);
      rest = "";
    }
    return { events, rest };
  }

  Object.assign(internal, { causalCueGroups, deepSeekSseEvents });
})();
