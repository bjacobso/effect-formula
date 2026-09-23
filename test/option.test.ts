import { Option } from "effect";
import { describe, expect, it } from "vitest";
import { offsetReferenceKeys, parseSync, rangeKeys, referenceKeys } from "../src/index.js";

describe("reference geometry options", () => {
  it("returns Some for valid geometry and None for absent or invalid geometry", () => {
    expect(rangeKeys("cell:A1", "cell:B2")).toEqual(
      Option.some([
        ["cell:A1", "cell:B1"],
        ["cell:A2", "cell:B2"],
      ]),
    );
    expect(rangeKeys("field:price", "cell:B2")).toEqual(Option.none());
    expect(rangeKeys("cell:A1", "cell:B2", 3)).toEqual(Option.none());
    expect(referenceKeys(parseSync("=SUM(1;2)"))).toEqual(Option.none());
    expect(offsetReferenceKeys(parseSync("=[.A1:.A2]"), parseSync("=[.B1]"))).toEqual(
      Option.some([["cell:B1"], ["cell:B2"]]),
    );
  });
});
