"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(
  path.join(__dirname, "..", "inject", "track-transport.js"), "utf8"
);

function loadTransport() {
  const context = {
    URL,
    TextDecoder,
    Uint8Array,
    location: { href: "https://www.youtube.com/watch?v=abcdefghijk" }
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(source, context, { filename: "inject/track-transport.js" });
  return context.window.__ytdsCaptionTrackTransport;
}

test("caption transport parses VTT and timedtext XML responses", () => {
  const transport = loadTransport();
  const vtt = transport.parseCaptionResponse(
    "WEBVTT\n\n00:01.000 --> 00:03.500\nHello &amp; welcome\n"
  );
  const xml = transport.parseCaptionResponse(
    '<transcript><text start="1.5" dur="2">Bonjour &amp; monde</text></transcript>'
  );
  assert.equal(JSON.stringify(vtt), JSON.stringify([{
    start: 1000, dur: 2500, text: "Hello & welcome", lastOff: 1000
  }]));
  assert.equal(JSON.stringify(xml), JSON.stringify([{
    start: 1500, dur: 2000, text: "Bonjour & monde", lastOff: 1500
  }]));
});

test("caption transport reads arraybuffer player responses", async () => {
  const transport = loadTransport();
  const bytes = new TextEncoder().encode("WEBVTT\n\n00:00.000 --> 00:01.000\nready\n");
  const text = await transport.xhrResponseText({ responseType: "arraybuffer", response: bytes });
  assert.equal(text, "WEBVTT\n\n00:00.000 --> 00:01.000\nready\n");
});

test("caption transport grafts missing player session parameters without replacing track parameters", () => {
  const transport = loadTransport();
  const target = "https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=en&kind=asr&signature=target";
  const donor = "https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=zh&pot=player-pot&potc=1&c=WEB&cver=2.0";
  const result = new URL(transport.graftSessionParams(target, donor));

  assert.equal(result.searchParams.get("lang"), "en");
  assert.equal(result.searchParams.get("kind"), "asr");
  assert.equal(result.searchParams.get("signature"), "target");
  assert.equal(result.searchParams.get("pot"), "player-pot");
  assert.equal(result.searchParams.get("potc"), "1");
  assert.equal(result.searchParams.get("c"), "WEB");
  assert.equal(result.searchParams.get("cver"), "2.0");
});
