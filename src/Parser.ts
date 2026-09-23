import { Data, Effect } from "effect";
import type { Scalar } from "./Value.js";
import { bool, number, text } from "./Value.js";

export type Dialect = "openformula" | "excel";
export interface ParseOptions {
  readonly dialect?: Dialect;
  readonly maxLength?: number;
  readonly maxDepth?: number;
}
export type Ast =
  | { readonly _tag: "Literal"; readonly value: Scalar }
  | { readonly _tag: "Reference"; readonly key: string }
  | { readonly _tag: "Range"; readonly start: string; readonly end: string }
  | { readonly _tag: "Unary"; readonly operator: "+" | "-"; readonly value: Ast }
  | { readonly _tag: "Binary"; readonly operator: string; readonly left: Ast; readonly right: Ast }
  | { readonly _tag: "Call"; readonly name: string; readonly args: readonly Ast[] };
export class ParseError extends Data.TaggedError("ParseError")<{
  readonly message: string;
  readonly offset: number;
}> {}
interface Token {
  readonly kind: "number" | "string" | "word" | "field" | "symbol" | "eof";
  readonly value: string;
  readonly offset: number;
}
const cellPattern = /^\$?[A-Z]+\$?[1-9][0-9]*$/i;
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
      const end = source.indexOf("]", i + 1);
      if (end < 0) throw new ParseError({ message: "Unclosed field reference", offset });
      const value = source.slice(i + 1, end);
      if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(value))
        throw new ParseError({ message: "Invalid field key", offset });
      tokens.push({ kind: "field", value, offset });
      i = end + 1;
      continue;
    }
    const word = /^(?:\$?[A-Za-z_][A-Za-z0-9_.$]*)/.exec(rest);
    if (word) {
      tokens.push({ kind: "word", value: word[0], offset });
      i += word[0].length;
      continue;
    }
    const symbol = /^(?:<=|>=|<>|[+\-*/^&=<>():;,])/.exec(rest);
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
};
class Reader {
  index = 0;
  depth = 0;
  constructor(
    readonly tokens: readonly Token[],
    readonly separator: string,
    readonly maxDepth: number,
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
        left = { _tag: "Range", start: left.key, end: right.key };
        continue;
      }
      const p = precedence[op];
      if (p === undefined || p < min) break;
      this.index++;
      const right = this.expression(op === "^" ? p : p + 1);
      left = { _tag: "Binary", operator: op, left, right };
    }
    this.depth--;
    return left;
  }
  primary(): Ast {
    const token = this.current;
    if (token.kind === "eof") this.fail("Expected expression");
    if (this.take("+")) return { _tag: "Unary", operator: "+", value: this.expression(5) };
    if (this.take("-")) return { _tag: "Unary", operator: "-", value: this.expression(5) };
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
    if (token.kind === "field") return { _tag: "Reference", key: `field:${token.value}` };
    if (token.kind === "word") {
      const word = token.value.toUpperCase();
      if (this.take("(")) {
        const args: Ast[] = [];
        if (!this.take(")")) {
          do {
            args.push(this.expression());
          } while (this.take(this.separator));
          this.need(")");
        }
        return { _tag: "Call", name: word, args };
      }
      if (word === "TRUE" || word === "FALSE")
        return { _tag: "Literal", value: bool(word === "TRUE") };
      if (cellPattern.test(word))
        return { _tag: "Reference", key: `cell:${word.replaceAll("$", "")}` };
      this.fail(`Unknown name ${token.value}`);
    }
    this.fail("Expected expression");
  }
}
export function parseSync(formula: string, options: ParseOptions = {}): Ast {
  if (formula.length > (options.maxLength ?? 10000))
    throw new ParseError({ message: "Formula length limit exceeded", offset: 0 });
  const source = formula.startsWith("=") ? formula.slice(1) : formula;
  const reader = new Reader(
    lex(source),
    options.dialect === "excel" ? "," : ";",
    options.maxDepth ?? 100,
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
