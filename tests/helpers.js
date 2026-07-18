"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadShared() {
  const root = path.resolve(__dirname, "..");
  const context = {};
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(root, "shared.js"), "utf8"), context);
  return context.YTDS_SHARED;
}

module.exports = { loadShared };
