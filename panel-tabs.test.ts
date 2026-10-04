import { describe, expect, it } from "vitest";
import {
  formatTabIds,
  moveTab,
  parseHiddenTabs,
  parseTabOrder,
} from "./panel-tabs.js";

const defaults = ["issues", "pulls", "auto-fixers", "settings"] as const;

describe("panel tab order", () => {
  it("uses the default order when nothing is saved", () => {
    expect(parseTabOrder(defaults, "")).toEqual(defaults);
  });

  it("keeps the saved order and ignores spaces", () => {
    expect(parseTabOrder(defaults, "settings, auto-fixers ,pulls,issues")).toEqual([
      "settings",
      "auto-fixers",
      "pulls",
      "issues",
    ]);
  });

  it("ignores unknown and repeated ids", () => {
    expect(parseTabOrder(defaults, "my-prs,pulls,,pulls,issues,removed,settings,auto-fixers")).toEqual([
      "pulls",
      "issues",
      "settings",
      "auto-fixers",
    ]);
  });

  it("adds missing tabs at their default position", () => {
    expect(parseTabOrder(defaults, "settings,pulls")).toEqual([
      "issues",
      "settings",
      "auto-fixers",
      "pulls",
    ]);
    expect(parseTabOrder(defaults, "pulls,issues")).toEqual([
      "pulls",
      "issues",
      "auto-fixers",
      "settings",
    ]);
    expect(parseTabOrder(defaults, "settings")).toEqual([
      "issues",
      "pulls",
      "auto-fixers",
      "settings",
    ]);
  });

  it("round-trips through formatTabIds", () => {
    const order = ["auto-fixers", "issues", "settings", "pulls"] as const;
    expect(parseTabOrder(defaults, formatTabIds(order))).toEqual(order);
  });
});

describe("hidden panel tabs", () => {
  const hideable = ["issues", "pulls", "auto-fixers"] as const;

  it("hides only tabs that can be hidden", () => {
    expect([...parseHiddenTabs(hideable, "pulls, settings,unknown,auto-fixers")]).toEqual([
      "pulls",
      "auto-fixers",
    ]);
    expect(parseHiddenTabs(hideable, "").size).toBe(0);
  });
});

describe("moving a panel tab", () => {
  it("moves a tab to the given index", () => {
    expect(moveTab(defaults, "settings", 0)).toEqual(["settings", "issues", "pulls", "auto-fixers"]);
    expect(moveTab(defaults, "issues", 2)).toEqual(["pulls", "auto-fixers", "issues", "settings"]);
    expect(moveTab(defaults, "pulls", 1)).toEqual(defaults);
  });

  it("clamps the index to the list bounds", () => {
    expect(moveTab(defaults, "issues", -1)).toEqual(defaults);
    expect(moveTab(defaults, "issues", 9)).toEqual(["pulls", "auto-fixers", "settings", "issues"]);
  });

  it("leaves the order unchanged for an unknown tab", () => {
    expect(moveTab<string>(defaults, "removed", 0)).toEqual(defaults);
  });
});
