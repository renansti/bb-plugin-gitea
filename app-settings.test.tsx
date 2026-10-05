// @vitest-environment jsdom

import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

afterEach(() => cleanup());

const app = await loadPluginApp(() => import("./app"));
const panel = app.navPanels[0]!;
const section = app.settingsSections[0]!;
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

function sdk() {
  const updateSettings = vi.fn(async ({ values }: { values: Record<string, unknown> }) => ({
    ok: true as const,
    schema: {},
    values,
  }));
  return { updateSettings, sdk: { plugins: { updateSettings } } };
}

function render(subPath: string, settings: Record<string, string> = {}, pluginId?: string) {
  const fakes = sdk();
  const slot = renderSlot(panel, { subPath }, { rpc, settings, sdk: fakes.sdk, pluginId });
  return { slot, updateSettings: fakes.updateSettings };
}

function renderSection(settings: Record<string, string> = {}) {
  const fakes = sdk();
  const slot = renderSlot(section, {}, { settings, sdk: fakes.sdk });
  return { slot, updateSettings: fakes.updateSettings };
}

function tabs() {
  return screen.getAllByRole("tab").map((tab) => tab.textContent!.replace(/\d+$/, ""));
}

function selected() {
  return screen.getAllByRole("tab").find((tab) => tab.getAttribute("aria-selected") === "true")?.textContent;
}

function rowLabels() {
  return screen.getAllByRole("listitem").map((row) => row.textContent);
}

function stubRowBoxes() {
  for (const [index, row] of screen.getAllByRole("listitem").entries())
    row.getBoundingClientRect = () => ({ top: index * 40, height: 40 }) as DOMRect;
}

it("hides tabs turned off in settings", () => {
  render("", { hiddenTabs: "issues,auto-fixers" });
  expect(tabs()).toEqual(["Pull requests"]);
  expect(selected()).toBe("Pull requests");
});

it("shows the first tab when every tab is hidden", () => {
  render("", { tabOrder: "pulls,issues", hiddenTabs: "issues,pulls,auto-fixers" });
  expect(tabs()).toEqual(["Pull requests"]);
  expect(selected()).toBe("Pull requests");
});

it("opens on the first visible tab in the saved order", async () => {
  render("", { tabOrder: "auto-fixers,pulls,issues" });
  expect(tabs()).toEqual(["Auto-fixers", "Pull requests", "Issues"]);
  expect(selected()).toBe("Auto-fixers");
  expect(await screen.findByText(/No auto-fixers yet/)).toBeTruthy();
  cleanup();
  render("", { tabOrder: "auto-fixers", hiddenTabs: "auto-fixers" });
  expect(tabs()).toEqual(["Issues", "Pull requests"]);
  expect(selected()).toBe("Issues");
});

it("ignores the removed settings tab in saved values", () => {
  render("", { tabOrder: "settings,auto-fixers,pulls,issues", hiddenTabs: "settings,issues" });
  expect(tabs()).toEqual(["Auto-fixers", "Pull requests"]);
  cleanup();
  render("", { tabOrder: "pulls,settings", hiddenTabs: "settings" });
  expect(tabs()).toEqual(["Issues", "Pull requests", "Auto-fixers"]);
});

it("switches to the first visible tab when the open tab is hidden", () => {
  const { slot } = render("pulls", { tabOrder: "auto-fixers,issues", hiddenTabs: "pulls" });
  expect(selected()).toBe("Auto-fixers");
  expect(slot.navigateCalls).toContainEqual({
    method: "toPluginPanel",
    path: "gitea",
    options: { subPath: "auto-fixers", replace: true },
  });
});

it("opens BB's settings page for the plugin from the settings button", () => {
  render("", {}, "my/gitea");
  const pushState = vi.spyOn(window.history, "pushState");
  const popstate = vi.fn();
  window.addEventListener("popstate", popstate);
  try {
    fireEvent.click(screen.getByRole("button", { name: "Gitea settings" }));
    expect(pushState).toHaveBeenCalledWith(
      expect.objectContaining({ usr: null, idx: expect.any(Number) }),
      "",
      "/settings/plugins/my%2Fgitea",
    );
    expect(window.location.pathname).toBe("/settings/plugins/my%2Fgitea");
    expect(popstate).toHaveBeenCalledTimes(1);
  } finally {
    window.removeEventListener("popstate", popstate);
    pushState.mockRestore();
    window.history.replaceState(null, "", "/");
  }
});

it("adds a Panel tabs section to the plugin settings page", () => {
  expect(section).toMatchObject({ id: "tabs", title: "Panel tabs" });
  renderSection();
  expect(rowLabels()).toEqual(["Issues", "Pull requests", "Auto-fixers"]);
  expect(screen.queryByText("Settings")).toBeNull();
});

it("hides and shows a tab from the settings section", async () => {
  const { updateSettings } = renderSection({ hiddenTabs: "auto-fixers,settings" });
  expect((screen.getByRole("switch", { name: "Show Auto-fixers" }) as HTMLInputElement).checked).toBe(false);
  await act(async () => fireEvent.click(screen.getByRole("switch", { name: "Show Pull requests" })));
  expect(updateSettings).toHaveBeenLastCalledWith({
    pluginId: "test-plugin",
    values: { hiddenTabs: "auto-fixers,pulls" },
  });
  expect((screen.getByRole("switch", { name: "Show Pull requests" }) as HTMLInputElement).checked).toBe(false);
  await act(async () => fireEvent.click(screen.getByRole("switch", { name: "Show Auto-fixers" })));
  expect(updateSettings).toHaveBeenLastCalledWith({
    pluginId: "test-plugin",
    values: { hiddenTabs: "pulls" },
  });
});

