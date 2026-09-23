import { Option } from "effect";
import type { Scalar, Value } from "./Value.js";
import { error, isError, number, scalar, toNumber } from "./Value.js";

const dayMilliseconds = 86_400_000;
const defaultEpoch = Date.UTC(1899, 11, 30);

export interface DateOptions {
  readonly dateEpoch?: string;
  readonly clock?: () => Date;
}

function epoch(options: DateOptions): number {
  return options.dateEpoch ? Date.parse(`${options.dateEpoch}T00:00:00Z`) : defaultEpoch;
}
function dateSerial(value: Scalar, origin: number): Option.Option<number> {
  if (value._tag === "Number") return Option.some(value.value);
  if (value._tag !== "Text") return Option.none();
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(value.value);
  if (!match) return Option.none();
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const stamp = Date.UTC(
    year,
    month - 1,
    day,
    Number(match[4] ?? 0),
    Number(match[5] ?? 0),
    Number(match[6] ?? 0),
  );
  const check = new Date(stamp);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() + 1 !== month ||
    check.getUTCDate() !== day
  )
    return Option.none();
  return Option.some((stamp - origin) / dayMilliseconds);
}
function timeSerial(value: Scalar): Option.Option<number> {
  if (value._tag === "Number") return Option.some(value.value);
  if (value._tag !== "Text") return Option.none();
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value.value);
  if (!match) return Option.none();
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] ?? 0);
  return hour < 24 && minute < 60 && second < 60
    ? Option.some((hour * 3600 + minute * 60 + second) / 86400)
    : Option.none();
}

const names = new Set([
  "DATE",
  "DAY",
  "HOUR",
  "MINUTE",
  "MONTH",
  "NOW",
  "SECOND",
  "TIME",
  "TODAY",
  "WEEKDAY",
  "YEAR",
]);
export function smallDate(
  name: string,
  args: readonly Value[],
  options: DateOptions,
): Option.Option<Scalar> {
  return names.has(name) ? Option.some(evaluateDate(name, args, options)) : Option.none();
}
function evaluateDate(name: string, args: readonly Value[], options: DateOptions): Scalar {
  const origin = epoch(options);
  if (!Number.isFinite(origin)) return error("#VALUE!");
  if (name === "NOW" || name === "TODAY") {
    if (args.length) return error("#VALUE!");
    const current = (options.clock ?? (() => new Date()))();
    const serial = (current.getTime() - origin) / dayMilliseconds;
    return number(name === "TODAY" ? Math.floor(serial) : serial);
  }
  if (name === "DATE" || name === "TIME") {
    if (args.length !== 3) return error("#VALUE!");
    const parts = args.map((arg) => toNumber(scalar(arg)));
    const failure = parts.find(isError);
    if (failure) return failure;
    const [a, b, c] = parts.map((part) =>
      (name === "TIME" ? Math.floor : Math.trunc)((part as { value: number }).value),
    );
    if (name === "TIME") return number((a! * 3600 + b! * 60 + c!) / 86400);
    if (a! < 1904 || a! > 9956 || b! < 1 || c! < 1) return error("#VALUE!");
    return number((Date.UTC(a!, b! - 1, c!) - origin) / dayMilliseconds);
  }
  if (args.length < 1 || args.length > (name === "WEEKDAY" ? 2 : 1)) return error("#VALUE!");
  const value = scalar(args[0]!);
  if (isError(value)) return value;
  const time = timeSerial(value);
  const serial =
    ["HOUR", "MINUTE", "SECOND"].includes(name) && Option.isSome(time)
      ? time
      : dateSerial(value, origin);
  if (Option.isNone(serial)) return error("#VALUE!");
  const day = serial.value;
  if (name === "HOUR") return number(Math.floor((day - Math.floor(day)) * 24));
  if (name === "MINUTE") return number(((Math.floor(Math.round(day * 86400) / 60) % 60) + 60) % 60);
  if (name === "SECOND") return number(((Math.round(day * 86400) % 60) + 60) % 60);
  const date = new Date(origin + Math.floor(day) * dayMilliseconds);
  if (name === "YEAR") return number(date.getUTCFullYear());
  if (name === "MONTH") return number(date.getUTCMonth() + 1);
  if (name === "DAY") return number(date.getUTCDate());
  const type = args[1] ? toNumber(scalar(args[1])) : number(1);
  if (isError(type)) return type;
  const mode = Math.trunc(type.value);
  const sunday = date.getUTCDay();
  if (mode === 1 || mode === 17) return number(sunday + 1);
  if (mode === 2 || mode === 11) return number(((sunday + 6) % 7) + 1);
  if (mode === 3) return number((sunday + 6) % 7);
  if (mode >= 12 && mode <= 16) return number(((sunday - (mode - 10) + 7) % 7) + 1);
  return error("#VALUE!");
}
