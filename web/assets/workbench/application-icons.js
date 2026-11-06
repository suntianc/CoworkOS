import { icon } from "../ui/icons.js";

const APP_ICONS = {};

/** One monochrome glyph follows an application across launchers, files and tabs. */
export function applicationIconName(appType, fallback = "i-file") {
  return APP_ICONS[appType] || fallback || "i-file";
}

export function applicationIcon(appType, fallback) {
  return icon(applicationIconName(appType, fallback).replace(/^i-/, ""), "application-icon");
}
