import { Data, Effect, Option } from "effect";
import { addressKey, parseAddress, sameSheet } from "./Address.js";
import type { Scalar } from "./Value.js";
import { bool, error, number, text } from "./Value.js";

export type Dialect = "openformula" | "excel";
export interface ParseOptions {
  readonly dialect?: Dialect;
  readonly maxLength?: number;
  readonly maxDepth?: number;
  readonly currentSheet?: string;
}
export type Ast =
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Literal"; readonly value: Scalar }
  | { readonly _tag: "Reference"; readonly key: string }
  | { readonly _tag: "Range"; readonly start: string; readonly end: string }
  | { readonly _tag: "Unary"; readonly operator: "+" | "-" | "%"; readonly value: Ast }
  | { readonly _tag: "Binary"; readonly operator: string; readonly left: Ast; readonly right: Ast }
  | { readonly _tag: "Call"; readonly name: string; readonly args: readonly Ast[] };
export class ParseError extends Data.TaggedError("ParseError")<{
  readonly message: string;
  readonly offset: number;
}> {}
interface Token {
  readonly kind:
    | "number"
    | "string"
    | "error"
    | "word"
    | "field"
    | "odfReference"
    | "symbol"
    | "eof";
  readonly value: string;
  readonly offset: number;
}
const cellPattern = /^\$?[A-Z]+\$?[1-9][0-9]*$/i;
function odfAddress(part: string, localSheet: Option.Option<string>, offset: number): string {
  const match = /^(.*)\.(\$?[A-Z]+\$?[1-9][0-9]*|\$?[A-Z]+|\$?[1-9][0-9]*)$/.exec(part);
  if (!match) throw new ParseError({ message: "Invalid OpenFormula reference", offset });
  const locator = match[1]!;
  let sheet = localSheet;
  if (locator) {
    const raw = locator.startsWith("$") ? locator.slice(1) : locator;
    if (raw.startsWith("'")) {
      if (!/^'(?:[^']|'')+'$/.test(raw))
        throw new ParseError({ message: "Invalid sheet name", offset });
      sheet = Option.some(raw.slice(1, -1).replaceAll("''", "'"));
    } else {
      if (!raw || [...raw].some((character) => "]. #$'".includes(character)))
        throw new ParseError({ message: "Invalid sheet name", offset });
      sheet = Option.some(raw);
    }
  }
  const value = match[2]!.replaceAll("$", "");
  const kind = /^[A-Z]+[1-9]/.test(value) ? "cell" : /^[A-Z]+$/.test(value) ? "column" : "row";
  const key = addressKey(kind, value, sheet);
  if (Option.isNone(parseAddress(key)))
    throw new ParseError({ message: "Invalid OpenFormula address", offset });
  return key;
}
function odfReference(value: string, localSheet: Option.Option<string>, offset: number): Ast {
  if (value === "#REF!") return { _tag: "Literal", value: error("#REF!") };
  const parts: string[] = [];
  let quoted = false;
  let startIndex = 0;
  for (let index = 0; index < value.length; index++) {
    if (value[index] === "'") {
      if (quoted && value[index + 1] === "'") {
        index++;
        continue;
      }
      quoted = !quoted;
    } else if (value[index] === ":" && !quoted) {
      parts.push(value.slice(startIndex, index));
      startIndex = index + 1;
    }
  }
  parts.push(value.slice(startIndex));
  if (parts.length > 2) throw new ParseError({ message: "Invalid OpenFormula range", offset });
  const start = odfAddress(parts[0]!, localSheet, offset);
  if (parts.length === 1) {
    if (!start.startsWith("cell:"))
      throw new ParseError({
        message: "Whole-row and whole-column references require a range",
        offset,
      });
    return { _tag: "Reference", key: start };
  }
  const inheritedSheet = Option.flatMap(parseAddress(start), (address) => address.sheet);
  const end = odfAddress(parts[1]!, inheritedSheet, offset);
  const a = parseAddress(start);
  const b = parseAddress(end);
  if (
    Option.isNone(a) ||
    Option.isNone(b) ||
    a.value.kind !== b.value.kind ||
    !sameSheet(a.value, b.value)
  )
    throw new ParseError({ message: "Range endpoints must have the same kind and sheet", offset });
  return { _tag: "Range", start, end };
}
function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    if (/\s/.test(source[i]!)) {
      i++;
      continue;
    }
    const offset = i;
    const rest = source.slice(i);
    const constantError = /^#(?:DIV\/0!|VALUE!|REF!|NAME\?|NUM!|CYCLE!|N\/A|NULL!)/.exec(rest);
    if (constantError) {
      tokens.push({ kind: "error", value: constantError[0], offset });
      i += constantError[0].length;
      continue;
    }
    const numeric = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?/.exec(rest);
    if (numeric) {
      tokens.push({ kind: "number", value: numeric[0], offset });
      i += numeric[0].length;
      continue;
    }
    if (source[i] === '"') {
      i++;
      let value = "";
      let closed = false;
      while (i < source.length) {
        if (source[i] === '"') {
          if (source[i + 1] === '"') {
            value += '"';
            i += 2;
            continue;
          }
          i++;
          closed = true;
          break;
        }
        value += source[i++];
      }
      if (!closed) throw new ParseError({ message: "Unclosed string", offset });
      tokens.push({ kind: "string", value, offset });
      continue;
    }
    if (source[i] === "[") {
      let end = i + 1;
      let quoted = false;
      for (; end < source.length; end++) {
        if (source[end] === "'") {
          if (quoted && source[end + 1] === "'") {
            end++;
            continue;
          }
          quoted = !quoted;
        }
        if (source[end] === "]" && !quoted) break;
      }
      if (end === source.length)
        throw new ParseError({ message: "Unclosed field reference", offset });
      const value = source.slice(i + 1, end);
      if (/\.(?:\$?[A-Z][A-Z0-9$]*|\$?[0-9]+)(?::|$)/.test(value) || value === "#REF!") {
        tokens.push({ kind: "odfReference", value, offset });
        i = end + 1;
        continue;
      }
      if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(value))
        throw new ParseError({ message: "Invalid field key", offset });
      tokens.push({ kind: "field", value, offset });
      i = end + 1;
      continue;
    }
    const word = /^(?:\$\$|\$)?[A-Za-z_][A-Za-z0-9_.$]*/.exec(rest);
    if (word) {
      tokens.push({ kind: "word", value: word[0], offset });
      i += word[0].length;
      continue;
    }
    const symbol = /^(?:<=|>=|<>|[+\-*/^&=<>():;,%!])/.exec(rest);
    if (symbol) {
      tokens.push({ kind: "symbol", value: symbol[0], offset });
      i += symbol[0].length;
      continue;
    }
    throw new ParseError({ message: `Unexpected character ${source[i]}`, offset });
  }
  tokens.push({ kind: "eof", value: "", offset: i });
  return tokens;
}
const precedence: Readonly<Record<string, number>> = {
  "=": 1,
  "<>": 1,
  "<": 1,
  "<=": 1,
  ">": 1,
  ">=": 1,
  "&": 2,
  "+": 3,
  "-": 3,
  "*": 4,
  "/": 4,
  "^": 6,
  "!": 8,
};
class Reader {
  index = 0;
  depth = 0;
  constructor(
    readonly tokens: readonly Token[],
    readonly separator: string,
    readonly maxDepth: number,
    readonly dialect: Dialect,
    readonly currentSheet: Option.Option<string>,
  ) {}
  get current(): Token {
    return this.tokens[this.index]!;
  }
  take(value: string): boolean {
    if (this.current.value === value) {
      this.index++;
      return true;
    }
    return false;
  }
  need(value: string): void {
    if (!this.take(value)) this.fail(`Expected ${value}`);
  }
  fail(message: string): never {
    throw new ParseError({ message, offset: this.current.offset });
  }
  expression(min = 0): Ast {
    if (++this.depth > this.maxDepth) this.fail("Formula nesting limit exceeded");
    let left = this.primary();
    while (true) {
      const op = this.current.value;
      if (op === "%" && 7 >= min) {
        this.index++;
        left = { _tag: "Unary", operator: "%", value: left };
        continue;
      }
      if (op === ":" && 7 >= min) {
        this.index++;
        const right = this.primary();
        if (
          left._tag !== "Reference" ||
          right._tag !== "Reference" ||
          !left.key.startsWith("cell:") ||
          !right.key.startsWith("cell:")
        )
          this.fail("Range endpoints must be cells");
        const a = parseAddress(left.key);
        const b = parseAddress(right.key);
        if (Option.isNone(a) || Option.isNone(b) || !sameSheet(a.value, b.value))
          this.fail("Range endpoints must be on the same sheet");
        left = { _tag: "Range", start: left.key, end: right.key };
        continue;
      }
      const precedenceOption = Option.fromNullable(precedence[op]);
      if (Option.isNone(precedenceOption) || precedenceOption.value < min) break;
      const p = precedenceOption.value;
      this.index++;
      const right = this.expression(op === "^" && this.dialect === "excel" ? p : p + 1);
      left = { _tag: "Binary", operator: op, left, right };
    }
    this.depth--;
    return left;
  }
  primary(): Ast {
    const token = this.current;
    if (token.kind === "eof") this.fail("Expected expression");
    const prefixPrecedence = this.dialect === "openformula" ? 8 : 5;
    if (this.take("+"))
      return { _tag: "Unary", operator: "+", value: this.expression(prefixPrecedence) };
    if (this.take("-"))
      return { _tag: "Unary", operator: "-", value: this.expression(prefixPrecedence) };
    if (this.take("(")) {
      const value = this.expression();
      this.need(")");
      return value;
    }
    this.index++;
    if (token.kind === "number") {
      const value = number(Number(token.value));
      if (value._tag === "Error") this.fail("Numeric literal is not finite");
      return { _tag: "Literal", value };
    }
    if (token.kind === "string") return { _tag: "Literal", value: text(token.value) };
    if (token.kind === "error")
      return { _tag: "Literal", value: error(token.value as Parameters<typeof error>[0]) };
    if (token.kind === "odfReference")
      return odfReference(token.value, this.currentSheet, token.offset);
    if (token.kind === "field") return { _tag: "Reference", key: `field:${token.value}` };
    if (token.kind === "word") {
      const word = token.value.toUpperCase();
      if (this.take("(")) {
        const args: Ast[] = [];
        if (!this.take(")")) {
          while (true) {
            args.push(
              this.current.value === this.separator || this.current.value === ")"
                ? { _tag: "Missing" }
                : this.expression(),
            );
            if (this.take(")")) break;
            this.need(this.separator);
          }
        }
        return { _tag: "Call", name: word, args };
      }
      if (word === "TRUE" || word === "FALSE")
        return { _tag: "Literal", value: bool(word === "TRUE") };
      if (cellPattern.test(word))
        return {
          _tag: "Reference",
          key: addressKey("cell", word.replaceAll("$", ""), this.currentSheet),
        };
      const name = word.startsWith("$$") ? word.slice(2) : word;
      return { _tag: "Reference", key: `name:${name}` };
    }
    this.fail("Expected expression");
  }
}
export function parseSync(formula: string, options: ParseOptions = {}): Ast {
  if (formula.length > (options.maxLength ?? 65536))
    throw new ParseError({ message: "Formula length limit exceeded", offset: 0 });
  const source = formula.startsWith("==")
    ? formula.slice(2)
    : formula.startsWith("=")
      ? formula.slice(1)
      : formula;
  const reader = new Reader(
    lex(source),
    options.dialect === "excel" ? "," : ";",
    options.maxDepth ?? 100,
    options.dialect ?? "openformula",
    Option.fromNullable(options.currentSheet),
  );
  const ast = reader.expression();
  if (reader.current.kind !== "eof") reader.fail("Unexpected token");
  return ast;
}
export const parse = (
  formula: string,
  options: ParseOptions = {},
): Effect.Effect<Ast, ParseError> =>
  Effect.try({
    try: () => parseSync(formula, options),
    catch: (cause) =>
      cause instanceof ParseError ? cause : new ParseError({ message: String(cause), offset: 0 }),
  });
export function references(ast: Ast): ReadonlySet<string> {
  const keys = new Set<string>();
  const visit = (node: Ast): void => {
    switch (node._tag) {
      case "Reference":
        keys.add(node.key);
        break;
      case "Range":
        keys.add(node.start);
        keys.add(node.end);
        break;
      case "Unary":
        visit(node.value);
        break;
      case "Binary":
        visit(node.left);
        visit(node.right);
        break;
      case "Call":
        node.args.forEach(visit);
        break;
    }
  };
  visit(ast);
  return keys;
}
