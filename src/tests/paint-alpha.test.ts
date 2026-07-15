import { describe, expect, it } from "vitest";
import { parsePaint } from "~/transformers/style.js";
import type { Paint } from "@figma/rest-api-spec";

/**
 * Figma stores a solid paint's alpha in TWO fields: the paint-level `opacity`
 * and the color's own `a` channel. Effective alpha is their product. This is
 * a recurring misreading (a fill showing `color.a: 1.0` looks like "alpha was
 * lost" when the 0.85 actually lives in `opacity`), so these tests pin the
 * multiplication — a future "fix" that reads only one field must fail here.
 */
describe("solid paint alpha", () => {
  const black = { r: 0, g: 0, b: 0, a: 1 };

  it("multiplies paint opacity into the alpha channel (opacity 0.85 × a 1.0)", () => {
    const paint = { type: "SOLID", color: black, opacity: 0.8500000238418579 } as Paint;
    expect(parsePaint(paint)).toBe("rgba(0, 0, 0, 0.85)");
  });

  it("uses color.a when there is no paint opacity", () => {
    const paint = { type: "SOLID", color: { ...black, a: 0.6 } } as Paint;
    expect(parsePaint(paint)).toBe("rgba(0, 0, 0, 0.6)");
  });

  it("multiplies both when both are set", () => {
    const paint = { type: "SOLID", color: { ...black, a: 0.5 }, opacity: 0.5 } as Paint;
    expect(parsePaint(paint)).toBe("rgba(0, 0, 0, 0.25)");
  });

  it("emits plain hex when fully opaque", () => {
    const paint = { type: "SOLID", color: black } as Paint;
    expect(parsePaint(paint)).toBe("#000000");
  });
});
