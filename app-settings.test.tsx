// @vitest-environment jsdom

import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

afterEach(() => cleanup());

const app = await loadPluginApp(() => import("./app"));
const panel = app.navPanels[0]!;
const account = '["https://gitea.example/","work","dev"]';
const freshness = { state: "fresh" as const, fetchedAt: "2026-09-29T12:00:00Z" };
const list = { items: [], truncated: false, errors: [], account, freshness, login: "dev" };
const preferences = {
  autoFix: false,
  autoMerge: false,
  execution: {
    providerId: "codex",
    model: "gpt-5.6-luna",
    reasoningLevel: "medium",
    serviceTier: "default",
  },
};
const rpc = {
  status: () => ({ state: "connected", login: "dev", account, repos: [] }),
  getAutoFixerPreferences: () => preferences,
  listMyPullRequests: () => list,
  listMyIssues: () => list,
  listItems: () => list,
  listAutoFixerSessions: () => ({ sessions: [] }),
};
const schema = {
  baseUrl: { type: "string" as const, label: "Gitea instance URL", default: "https://gitea.com" },
  tabOrder: { type: "string" as const, label: "Tab order", default: "" },
  autoFixerPlacement: {
    type: "select" as const,
    label: "Auto-fixer threads appear in",
    description: "Where new auto-fixer threads appear.",
    options: ["Gitea tab", "Project sidebar"],
    default: "Gitea tab",
  },
  compact: { type: "boolean" as const, label: "Compact rows", default: false },
};

function render(subPath: string, settings: Record<string, string> = {}, definitions: object = schema) {
  const updateSettings = vi.fn(async ({ values }: { values: Record<string, unknown> }) => ({
    ok: true as const,
    schema: definitions,
    values,
  }));
  const slot = renderSlot(panel, { subPath }, {
    rpc,
    settings,
    sdk: {
      plugins: {
        getSettings: async () => ({ ok: true as const, schema: definitions, values: {} }),
        updateSettings,
      },
    },
  });
  return { slot, updateSettings };
}

function tabs() {
  return screen.getAllByRole("tab").map((tab) => tab.textContent!.replace(/\d+$/, ""));
}

function selected() {
  return screen.getAllByRole("tab").find((tab) => tab.getAttribute("aria-selected") === "true")?.textContent;
}

it("hides tabs turned off in settings but always shows Settings", () => {
  render("", { hiddenTabs: "issues,auto-fixers,settings" });
  expect(tabs()).toEqual(["Pull requests", "Settings"]);
  expect(selected()).toBe("Pull requests");
});

it("opens on the first visible tab in the saved order", async () => {
  render("", { tabOrder: "auto-fixers,settings,pulls,issues" });
  expect(tabs()).toEqual(["Auto-fixers", "Settings", "Pull requests", "Issues"]);
  expect(selected()).toBe("Auto-fixers");
  expect(await screen.findByText(/No auto-fixers yet/)).toBeTruthy();
  cleanup();
  render("", { tabOrder: "auto-fixers,settings", hiddenTabs: "auto-fixers" });
  expect(tabs()).toEqual(["Issues", "Pull requests", "Settings"]);
  expect(selected()).toBe("Issues");
});

it("switches to the first visible tab when the open tab is hidden", () => {
  const { slot } = render("pulls", { tabOrder: "settings,issues", hiddenTabs: "pulls" });
  expect(selected()).toBe("Settings");
  expect(slot.navigateCalls).toContainEqual({
    method: "toPluginPanel",
    path: "gitea",
    options: { subPath: "settings", replace: true },
  });
});

it("hides and shows a tab from the Settings tab", async () => {
  const { updateSettings } = render("settings", { hiddenTabs: "auto-fixers" });
  expect(screen.queryByRole("switch", { name: "Show Settings" })).toBeNull();
  expect((screen.getByRole("switch", { name: "Show Auto-fixers" }) as HTMLInputElement).checked).toBe(false);
  await act(async () => fireEvent.click(screen.getByRole("switch", { name: "Show Pull requests" })));
  expect(updateSettings).toHaveBeenLastCalledWith({
    pluginId: "test-plugin",
    values: { hiddenTabs: "auto-fixers,pulls" },
  });
  expect(tabs()).toEqual(["Issues", "Settings"]);
  await act(async () => fireEvent.click(screen.getByRole("switch", { name: "Show Auto-fixers" })));
  expect(updateSettings).toHaveBeenLastCalledWith({
    pluginId: "test-plugin",
    values: { hiddenTabs: "pulls" },
  });
  expect(tabs()).toEqual(["Issues", "Auto-fixers", "Settings"]);
});

