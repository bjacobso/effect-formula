import type { Scalar, Value } from "./Value.js";
import { entries, error, isError, number, scalar, toNumber } from "./Value.js";

function parameters(args: readonly Value[], min: number, max: number): number[] | Scalar {
  if (args.length < min || args.length > max) return error("#VALUE!");
  const values: number[] = [];
  for (const arg of args) {
    const converted = toNumber(scalar(arg));
    if (isError(converted)) return converted;
    values.push(converted.value);
  }
  return values;
}
function cashflow(
  rate: number,
  nper: number,
  payment: number,
  pv: number,
  fv: number,
  type: number,
): number {
  const compound = (1 + rate) ** nper;
  const annuity = rate === 0 ? nper : (compound - 1) / rate;
  return pv * compound + payment * (1 + rate * type) * annuity + fv;
}
function solve(fn: (rate: number) => number, guess: number): Scalar {
  let rate = guess;
  for (let i = 0; i < 100; i++) {
    const value = fn(rate);
    if (!Number.isFinite(value)) break;
    if (Math.abs(value) < 1e-9) return number(rate);
    const h = Math.max(1e-7, Math.abs(rate) * 1e-6);
    const derivative = (fn(rate + h) - fn(rate - h)) / (2 * h);
    if (!Number.isFinite(derivative) || Math.abs(derivative) < 1e-12) break;
    const next = rate - value / derivative;
    if (!Number.isFinite(next) || next <= -1) break;
    rate = next;
  }
  return error("#NUM!");
}
function sequence(args: readonly Value[]): number[] | Scalar {
  const values: number[] = [];
  for (const arg of args)
    for (const entry of entries(arg)) {
      if (isError(entry)) return entry;
      if (entry._tag === "Number") values.push(entry.value);
    }
  return values;
}

export function smallFinance(name: string, args: readonly Value[]): Scalar | undefined {
  if (name === "NPV") {
    if (args.length < 2) return error("#VALUE!");
    const rate = toNumber(scalar(args[0]!));
    if (isError(rate)) return rate;
    const values = sequence(args.slice(1));
    if (!Array.isArray(values)) return values as Scalar;
    return number(
      values.reduce((sum, value, index) => sum + value / (1 + rate.value) ** (index + 1), 0),
    );
  }
  if (name === "IRR") {
    if (args.length < 1 || args.length > 2) return error("#VALUE!");
    const values = sequence([args[0]!]);
    if (!Array.isArray(values)) return values as Scalar;
    if (!values.some((value) => value > 0) || !values.some((value) => value < 0))
      return error("#NUM!");
    const guess = args[1] ? toNumber(scalar(args[1])) : number(0.1);
    if (isError(guess)) return guess;
    return solve(
      (rate) => values.reduce((sum, value, index) => sum + value / (1 + rate) ** index, 0),
      guess.value,
    );
  }
  if (["SLN", "SYD", "DDB"].includes(name)) {
    const values = parameters(
      args,
      name === "SLN" ? 3 : 4,
      name === "DDB" ? 5 : name === "SLN" ? 3 : 4,
    );
    if (!Array.isArray(values)) return values as Scalar;
    const [cost, salvage, life, period] = values;
    if (
      life! <= 0 ||
      salvage! < 0 ||
      salvage! > cost! ||
      (period !== undefined && (period < 1 || period > life!))
    )
      return error("#NUM!");
    if (name === "SLN") return number((cost! - salvage!) / life!);
    if (name === "SYD")
      return number(((cost! - salvage!) * (life! + 1 - period!) * 2) / ((life! + 1) * life!));
    const factor = values[4] ?? 2;
    if (factor <= 0) return error("#NUM!");
    let book = cost!;
    let depreciation = 0;
    for (let i = 1; i <= Math.trunc(period!); i++) {
      depreciation = Math.max(0, Math.min((book * factor) / life!, book - salvage!));
      book -= depreciation;
    }
    return number(depreciation);
  }
  if (["FV", "NPER", "PMT", "PV", "RATE"].includes(name)) {
    const values = parameters(args, 3, name === "RATE" ? 6 : 5);
    if (!Array.isArray(values)) return values as Scalar;
    const [a, b, c] = values;
    const fourth = values[3] ?? 0;
    const type = values[4] ?? 0;
    if (type !== 0 && type !== 1) return error("#NUM!");
    if (name === "RATE") {
      if (a! <= 0) return error("#NUM!");
      return solve((rate) => cashflow(rate, a!, b!, c!, fourth, type), values[5] ?? 0.1);
    }
    if (name === "NPER") {
      if (a === 0) return b === 0 ? error("#DIV/0!") : number(-(c! + fourth) / b!);
      const payment = (b! * (1 + a! * type)) / a!;
      const ratio = (payment - fourth) / (c! + payment);
      return ratio > 0 && a! > -1 ? number(Math.log(ratio) / Math.log(1 + a!)) : error("#NUM!");
    }
    const compound = (1 + a!) ** b!;
    const annuity = a === 0 ? b! : (compound - 1) / a!;
    if (name === "FV") return number(-(c! * (1 + a! * type) * annuity + fourth * compound));
    if (name === "PV") return number(-(c! * (1 + a! * type) * annuity + fourth) / compound);
    if (b! <= 0) return error("#NUM!");
    return number(-(c! * compound + fourth) / ((1 + a! * type) * annuity));
  }
  return undefined;
}
