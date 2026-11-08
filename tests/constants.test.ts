import { describe, expect, it } from "vitest";
import * as constants from "../src/core/constants";
import { REPEAT_LIMIT, REPEAT_WINDOW_MS, RENAME_DEADLINE_MS, DEFAULT_QUIET_MS } from "../src/core/constants";

describe("constants", () => {
  it("fixed limits match the plan", () => {
    expect([DEFAULT_QUIET_MS, REPEAT_LIMIT, REPEAT_WINDOW_MS, RENAME_DEADLINE_MS]).toEqual([5000, 3, 600000, 10000]);
  });
  it("keine Endungsliste: die Automatik unterscheidet nicht nach Endung", () => {
    expect(Object.keys(constants).filter((k) => /extension/i.test(k))).toEqual([]);
  });
});
