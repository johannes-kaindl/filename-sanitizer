import { describe, expect, it } from "vitest";
import { LINK_SAFE_EXTENSIONS, isLinkSafeExtension, REPEAT_LIMIT, REPEAT_WINDOW_MS, RENAME_DEADLINE_MS, DEFAULT_QUIET_MS } from "../src/core/constants";

describe("constants", () => {
  it("fixed limits match the plan", () => {
    expect([DEFAULT_QUIET_MS, REPEAT_LIMIT, REPEAT_WINDOW_MS, RENAME_DEADLINE_MS]).toEqual([5000, 3, 600000, 10000]);
  });
  it("link safe extensions: known pass, unknown and empty do not", () => {
    for (const e of ["md", "canvas", "png", "pdf", "mp4"]) expect(LINK_SAFE_EXTENSIONS).toContain(e);
    expect(isLinkSafeExtension("MD")).toBe(true);
    expect(isLinkSafeExtension("foo")).toBe(false);
    expect(isLinkSafeExtension("")).toBe(false);
  });
});
