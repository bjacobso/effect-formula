import { Option } from "effect";
import { describe, expect, it } from "vitest";
import { smallDate } from "../src/SmallDate.js";
import { number } from "../src/Value.js";

describe("time component round trips", () => {
  it("preserves every exact hour and minute constructed by TIME", () => {
    for (let hour = 0; hour < 24; hour++)
      for (let minute = 0; minute < 60; minute++) {
        const time = Option.getOrThrow(
          smallDate("TIME", [number(hour), number(minute), number(0)], {}),
        );
        expect(Option.getOrThrow(smallDate("HOUR", [time], {}))).toEqual(number(hour));
        expect(Option.getOrThrow(smallDate("MINUTE", [time], {}))).toEqual(number(minute));
      }
  });
});
