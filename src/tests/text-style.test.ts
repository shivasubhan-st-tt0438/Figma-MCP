import { describe, expect, it } from "vitest";
import { extractTextStyle } from "~/transformers/text.js";
import type { Node as FigmaDocumentNode } from "@figma/rest-api-spec";

function makeText(style: Record<string, unknown>): FigmaDocumentNode {
  return {
    id: "1:1",
    name: "Text",
    type: "TEXT",
    characters: "Hello",
    style,
  } as unknown as FigmaDocumentNode;
}

/**
 * The omit-when-default contract for text styles: every field a designer
 * left at its Figma default must not appear in the output at all, while any
 * genuinely-set value must survive. Pins the four fields from the Figma
 * inspector's type panel (letter spacing, both alignments, position) that a
 * consumer must be able to trust.
 */
describe("extractTextStyle omit-when-default", () => {
  const base = { fontFamily: "SF Pro", fontWeight: 400, fontSize: 13 };

  it("omits default alignments (LEFT / TOP) and zero letter spacing", () => {
    const style = extractTextStyle(
      makeText({
        ...base,
        letterSpacing: 0,
        textAlignHorizontal: "LEFT",
        textAlignVertical: "TOP",
      }),
    )!;
    expect(style.letterSpacing).toBeUndefined();
    expect(style.textAlignHorizontal).toBeUndefined();
    expect(style.textAlignVertical).toBeUndefined();
  });

  it("keeps non-default alignments (Center / Middle)", () => {
    const style = extractTextStyle(
      makeText({
        ...base,
        textAlignHorizontal: "CENTER",
        textAlignVertical: "CENTER",
      }),
    )!;
    expect(style.textAlignHorizontal).toBe("CENTER");
    expect(style.textAlignVertical).toBe("CENTER");
  });

  it("keeps non-zero letter spacing as a % of font size", () => {
    const style = extractTextStyle(makeText({ ...base, letterSpacing: 1.3 }))!;
    expect(style.letterSpacing).toBe("10%");
  });

  it("carries Position: Superscript through opentypeFlags (SUPS)", () => {
    const style = extractTextStyle(makeText({ ...base, opentypeFlags: { SUPS: 1, KERN: 0 } }))!;
    expect(style.opentypeFlags).toEqual({ SUPS: 1 });
  });

  it("omits opentypeFlags entirely when all flags are zero", () => {
    const style = extractTextStyle(makeText({ ...base, opentypeFlags: { KERN: 0 } }))!;
    expect(style.opentypeFlags).toBeUndefined();
  });
});
