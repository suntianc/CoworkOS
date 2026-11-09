import { ui } from "./language.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const TIME_FORMATS = ["relative", "absolute"];

const pad = (value) => String(value).padStart(2, "0");

function absolute(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * One timestamp for both preferences.
 *
 * Relative is what a person needs while work is recent; an absolute stamp is
 * what they need when comparing records. Anything older than a month keeps the
 * calendar date so a long-lived list never says "63 天前".
 */
export function formatStamp(value, mode = "relative", now = Date.now()) {
  if (value === undefined || value === null || value === "") return "—";
  const time =
    value instanceof Date ? value.valueOf() : typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(time)) return String(value);
  const date = new Date(time);
  if (mode !== "relative") return absolute(date);
  const delta = now - time;
  if (delta < MINUTE) return ui("刚刚");
  if (delta < HOUR) return ui`${Math.floor(delta / MINUTE)} 分钟前`;
  if (delta < DAY) return ui`${Math.floor(delta / HOUR)} 小时前`;
  if (delta < 30 * DAY) return ui`${Math.floor(delta / DAY)} 天前`;
  return absolute(date);
}
