// YouTube player-control toggle for the CaptionAI overlay.
"use strict";

const PLAYER_TOGGLE_ID = "ytds-player-toggle";
const PLAYER_CONTROLS_SELECTOR = ".ytp-right-controls";

let playerToggleButton = null;
let playerControlsObserver = null;
let playerControlsObserverRoot = null;

function playerToggleLabel(enabled) {
  return enabled
    ? t("playerToggleDisable", "关闭 CaptionAI Duo")
    : t("playerToggleEnable", "开启 CaptionAI Duo");
}

function paintPlayerToggle() {
  if (!playerToggleButton) return;
  const enabled = !!settings.enabled;
  const label = playerToggleLabel(enabled);
  playerToggleButton.setAttribute("aria-pressed", String(enabled));
  playerToggleButton.setAttribute("aria-label", label);
  playerToggleButton.title = label;
  playerToggleButton.classList.toggle("ytds-toggle-on", enabled);
  playerToggleButton.classList.toggle("ytds-toggle-off", !enabled);
}

function playerToggleControls() {
  const player = getPlayer();
  return player && player.querySelector(PLAYER_CONTROLS_SELECTOR);
}

function createPlayerToggle() {
  const button = document.createElement("button");
  button.id = PLAYER_TOGGLE_ID;
  button.type = "button";
  button.className = "ytp-button ytds-toggle";
  button.setAttribute("aria-pressed", "false");

  const mark = document.createElement("span");
  mark.className = "ytds-toggle-mark";
  mark.setAttribute("aria-hidden", "true");
  const text = document.createElement("span");
  text.className = "ytds-toggle-text";
  text.textContent = "AI";
  text.setAttribute("aria-hidden", "true");
  mark.appendChild(text);
  button.appendChild(mark);

  button.addEventListener("click", onPlayerToggleClick);
  return button;
}

function insertPlayerToggle(controls, button) {
  const anchor = controls.children && controls.children[0];
  if (!anchor || anchor === button) {
    if (button.parentNode !== controls) controls.appendChild(button);
    return;
  }

  if (anchor.parentNode !== controls) {
    controls.appendChild(button);
    return;
  }

  try {
    controls.insertBefore(button, anchor);
  } catch (error) {
    if (!error || error.name !== "NotFoundError") throw error;
    controls.appendChild(button);
  }
}

function ensurePlayerToggle() {
  const controls = playerToggleControls();
  if (!controls) return null;

  if (playerToggleButton && playerToggleButton.parentNode !== controls) {
    playerToggleButton = null;
  }

  if (!playerToggleButton) {
    const stale = controls.querySelector("#" + PLAYER_TOGGLE_ID);
    if (stale) stale.remove();
    playerToggleButton = createPlayerToggle();
  }

  if (playerToggleButton.parentNode !== controls ||
      !controls.children || controls.children[0] !== playerToggleButton) {
    insertPlayerToggle(controls, playerToggleButton);
  }

  paintPlayerToggle();
  return playerToggleButton;
}

function onPlayerToggleClick() {
  if (!extensionContextAlive()) return;
  const previous = !!settings.enabled;
  const next = !previous;
  settings.enabled = next;
  paintPlayerToggle();

  const revert = () => {
    settings.enabled = previous;
    paintPlayerToggle();
    applyStateToDom(false);
    syncCaptions("player-toggle-save-failed");
  };

  try {
    chrome.storage.sync.set({ enabled: next }, () => {
      let failed = false;
      try { failed = !!(chrome.runtime && chrome.runtime.lastError); }
      catch (_e) { failed = true; }
      if (failed) revert();
    });
  } catch (_e) {
    revert();
  }
}

function observePlayerControls() {
  if (typeof MutationObserver !== "function") return;
  const root = document.body || document.documentElement;
  if (!root) return;
  if (playerControlsObserverRoot === root) return;
  if (playerControlsObserver) playerControlsObserver.disconnect();
  playerControlsObserverRoot = root;
  playerControlsObserver = new MutationObserver(() => ensurePlayerToggle());
  playerControlsObserver.observe(root, { childList: true, subtree: true });
}

function syncPlayerToggle() {
  ensurePlayerToggle();
  paintPlayerToggle();
}

function initializePlayerToggle() {
  observePlayerControls();
  syncPlayerToggle();
}

function stopPlayerToggle() {
  if (playerControlsObserver) playerControlsObserver.disconnect();
  playerControlsObserver = null;
  playerControlsObserverRoot = null;
  if (playerToggleButton) playerToggleButton.remove();
  playerToggleButton = null;
}