it("restores the tab when saving a hidden tab fails", async () => {
  const { updateSettings } = render("settings");
  updateSettings.mockRejectedValueOnce(new Error("Settings are read-only"));
  await act(async () => fireEvent.click(screen.getByRole("switch", { name: "Show Issues" })));
  expect(tabs()).toEqual(["Issues", "Pull requests", "Auto-fixers", "Settings"]);
});

it("moves a tab with the arrow keys and keeps focus on its handle", async () => {
  const { updateSettings } = render("settings");
  const handle = screen.getByRole("button", { name: "Move Settings" });
  handle.focus();
  await act(async () => fireEvent.keyDown(handle, { key: "ArrowUp" }));
  expect(updateSettings).toHaveBeenLastCalledWith({
    pluginId: "test-plugin",
    values: { tabOrder: "issues,pulls,settings,auto-fixers" },
  });
  expect(tabs()).toEqual(["Issues", "Pull requests", "Settings", "Auto-fixers"]);
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Move Settings" }));
  await act(async () => fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" }));
  expect(tabs()).toEqual(["Issues", "Pull requests", "Auto-fixers", "Settings"]);
  updateSettings.mockClear();
  await act(async () => fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" }));
  expect(updateSettings).not.toHaveBeenCalled();
});

it("moves a tab by dragging its handle", async () => {
  const { updateSettings } = render("settings");
  for (const [index, row] of screen.getAllByRole("listitem").entries())
    row.getBoundingClientRect = () => ({ top: index * 40, height: 40 }) as DOMRect;
  const handle = screen.getByRole("button", { name: "Move Issues" });
  fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientY: 20 });
  fireEvent.pointerMove(handle, { pointerId: 1, clientY: 110 });
  expect(screen.getAllByRole("listitem").map((row) => row.textContent)).toEqual([
    "Pull requests",
    "Auto-fixers",
    "Issues",
    "SettingsAlways shown",
  ]);
  expect(updateSettings).not.toHaveBeenCalled();
  await act(async () => fireEvent.pointerUp(handle, { pointerId: 1, clientY: 110 }));
  expect(updateSettings).toHaveBeenLastCalledWith({
    pluginId: "test-plugin",
    values: { tabOrder: "pulls,auto-fixers,issues,settings" },
  });
  expect(tabs()).toEqual(["Pull requests", "Auto-fixers", "Issues", "Settings"]);
});

it("drops a cancelled drag without saving", () => {
  const { updateSettings } = render("settings");
  for (const [index, row] of screen.getAllByRole("listitem").entries())
    row.getBoundingClientRect = () => ({ top: index * 40, height: 40 }) as DOMRect;
  const handle = screen.getByRole("button", { name: "Move Issues" });
  fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientY: 20 });
  fireEvent.pointerMove(handle, { pointerId: 1, clientY: 150 });
  fireEvent.pointerCancel(handle, { pointerId: 1 });
  expect(screen.getAllByRole("listitem")[0]!.textContent).toBe("Issues");
  expect(updateSettings).not.toHaveBeenCalled();
});

function rowLabels() {
  return screen.getAllByRole("listitem").map((row) => row.textContent);
}

function stubRowBoxes() {
  for (const [index, row] of screen.getAllByRole("listitem").entries())
    row.getBoundingClientRect = () => ({ top: index * 40, height: 40 }) as DOMRect;
}

it("does not start a drag from the row label", () => {
  const { updateSettings } = render("settings");
  stubRowBoxes();
  const label = screen.getByText("Issues", { selector: "li span" });
  fireEvent.pointerDown(label, { button: 0, pointerId: 1, clientY: 20 });
  fireEvent.pointerMove(label, { pointerId: 1, clientY: 150 });
  fireEvent.pointerUp(label, { pointerId: 1, clientY: 150 });
  expect(rowLabels()[0]).toBe("Issues");
  expect(updateSettings).not.toHaveBeenCalled();
});

it("puts the row back when Escape is pressed during a drag", () => {
  const { updateSettings } = render("settings");
  stubRowBoxes();
  const handle = screen.getByRole("button", { name: "Move Issues" });
  fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientY: 20 });
  fireEvent.pointerMove(handle, { pointerId: 1, clientY: 150 });
  expect(rowLabels()[0]).toBe("Pull requests");
  fireEvent.keyDown(window, { key: "Escape" });
  expect(rowLabels()[0]).toBe("Issues");
  fireEvent.pointerUp(document.body, { pointerId: 1, clientY: 150 });
  expect(updateSettings).not.toHaveBeenCalled();
});

