import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { blank, error, form, number, spreadsheet, text } from "../src/index.js";

describe("spreadsheet adapter", () => {
  it("treats empty cells as blank and recalculates a range after a batch edit", async () => {
    const sheet = await Effect.runPromise(spreadsheet());
    expect(await Effect.runPromise(sheet.get("A1"))).toEqual(blank);
    const initial = await Effect.runPromise(
      sheet.set({
        a1: number(2),
        A2: number(3),
        B1: { formula: "=SUM(A1:A3)" },
      }),
    );
    expect(initial.changed.get("B1")).toEqual(number(5));
    expect(await Effect.runPromise(sheet.get("b1"))).toEqual(number(5));
    const changed = await Effect.runPromise(sheet.set({ A2: number(7) }));
    expect(changed.changed.get("B1")).toEqual(number(9));
    expect((await Effect.runPromise(sheet.snapshot())).get("B1")).toEqual(number(9));
    expect(await Effect.runPromise(sheet.get("C1"))).toEqual(blank);
  });
  it("validates addresses and keeps cross-kind references invalid", async () => {
    const sheet = await Effect.runPromise(spreadsheet());
    await expect(Effect.runPromise(sheet.set({ "1A": number(2) }))).rejects.toThrow(
      "Invalid cell name",
    );
    await expect(Effect.runPromise(sheet.set({ A9007199254740992: number(2) }))).rejects.toThrow(
      "Invalid cell name",
    );
    await Effect.runPromise(sheet.set({ A1: { formula: "=[unknown]" } }));
    expect(await Effect.runPromise(sheet.get("A1"))).toEqual(error("#REF!"));
  });
});

describe("form adapter", () => {
  it("uses declared fields and recalculates a computed total", async () => {
    const builder = await Effect.runPromise(form(["price", "quantity", "total"]));
    expect(await Effect.runPromise(builder.get("price"))).toEqual(blank);
    await Effect.runPromise(
      builder.set({
        price: number(12),
        quantity: number(3),
        total: { formula: "=IF([quantity]>0;[price]*[quantity];0)" },
      }),
    );
    expect(await Effect.runPromise(builder.get("total"))).toEqual(number(36));
    const revision = await Effect.runPromise(builder.set({ quantity: number(0) }));
    expect(revision.changed.get("total")).toEqual(number(0));
    await Effect.runPromise(builder.set({ price: null }));
    expect(await Effect.runPromise(builder.get("price"))).toEqual(blank);
  });
  it("rejects undeclared fields and preserves text input as data", async () => {
    const builder = await Effect.runPromise(form(["label", "output"]));
    await expect(Effect.runPromise(builder.set({ missing: number(1) }))).rejects.toThrow(
      "Unknown field",
    );
    await Effect.runPromise(builder.set({ label: text("=1+2"), output: { formula: "=[label]" } }));
    expect(await Effect.runPromise(builder.get("output"))).toEqual(text("=1+2"));
    await Effect.runPromise(builder.set({ output: { formula: "=[missing]" } }));
    expect(await Effect.runPromise(builder.get("output"))).toEqual(error("#REF!"));
  });
});