it("keeps the last visible tab shown", () => {
  renderSection({ hiddenTabs: "issues,auto-fixers" });
  const pulls = screen.getByRole("switch", { name: "Show Pull requests" }) as HTMLInputElement;
  expect(pulls.checked).toBe(true);
  expect(pulls.disabled).toBe(true);
  expect((screen.getByRole("switch", { name: "Show Issues" }) as HTMLInputElement).disabled).toBe(false);
});

it("restores the switch when saving a hidden tab fails", async () => {
  const { updateSettings } = renderSection();
  updateSettings.mockRejectedValueOnce(new Error("Settings are read-only"));
  const issues = screen.getByRole("switch", { name: "Show Issues" }) as HTMLInputElement;
  await act(async () => fireEvent.click(issues));
  expect(issues.checked).toBe(true);
});

it("moves a tab with the arrow keys and keeps focus on its handle", async () => {
  const { updateSettings } = renderSection();
  const handle = screen.getByRole("button", { name: "Move Auto-fixers" });
  handle.focus();
  await act(async () => fireEvent.keyDown(handle, { key: "ArrowUp" }));
  expect(updateSettings).toHaveBeenLastCalledWith({
    pluginId: "test-plugin",
    values: { tabOrder: "issues,auto-fixers,pulls" },
  });
  expect(rowLabels()).toEqual(["Issues", "Auto-fixers", "Pull requests"]);
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Move Auto-fixers" }));
  await act(async () => fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" }));
  expect(rowLabels()).toEqual(["Issues", "Pull requests", "Auto-fixers"]);
  updateSettings.mockClear();
  await act(async () => fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" }));
  expect(updateSettings).not.toHaveBeenCalled();
});

it("moves a tab by dragging its handle", async () => {
  const { updateSettings } = renderSection({ tabOrder: "settings,issues" });
  stubRowBoxes();
  const handle = screen.getByRole("button", { name: "Move Issues" });
  fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientY: 20 });
  fireEvent.pointerMove(handle, { pointerId: 1, clientY: 70 });
  expect(rowLabels()).toEqual(["Pull requests", "Issues", "Auto-fixers"]);
  expect(updateSettings).not.toHaveBeenCalled();
  await act(async () => fireEvent.pointerUp(handle, { pointerId: 1, clientY: 70 }));
  expect(updateSettings).toHaveBeenLastCalledWith({
    pluginId: "test-plugin",
    values: { tabOrder: "pulls,issues,auto-fixers" },
  });
  expect(rowLabels()).toEqual(["Pull requests", "Issues", "Auto-fixers"]);
});

it("drops a cancelled drag without saving", () => {
  const { updateSettings } = renderSection();
  stubRowBoxes();
  const handle = screen.getByRole("button", { name: "Move Issues" });
  fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientY: 20 });
  fireEvent.pointerMove(handle, { pointerId: 1, clientY: 110 });
  fireEvent.pointerCancel(handle, { pointerId: 1 });
  expect(rowLabels()[0]).toBe("Issues");
  expect(updateSettings).not.toHaveBeenCalled();
});

it("does not start a drag from the row label", () => {
  const { updateSettings } = renderSection();
  stubRowBoxes();
  const label = screen.getByText("Issues", { selector: "li span" });
  fireEvent.pointerDown(label, { button: 0, pointerId: 1, clientY: 20 });
  fireEvent.pointerMove(label, { pointerId: 1, clientY: 110 });
  fireEvent.pointerUp(label, { pointerId: 1, clientY: 110 });
  expect(rowLabels()[0]).toBe("Issues");
  expect(updateSettings).not.toHaveBeenCalled();
});

it("puts the row back when Escape is pressed during a drag", () => {
  const { updateSettings } = renderSection();
  stubRowBoxes();
  const handle = screen.getByRole("button", { name: "Move Issues" });
  fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientY: 20 });
  fireEvent.pointerMove(handle, { pointerId: 1, clientY: 110 });
  expect(rowLabels()[0]).toBe("Pull requests");
  fireEvent.keyDown(window, { key: "Escape" });
  expect(rowLabels()[0]).toBe("Issues");
  fireEvent.pointerUp(document.body, { pointerId: 1, clientY: 110 });
  expect(updateSettings).not.toHaveBeenCalled();
});

it("drops the row when the pointer is released outside the list", async () => {
  const { updateSettings } = renderSection();
  stubRowBoxes();
  const handle = screen.getByRole("button", { name: "Move Issues" });
  fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientY: 20 });
  fireEvent.pointerMove(document.body, { pointerId: 1, clientY: 500 });
  await act(async () => fireEvent.pointerUp(document.body, { pointerId: 1, clientY: 500 }));
  expect(updateSettings).toHaveBeenLastCalledWith({
    pluginId: "test-plugin",
    values: { tabOrder: "pulls,auto-fixers,issues" },
  });
  updateSettings.mockClear();
  fireEvent.pointerMove(document.body, { pointerId: 1, clientY: 0 });
  fireEvent.pointerUp(document.body, { pointerId: 1, clientY: 0 });
  expect(rowLabels()[2]).toBe("Issues");
  expect(updateSettings).not.toHaveBeenCalled();
});

it("keeps the dropped order while saving and restores it when the save fails", async () => {
  const { updateSettings } = renderSection();
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
