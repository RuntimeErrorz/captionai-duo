const test = require("node:test");
const assert = require("node:assert/strict");
const { loadShared } = require("./helpers");

const shared = loadShared();

test("DeepSeek SSE parser keeps an event split across network chunks", () => {
  const first = shared.deepSeekSseEvents('data: {"choices":[{"delta":{"content":"你', false);
  assert.equal(first.events.length, 0);
  const second = shared.deepSeekSseEvents(first.rest + '好"}}]}\n\ndata: [DONE]\n\n', false);
  assert.equal(second.events.length, 2);
  assert.equal(JSON.parse(second.events[0]).choices[0].delta.content, "你好");
  assert.equal(second.events[1], "[DONE]");
  assert.equal(second.rest, "");
});

test("DeepSeek SSE parser accepts CRLF and ignores comments", () => {
  const parsed = shared.deepSeekSseEvents(
    ': keep-alive\r\ndata: {"choices":[{"delta":{"content":"ok"}}]}\r\n\r\ndata: [DONE]\r\n\r\n',
    false
  );
  assert.equal(parsed.events.length, 2);
  assert.equal(JSON.parse(parsed.events[0]).choices[0].delta.content, "ok");
  assert.equal(parsed.events[1], "[DONE]");
});

test("DeepSeek SSE parser flushes a final event without a blank line", () => {
  const parsed = shared.deepSeekSseEvents("data: [DONE]", true);
  assert.deepEqual(Array.from(parsed.events), ["[DONE]"]);
  assert.equal(parsed.rest, "");
});
