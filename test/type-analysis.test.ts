import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { analyzeFormulaTypes, parseSync } from "../src/index.js";

const analyze = (formula: string, types: Parameters<typeof analyzeFormulaTypes>[1] = {}) =>
  Effect.runSync(analyzeFormulaTypes(parseSync(formula), types));

describe("AST type analysis", () => {
  it("infers numeric arithmetic and comparison results", () => {
    expect(
      analyze("=[price]*[quantity]", { "field:price": "Number", "field:quantity": "Number" }),
    ).toEqual({
      types: ["Number"],
      diagnostics: [],
    });
    expect(analyze("=[price]>0", { "field:price": "Number" })).toEqual({
      types: ["Boolean"],
      diagnostics: [],
    });
  });

  it("separates possible text coercion from a definitely invalid literal", () => {
    expect(analyze("=[price]*2", { "field:price": "Text" })).toEqual({
      types: ["Error", "Number"],
      diagnostics: [
        {
          path: "root.left",
          severity: "possible",
          message: "Cannot guarantee conversion to Number",
        },
      ],
    });
    expect(analyze('="12"*2')).toEqual({ types: ["Number"], diagnostics: [] });
    expect(analyze('="bad"*2')).toEqual({
      types: ["Error"],
      diagnostics: [
        {
          path: "root.left",
          severity: "definite",
          message: "Cannot guarantee conversion to Number",
        },
      ],
    });
  });

  it("unions IF branches and diagnoses an invalid condition", () => {
    expect(analyze('=IF([flag];1;"no")', { "field:flag": "Boolean" })).toEqual({
      types: ["Number", "Text"],
      diagnostics: [],
    });
    expect(analyze('=IF([flag];1;"no")', { "field:flag": "Text" })).toEqual({
      types: ["Error"],
      diagnostics: [
        {
          path: "root.args[0]",
          severity: "definite",
          message: "Cannot guarantee conversion to Boolean",
        },
      ],
    });
    expect(analyze("=IF([flag];1)", { "field:flag": "Boolean" })).toEqual({
      types: ["Number", "Boolean"],
      diagnostics: [],
    });
  });

  it("keeps missing declarations and unsupported functions unknown", () => {
    expect(analyze("=[price]+1")).toEqual({
      types: ["Unknown"],
      diagnostics: [
        { path: "root.left", severity: "possible", message: "No declared type for field:price" },
      ],
    });
    expect(analyze("=CUSTOM([price])", { "field:price": "Number" })).toEqual({
      types: ["Unknown"],
      diagnostics: [],
    });
  });

  it("identifies a range used as a scalar", () => {
    expect(analyze("=A1:A2+1")).toEqual({
      types: ["Error"],
      diagnostics: [
        {
          path: "root.left",
          severity: "definite",
          message: "Cannot guarantee conversion to Number",
        },
      ],
    });
  });
});
