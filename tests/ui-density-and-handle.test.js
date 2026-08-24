const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const contentCss = fs.readFileSync(path.join(root, "content.css"), "utf8");

function rule(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`));
  assert.ok(match, `missing CSS rule: ${selector}`);
  return match[1];
}

function pixelValue(declarations, property) {
  const match = declarations.match(new RegExp(`${property}\\s*:\\s*(\\d+)px`));
  assert.ok(match, `missing pixel declaration: ${property}`);
  return Number(match[1]);
}

test("subtitle drag handle has a large target without enlarging its visual grip", () => {
  const handle = rule(contentCss, ".ytds-handle");
  assert.ok(pixelValue(handle, "width") >= 44);
  assert.ok(pixelValue(handle, "height") >= 44);
  assert.match(handle, /pointer-events\s*:\s*none/);

  const visual = rule(contentCss, ".ytds-handle::before");
  assert.ok(pixelValue(visual, "width") < pixelValue(handle, "width"));
  assert.ok(pixelValue(visual, "height") < pixelValue(handle, "height"));
  assert.match(
    contentCss,
    /\.ytds-handle\.ytds-dragging\s*\{[^}]*pointer-events\s*:\s*auto/,
    "the larger transparent target must only intercept input while visible or dragging"
  );
});
