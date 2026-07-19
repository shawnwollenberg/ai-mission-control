import { ValidationFailedError } from "@/lib/application-errors";

export type ScheduleRule =
  | { type: "once"; at: string }
  | { type: "hourly" }
  | { type: "every_n_hours"; hours: number }
  | { type: "daily"; hour: number; minute?: number }
  | { type: "weekly"; weekday: number; hour: number; minute?: number };
export function validateSchedule(rule: ScheduleRule, timeZone: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
  } catch {
    throw new ValidationFailedError("Schedule time zone must be an IANA identifier");
  }
  if (rule.type === "once" && Number.isNaN(Date.parse(rule.at)))
    throw new ValidationFailedError("One-time schedule requires an ISO timestamp");
  if (rule.type === "every_n_hours" && (!Number.isInteger(rule.hours) || rule.hours < 1 || rule.hours > 24 * 30))
    throw new ValidationFailedError("Schedule interval must be between 1 and 720 hours");
  if (
    (rule.type === "daily" || rule.type === "weekly") &&
    (rule.hour < 0 || rule.hour > 23 || (rule.minute ?? 0) < 0 || (rule.minute ?? 0) > 59)
  )
    throw new ValidationFailedError("Schedule wall-clock time is invalid");
  if (rule.type === "weekly" && (rule.weekday < 0 || rule.weekday > 6))
    throw new ValidationFailedError("Schedule weekday is invalid");
}
function parts(at: Date, timeZone: string) {
  const values = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(at)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  return values as Record<"year" | "month" | "day" | "hour" | "minute" | "second", number>;
}
function wallClock(year: number, month: number, day: number, hour: number, minute: number, timeZone: string) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let candidate = guess;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const local = parts(new Date(candidate), timeZone);
    const represented = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
    candidate += guess - represented;
  }
  return new Date(candidate);
}
export function nextRun(rule: ScheduleRule, after: Date, timeZone = "UTC"): Date | null {
  if (rule.type === "once") return new Date(rule.at) > after ? new Date(rule.at) : null;
  if (rule.type === "hourly" || rule.type === "every_n_hours")
    return new Date(after.getTime() + (rule.type === "hourly" ? 1 : rule.hours) * 3_600_000);
  const local = parts(after, timeZone),
    minute = rule.minute ?? 0;
  let dayOffset = 0;
  if (rule.type === "weekly") {
    const currentWeekday = new Date(Date.UTC(local.year, local.month - 1, local.day)).getUTCDay();
    dayOffset = (rule.weekday - currentWeekday + 7) % 7;
  }
  let date = new Date(Date.UTC(local.year, local.month - 1, local.day + dayOffset));
  let candidate = wallClock(
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    date.getUTCDate(),
    rule.hour,
    minute,
    timeZone,
  );
  if (candidate <= after) {
    date = new Date(date.getTime() + (rule.type === "daily" ? 1 : 7) * 86_400_000);
    candidate = wallClock(
      date.getUTCFullYear(),
      date.getUTCMonth() + 1,
      date.getUTCDate(),
      rule.hour,
      minute,
      timeZone,
    );
  }
  return candidate;
}
