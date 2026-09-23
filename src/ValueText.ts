import { Option } from "effect";
import type { DateOptions } from "./SmallDate.js";
import type { Scalar } from "./Value.js";
import { error, number } from "./Value.js";

const dayMilliseconds = 86_400_000;
const monthNames = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

function valueNumber(input: string): Option.Option<number> {
  const fraction = /^([+-]?)(\d+) (\d+)\/([1-9][0-9]?)$/.exec(input);
  if (fraction) {
    const sign = fraction[1] === "-" ? -1 : 1;
    return Option.some(sign * (Number(fraction[2]) + Number(fraction[3]) / Number(fraction[4])));
  }
  if (/^[+-]?\d+(?:[eE][+-]?\d+)?%?$/.test(input)) {
    const percent = input.endsWith("%");
    const parsed = Number(percent ? input.slice(0, -1) : input) / (percent ? 100 : 1);
    return Number.isFinite(parsed) ? Option.some(parsed) : Option.none();
  }
  if (!/^[+-]?\$?(?:(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d+)?)(?:(?:[eE][+-]?\d+)|%)?$/.test(input))
    return Option.none();
  const normalized = input.replaceAll(",", "").replace("$", "");
  const percent = normalized.endsWith("%");
  const numeric = percent ? normalized.slice(0, -1) : normalized;
  if (!/\d/.test(numeric)) return Option.none();
  const parsed = Number(numeric) / (percent ? 100 : 1);
  return Number.isFinite(parsed) ? Option.some(parsed) : Option.none();
}

function timeValue(input: string): Option.Option<number> {
  const match = /^(\d{1,2}):(\d{1,2})(?::(\d{1,2})(?:\.(\d+))?)?$/.exec(input);
  if (!match) return Option.none();
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3] ?? 0);
  if (hours > 23 || minutes > 59 || seconds > 59) return Option.none();
  const fractional = match[4] ? Number(`0.${match[4]}`) : 0;
  return Option.some((hours * 3600 + minutes * 60 + seconds + fractional) / 86400);
}

function monthNumber(name: string): Option.Option<number> {
  const lower = name.toLowerCase();
  const index = monthNames.findIndex((month) => month === lower || month.slice(0, 3) === lower);
  return index < 0 ? Option.none() : Option.some(index + 1);
}
function dateParts(input: string): Option.Option<{ year: number; month: number; day: number }> {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input);
  if (iso) return Option.some({ year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]) });
  const numeric = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/.exec(input);
  if (numeric) {
    const rawYear = Number(numeric[3]);
    const year =
      numeric[3]!.length === 2 ? (rawYear <= 29 ? 2000 + rawYear : 1900 + rawYear) : rawYear;
    return Option.some({ year, month: Number(numeric[1]), day: Number(numeric[2]) });
  }
  const monthFirst = /^([A-Za-z]+) (\d{1,2}), (\d{4})$/.exec(input);
  const dayFirst = /^(\d{1,2}) ([A-Za-z]+) (\d{4})$/.exec(input);
  const named = monthFirst ?? dayFirst;
  if (!named) return Option.none();
  const month = monthNumber(monthFirst ? named[1]! : named[2]!);
  return Option.map(month, (value) => ({
    year: Number(named[3]),
    month: value,
    day: Number(monthFirst ? named[2] : named[1]),
  }));
}
function dateValue(input: string, origin: number): Option.Option<number> {
  const parts = dateParts(input);
  if (Option.isNone(parts)) return Option.none();
  const { year, month, day } = parts.value;
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day
  )
    return Option.none();
  return Option.some((date.getTime() - origin) / dayMilliseconds);
}

/** OpenFormula VALUE text formats, with en-US as this engine's current locale. */
export function valueText(input: string, options: DateOptions): Scalar {
  const value = input.trim();
  const numeric = valueNumber(value);
  if (Option.isSome(numeric)) return number(numeric.value);
  const time = timeValue(value);
  if (Option.isSome(time)) return number(time.value);
  const origin = options.dateEpoch
    ? Date.parse(`${options.dateEpoch}T00:00:00Z`)
    : Date.UTC(1899, 11, 30);
  if (!Number.isFinite(origin)) return error("#VALUE!");
  const date = dateValue(value, origin);
  if (Option.isSome(date)) return number(date.value);
  const dateTime = /^(.+?)[ T](\d{1,2}:\d{1,2}(?::\d{1,2}(?:\.\d+)?)?)$/.exec(value);
  if (dateTime) {
    const day = dateValue(dateTime[1]!, origin);
    const clock = timeValue(dateTime[2]!);
    if (Option.isSome(day) && Option.isSome(clock)) return number(day.value + clock.value);
  }
  return error("#VALUE!");
}
