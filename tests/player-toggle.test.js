"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(
  path.join(__dirname, "..", "content/player-toggle.js"), "utf8"
);

class FakeClassList {
  constructor(value) {
    this.values = new Set(String(value || "").split(/\s+/).filter(Boolean));
  }

  add(...names) { names.forEach((name) => this.values.add(name)); }
  remove(...names) { names.forEach((name) => this.values.delete(name)); }
  contains(name) { return this.values.has(name); }
  toggle(name, force) {
    const next = force === undefined ? !this.values.has(name) : !!force;
    if (next) this.values.add(name);
    else this.values.delete(name);
    return next;
  }
}

class FakeElement {
  constructor(tagName) {
    this.tagName = String(tagName || "div").toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.listeners = new Map();
    this.style = {};
    this.classList = new FakeClassList();
    this._className = "";
    this.textContent = "";
    this.title = "";
    this.id = "";
  }

  get className() { return this._className; }
  set className(value) {
    this._className = String(value || "");
    this.classList = new FakeClassList(this._className);
  }

  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    this.children.push(child);
    child.parentNode = this;
    return child;
  }

  insertBefore(child, before) {
    if (child.parentNode) child.parentNode.removeChild(child);
    const index = this.children.indexOf(before);
    if (index < 0) {
      const error = new Error("The node before which the new node is to be inserted is not a child of this node.");
      error.name = "NotFoundError";
      throw error;
    }
    this.children.splice(index, 0, child);
    child.parentNode = this;
    return child;
  }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parentNode = null;
    return child;
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  setAttribute(name, value) {
    this.attributes.set(String(name), String(value));
    if (name === "id") this.id = String(value);
  }

  getAttribute(name) { return this.attributes.get(String(name)) || null; }

  addEventListener(type, callback) { this.listeners.set(type, callback); }
  click() {
    const callback = this.listeners.get("click");
    if (callback) callback({ currentTarget: this, preventDefault() {} });
  }

  querySelector(selector) {
    const matches = (node) => {
      if (selector[0] === "#") return node.id === selector.slice(1);
      if (selector[0] === ".") return node.classList.contains(selector.slice(1));
      return node.tagName.toLowerCase() === selector.toLowerCase();
    };
    const visit = (node) => {
      for (const child of node.children) {
        if (matches(child)) return child;
        const nested = visit(child);
        if (nested) return nested;
      }
      return null;
    };
    return visit(this);
  }
}

function buildContext() {
  const body = new FakeElement("body");
  const documentElement = new FakeElement("html");
  let currentPlayer = new FakeElement("div");
  const stored = [];
  const observers = [];
  const calls = [];

  function playerWithControls({ nestedSettings = false } = {}) {
    const player = new FakeElement("div");
    const controls = new FakeElement("div");
    controls.className = "ytp-right-controls";
    const settings = new FakeElement("button");
    settings.className = "ytp-button ytp-settings-button";
    if (nestedSettings) {
      const wrapper = new FakeElement("div");
      wrapper.appendChild(settings);
      controls.appendChild(wrapper);
    } else {
      controls.appendChild(settings);
    }
    player.appendChild(controls);
    return player;
  }

  currentPlayer = playerWithControls();
  const context = {
    settings: { enabled: true },
    t: (_key, fallback) => fallback,
    getPlayer: () => currentPlayer,
    extensionContextAlive: () => true,
    applyStateToDom: () => calls.push("apply"),
    syncCaptions: (reason) => calls.push(reason),
    document: {
      body,
      documentElement,
      createElement: (tagName) => new FakeElement(tagName)
    },
    chrome: {
      runtime: { lastError: null },
      storage: {
        sync: {
          set: (patch, callback) => {
            stored.push({ ...patch });
            if (callback) callback();
          }
        }
      }
    },
    MutationObserver: class {
      constructor(callback) {
        this.callback = callback;
        observers.push(this);
      }
      observe() {}
      disconnect() { this.disconnected = true; }
    }
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: "content/player-toggle.js" });
  return {
    context,
    body,
    calls,
    observers,
    stored,
    getPlayer: () => currentPlayer,
    setPlayer: (player) => { currentPlayer = player; },
    playerWithControls
  };
}

test("player toggle is idempotent, survives control replacement, and persists its state", () => {
  const fixture = buildContext();
  const { context, observers, stored, setPlayer, playerWithControls } = fixture;

  vm.runInContext("initializePlayerToggle()", context);
  const first = vm.runInContext("playerToggleButton", context);
  const controls = first.parentNode;

  assert.equal(controls.children.length, 2);
  assert.equal(controls.children[0], first, "the switch sits in the right-side native control group");
  assert.equal(first.querySelector(".ytds-toggle-text").textContent, "AI");
  assert.equal(first.getAttribute("aria-pressed"), "true");
  assert.equal(first.classList.contains("ytds-toggle-on"), true);

  vm.runInContext("syncPlayerToggle()", context);
  assert.equal(controls.children.length, 2, "repeated sync does not duplicate the switch");
  assert.equal(vm.runInContext("playerToggleButton", context), first);

  first.click();
  assert.equal(context.settings.enabled, false);
  assert.deepEqual(stored, [{ enabled: false }]);
  assert.equal(first.getAttribute("aria-pressed"), "false");
  assert.equal(first.classList.contains("ytds-toggle-off"), true);

  const replacementPlayer = playerWithControls();
  setPlayer(replacementPlayer);
  observers[0].callback([]);
  const replacement = vm.runInContext("playerToggleButton", context);
  assert.notEqual(replacement, first, "a rebuilt YouTube control bar gets a fresh button");
  assert.equal(replacement.parentNode, replacementPlayer.querySelector(".ytp-right-controls"));
  assert.equal(replacement.getAttribute("aria-pressed"), "false");

  replacement.click();
  assert.equal(context.settings.enabled, true);
  assert.deepEqual(stored, [{ enabled: false }, { enabled: true }]);
});

test("player toggle does not use a nested native control as an insertion anchor", () => {
  const fixture = buildContext();
  const { context, observers, setPlayer, playerWithControls } = fixture;

  vm.runInContext("initializePlayerToggle()", context);
  setPlayer(playerWithControls({ nestedSettings: true }));

  assert.doesNotThrow(() => observers[0].callback([]));
  const replacement = vm.runInContext("playerToggleButton", context);
  const controls = replacement.parentNode;
  assert.equal(controls.classList.contains("ytp-right-controls"), true);
  assert.equal(controls.children[0], replacement);
  assert.equal(controls.children.includes(replacement), true);
});
