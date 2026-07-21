// Final shared API assembler. Load shared/* modules before this file.
(() => {
  "use strict";
  if (globalThis.YTDS_SHARED) return;
  const internal = globalThis["__captionAiDuoSharedModulesV1__"];
  if (!internal) throw new Error("CaptionAI shared modules are missing");
  const api = Object.freeze({ ...internal });
  delete globalThis["__captionAiDuoSharedModulesV1__"];
  Object.defineProperty(globalThis, "YTDS_SHARED", {
    value: api, enumerable: false, configurable: false, writable: false
  });
})();
