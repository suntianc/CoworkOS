"use strict";

/**
 * Automated runs (browser tests, desktop smoke and measurement scripts) set
 * FORMICAND_DESKTOP_BACKGROUND=1. The app then still draws real windows — material,
 * backdrop and screenshot checks need them — but never becomes the foreground
 * application, shows no Dock icon and never takes keyboard focus from the person
 * using the machine. Without the variable nothing here changes the app.
 */
const BACKGROUND_VARIABLE = "FORMICAND_DESKTOP_BACKGROUND";

function backgroundMode(env = process.env) {
  return env[BACKGROUND_VARIABLE] === "1";
}

/** Must run before `ready`: Chromium reads these switches at startup. */
function prepareBackgroundApp(app) {
  // A window kept behind the person's work is occluded; keep it painting and its timers running.
  app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
  app.commandLine.appendSwitch("disable-renderer-backgrounding");
  app.commandLine.appendSwitch("disable-background-timer-throttling");
}

/** Runs once the app is ready, before the first window. */
function enterBackground(app, platform = process.platform) {
  if (platform !== "darwin") return;
  app.setActivationPolicy("accessory");
  app.dock?.hide();
}

/**
 * Put a background window on screen without the person seeing or touching it: macOS orders
 * an inactive window to the front, so it is shown fully transparent and click-through. It
 * stays a real, painting window for the page, screenshots and window material.
 */
function showInBackground(window) {
  window.setOpacity(0);
  window.setIgnoreMouseEvents(true);
  window.showInactive();
}

/** Show a window without activating it in background mode; otherwise show and focus it. */
function revealWindow(window, background) {
  if (background) showInBackground(window);
  else {
    window.show();
    window.focus();
  }
}

module.exports = {
  BACKGROUND_VARIABLE,
  backgroundMode,
  prepareBackgroundApp,
  enterBackground,
  showInBackground,
  revealWindow
};