it("drops the row when the pointer is released outside the list", async () => {
  const { updateSettings } = render("settings");
  stubRowBoxes();
  const handle = screen.getByRole("button", { name: "Move Issues" });
  fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientY: 20 });
  fireEvent.pointerMove(document.body, { pointerId: 1, clientY: 500 });
  await act(async () => fireEvent.pointerUp(document.body, { pointerId: 1, clientY: 500 }));
  expect(updateSettings).toHaveBeenLastCalledWith({
    pluginId: "test-plugin",
    values: { tabOrder: "pulls,auto-fixers,settings,issues" },
  });
  updateSettings.mockClear();
  fireEvent.pointerMove(document.body, { pointerId: 1, clientY: 0 });
  fireEvent.pointerUp(document.body, { pointerId: 1, clientY: 0 });
  expect(rowLabels()[3]).toBe("Issues");
  expect(updateSettings).not.toHaveBeenCalled();
});

it("keeps the dropped order while saving and restores it when the save fails", async () => {
  const { updateSettings } = render("settings");
  let fail!: (error: Error) => void;
  updateSettings.mockImplementationOnce(() => new Promise((_, reject) => (fail = reject)));
  stubRowBoxes();
  const handle = screen.getByRole("button", { name: "Move Issues" });
  fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientY: 20 });
  fireEvent.pointerMove(handle, { pointerId: 1, clientY: 110 });
  fireEvent.pointerUp(handle, { pointerId: 1, clientY: 110 });
  expect(rowLabels()[2]).toBe("Issues");
  await act(async () => fail(new Error("Settings are read-only")));
  expect(rowLabels()[0]).toBe("Issues");
});

it("shows the plugin's switch and select settings from their definitions", async () => {
  const { updateSettings } = render("settings", { compact: true } as never);
  const placement = await screen.findByRole("combobox", { name: "Auto-fixer threads appear in" });
  expect(placement.textContent).toBe("Gitea tab");
  expect(screen.getByText("Where new auto-fixer threads appear.")).toBeTruthy();
  expect(screen.queryByText("Gitea instance URL")).toBeNull();
  expect(screen.queryByText("Tab order")).toBeNull();
  const compact = screen.getByRole("switch", { name: "Compact rows" }) as HTMLInputElement;
  expect(compact.checked).toBe(true);
  await act(async () => fireEvent.click(compact));
  expect(updateSettings).toHaveBeenLastCalledWith({ pluginId: "test-plugin", values: { compact: false } });
  fireEvent.click(placement);
  await act(async () => fireEvent.click(screen.getByRole("option", { name: "Project sidebar" })));
  expect(updateSettings).toHaveBeenLastCalledWith({
    pluginId: "test-plugin",
    values: { autoFixerPlacement: "Project sidebar" },
  });
  expect(placement.textContent).toBe("Project sidebar");
});

it("shows the hint for the selected option and keeps the description on hover", async () => {
  const placement = {
    type: "select" as const,
    label: "Show auto-fixer threads in",
    description: "Applies to new auto-fixer threads.",
    options: ["Gitea tab only", "Project sidebar"],
    default: "Gitea tab only",
  };
  render("settings", {}, { autoFixerPlacement: placement });
  const select = await screen.findByRole("combobox", { name: "Show auto-fixer threads in" });
  const hint = screen.getByText("New auto-fixers show only in the Auto-fixers tab.");
  expect(hint.getAttribute("title")).toBe("Applies to new auto-fixer threads.");
  expect(screen.queryByText("Applies to new auto-fixer threads.")).toBeNull();
  fireEvent.click(select);
  await act(async () => fireEvent.click(screen.getByRole("option", { name: "Project sidebar" })));
  expect(screen.getByText("New auto-fixers show under the pull request's project.")).toBeTruthy();
});

it("leaves out the Panel section when the plugin has no switch or select settings", async () => {
  const { slot } = render("settings", {}, { baseUrl: schema.baseUrl, tabOrder: schema.tabOrder });
  await vi.waitFor(() => expect(slot.sdkCalls.map((call) => call.method)).toContain("plugins.getSettings"));
  await act(async () => {});
  expect(screen.getByText("Tabs")).toBeTruthy();
  expect(screen.queryByText("Panel")).toBeNull();
});
