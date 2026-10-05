import { describe, expect, it } from "vitest";
import {
  formatTabIds,
  moveTab,
  parseHiddenTabs,
  parseTabOrder,
} from "./panel-tabs.js";

const defaults = ["issues", "pulls", "auto-fixers"] as const;

describe("panel tab order", () => {
  it("uses the default order when nothing is saved", () => {
    expect(parseTabOrder(defaults, "")).toEqual(defaults);
  });

  it("keeps the saved order and ignores spaces", () => {
    expect(parseTabOrder(defaults, " auto-fixers ,pulls,issues")).toEqual([
      "auto-fixers",
      "pulls",
      "issues",
    ]);
  });

  it("ignores unknown and repeated ids", () => {
    expect(parseTabOrder(defaults, "my-prs,pulls,,pulls,removed,auto-fixers,issues")).toEqual([
      "pulls",
      "auto-fixers",
      "issues",
    ]);
  });

  it("ignores the removed settings tab in old saved values", () => {
    expect(parseTabOrder(defaults, "settings,auto-fixers,pulls,issues")).toEqual([
      "auto-fixers",
      "pulls",
      "issues",
    ]);
    expect(parseTabOrder(defaults, "pulls,settings,issues,auto-fixers")).toEqual([
      "pulls",
      "issues",
      "auto-fixers",
    ]);
    expect(parseTabOrder(defaults, "settings")).toEqual(defaults);
  });

  it("adds missing tabs at their default position", () => {
    expect(parseTabOrder(defaults, "auto-fixers,issues")).toEqual([
      "auto-fixers",
      "pulls",
      "issues",
    ]);
    expect(parseTabOrder(defaults, "pulls,issues")).toEqual([
      "pulls",
      "issues",
      "auto-fixers",
    ]);
    expect(parseTabOrder(defaults, "auto-fixers")).toEqual([
      "issues",
      "pulls",
      "auto-fixers",
    ]);
  });

  it("round-trips through formatTabIds", () => {
    const order = ["auto-fixers", "issues", "pulls"] as const;
    expect(parseTabOrder(defaults, formatTabIds(order))).toEqual(order);
  });
});

describe("hidden panel tabs", () => {
  it("hides only known tabs", () => {
    expect([...parseHiddenTabs(defaults, "pulls, settings,unknown,auto-fixers")]).toEqual([
      "pulls",
      "auto-fixers",
    ]);
    expect(parseHiddenTabs(defaults, "").size).toBe(0);
  });
});

describe("moving a panel tab", () => {
  it("moves a tab to the given index", () => {
    expect(moveTab(defaults, "auto-fixers", 0)).toEqual(["auto-fixers", "issues", "pulls"]);
    expect(moveTab(defaults, "issues", 2)).toEqual(["pulls", "auto-fixers", "issues"]);
    expect(moveTab(defaults, "pulls", 1)).toEqual(defaults);
  });

  it("clamps the index to the list bounds", () => {
    expect(moveTab(defaults, "issues", -1)).toEqual(defaults);
    expect(moveTab(defaults, "issues", 9)).toEqual(["pulls", "auto-fixers", "issues"]);
  });

  it("leaves the order unchanged for an unknown tab", () => {
    expect(moveTab<string>(defaults, "removed", 0)).toEqual(defaults);
  });
});
