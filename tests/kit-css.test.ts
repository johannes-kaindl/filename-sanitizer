import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { findVendoredCss, missingKitCss } from "./vendor/kit/kit-css";

describe("Kit-CSS", () => {
  it("jede gevendorte *_CSS-Konstante steht wortgleich in styles.css", () => {
    const vendorDir = "src/vendor/kit-obsidian";
    expect(findVendoredCss(vendorDir).length).toBeGreaterThan(0);
    expect(missingKitCss(vendorDir, readFileSync("styles.css", "utf8"))).toEqual([]);
  });
});
