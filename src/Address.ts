import { Option } from "effect";

export type AddressKind = "cell" | "column" | "row";
export interface Address {
  readonly kind: AddressKind;
  readonly sheet: Option.Option<string>;
  readonly column: number;
  readonly row: number;
}
export interface GridBounds {
  readonly rows: number;
  readonly columns: number;
}

const encodedSheet = (name: string) => encodeURIComponent(name).replaceAll("!", "%21");
export function addressKey(
  kind: AddressKind,
  address: string,
  sheet: Option.Option<string>,
): string {
  return `${kind}:${Option.match(sheet, { onNone: () => "", onSome: (name) => `${encodedSheet(name)}!` })}${address.toUpperCase()}`;
}
export function sheetOfKey(key: string): Option.Option<string> {
  return Option.map(parseAddress(key), (address) => address.sheet).pipe(Option.flatten);
}
export function columnNumber(letters: string): Option.Option<number> {
  if (!/^[A-Z]+$/.test(letters)) return Option.none();
  let column = 0;
  for (const letter of letters) column = column * 26 + letter.charCodeAt(0) - 64;
  return Number.isSafeInteger(column) ? Option.some(column) : Option.none();
}
export function columnLetters(column: number): string {
  let name = "";
  for (let n = column; n > 0; n = Math.floor((n - 1) / 26))
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}
export function parseAddress(key: string): Option.Option<Address> {
  const match = /^(cell|column|row):(?:(.+)!)?([A-Z]+[1-9][0-9]*|[A-Z]+|[1-9][0-9]*)$/.exec(key);
  if (!match) return Option.none();
  let sheet = Option.none<string>();
  if (match[2]) {
    try {
      const decoded = decodeURIComponent(match[2]);
      if (!decoded || encodedSheet(decoded) !== match[2]) return Option.none();
      sheet = Option.some(decoded);
    } catch {
      return Option.none();
    }
  }
  const kind = match[1] as AddressKind;
  const value = match[3]!;
  const parts = /^([A-Z]+)?([1-9][0-9]*)?$/.exec(value);
  if (!parts) return Option.none();
  if (kind === "cell" && (!parts[1] || !parts[2])) return Option.none();
  if (kind === "column" && (!parts[1] || parts[2])) return Option.none();
  if (kind === "row" && (parts[1] || !parts[2])) return Option.none();
  const column = parts[1] ? columnNumber(parts[1]) : Option.some(0);
  const row = parts[2] ? Number(parts[2]) : 0;
  return Option.isSome(column) && Number.isSafeInteger(row)
    ? Option.some({ kind, sheet, column: column.value, row })
    : Option.none();
}
export function sameSheet(left: Address, right: Address): boolean {
  return Option.getOrNull(left.sheet) === Option.getOrNull(right.sheet);
}
