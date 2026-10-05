// @vitest-environment jsdom

import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

afterEach(() => cleanup());

const app = await loadPluginApp(() => import("./app"));
const account = '["https://gitea.example/","work","dev"]';
const freshness = { state: "fresh" as const, fetchedAt: "2026-09-29T12:00:00Z" };
const item = {
  repo: "acme/widgets",
  number: 42,
  kind: "pr" as const,
  title: "All PR controls",
  state: "open",
  author: "someone",
  labels: [],
  assignees: [],
  url: "https://gitea.example/acme/widgets/pulls/42",
  body: "",
  updatedAt: "2026-09-29T12:00:00Z",
  autoFixer: {
    status: "idle" as const,
    actions: ["start" as const],
    automation: { fix: false, merge: false },
  },
};
const list = {
  items: [item],
  truncated: false,
  errors: [],
  account,
  freshness,
};

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

function choose(filter: string, option: string) {
  fireEvent.click(screen.getByRole("combobox", { name: filter }));
  fireEvent.click(screen.getByRole("option", { name: option }));
}

it.each([false, true])("opens on Issues assigned to you and keeps the badge on that count (truncated: %s)", async (truncated) => {
  const scrollIntoView = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = vi.fn();
  const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {
    rpc: {
      status: () => ({ state: "connected", login: "dev", account, repos: [] }),
      getAutoFixerPreferences: () => preferences,
      listMyPullRequests: () => ({ ...list, items: [], login: "dev" }),
      listMyIssues: () => ({
        ...list,
        truncated,
        items: [{ ...item, number: 7, kind: "issue", title: "Assigned issue", assignees: ["dev"] }],
        login: "dev",
      }),
      listItems: () => ({
        ...list,
        items: [{ ...item, number: 8, kind: "issue", title: "Someone else's issue", assignees: ["other"] }],
      }),
    },
  });
  const badge = `Issues 1${truncated ? "+" : ""}`;
  expect((await screen.findByRole("tab", { name: badge })).getAttribute("aria-selected")).toBe("true");
  expect(screen.queryByRole("tab", { name: /My/ })).toBeNull();
  expect(await screen.findByText("Assigned issue")).toBeTruthy();
  expect(screen.getByRole("combobox", { name: "Assignee" }).textContent).toBe("Assignee: dev");
  choose("Assignee", "Assignee: All");
  expect(await screen.findByText("Someone else's issue")).toBeTruthy();
  expect(slot.rpcCalls.find((call) => call.method === "listItems")?.input).toMatchObject({ kind: "issue" });
  expect(screen.getByRole("tab", { name: badge })).toBeTruthy();
  choose("Assignee", "Assignee: dev");
  expect(await screen.findByText("Assigned issue")).toBeTruthy();
  Element.prototype.scrollIntoView = scrollIntoView;
});

it("lists tabs in the order Issues, Pull requests, Auto-fixers", () => {
  renderSlot(app.navPanels[0]!, { subPath: "" }, {
    rpc: {
      status: () => ({ state: "connected", login: "dev", account, repos: [] }),
      getAutoFixerPreferences: () => preferences,
      listMyPullRequests: () => ({ ...list, items: [], login: "dev" }),
      listMyIssues: () => ({ ...list, items: [], login: "dev" }),
    },
  });
  expect(screen.getAllByRole("tab").map((tab) => tab.textContent))
    .toEqual(["Issues", "Pull requests", "Auto-fixers"]);
});

it("shows Auto-fix and Auto-merge controls for a Pull requests row and turns off the bulk controls for All", async () => {
  const scrollIntoView = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = vi.fn();
  const slot = renderSlot(app.navPanels[0]!, { subPath: "pulls" }, {
    rpc: {
      status: () => ({ state: "connected", login: "dev", account, repos: [] }),
      getAutoFixerPreferences: () => preferences,
      listMyIssues: () => ({ ...list, items: [], login: "dev" }),
      listMyPullRequests: () => ({ ...list, items: [], login: "dev" }),
      listItems: () => list,
    },
  });
  const autoFixAll = await screen.findByRole("checkbox", { name: "Auto-fix all" });
  expect(autoFixAll.hasAttribute("disabled")).toBe(false);
  expect(await screen.findByText("No pull requests authored by you in tracked repositories.")).toBeTruthy();
  choose("Author", "Author: All");
  expect(await screen.findByText(item.title)).toBeTruthy();
  expect(slot.rpcCalls.find((call) => call.method === "listItems")?.input).toMatchObject({ kind: "pr" });
  expect(screen.getByRole("checkbox", { name: "Auto-fix all" }).hasAttribute("disabled")).toBe(true);
  expect(screen.getByRole("checkbox", { name: "Auto-merge all" }).hasAttribute("disabled")).toBe(true);
  const controls = screen.getByTestId("auto-fixer-controls");
  expect(controls.querySelectorAll("button")).toHaveLength(2);
  expect(controls.textContent).toContain("Auto-fix");
  expect(controls.textContent).toContain("Auto-merge");
  choose("Author", "Author: dev");
  expect(await screen.findByText("No pull requests authored by you in tracked repositories.")).toBeTruthy();
  expect(screen.getByRole("checkbox", { name: "Auto-fix all" }).hasAttribute("disabled")).toBe(false);
  Element.prototype.scrollIntoView = scrollIntoView;
});

it("disables metadata suggestions while the save is pending", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const slot = renderSlot(app.navPanels[0]!, { subPath: "pulls/acme/widgets/42" }, {
    rpc: {
      status: () => ({ state: "connected", login: "dev", account, repos: [] }),
      getAutoFixerPreferences: () => ({ autoFix: false, autoMerge: false, execution: { providerId: "codex", model: "gpt-5.6-luna", reasoningLevel: "medium", serviceTier: "default" } }),
      listMyPullRequests: () => ({ ...list, items: [] }),
      listMyIssues: () => ({ ...list, items: [] }),
      conversation: () => ({
        freshness, threadId: null,
        conversation: {
          ...item, comments: [], commentsTruncated: false, headRefName: "feature",
          baseRefName: "main", revision: { head: "a".repeat(40), base: "b".repeat(40) },
          changedFiles: 1, draft: true, checks: { state: "unavailable" }, reviews: [], reviewsTruncated: false,
          reviewComments: [],
        },
      }),
      repoOptions: () => ({ labels: [{ name: "bug", color: "" }, { name: "help wanted", color: "" }], assignees: [] }),
      updateMetadata: async () => { await held; return { ok: true }; },
    },
  });
  expect(await screen.findByRole("button", { name: "Mark ready" })).toBeTruthy();
  expect(await screen.findByText("Checks unavailable.")).toBeTruthy();
  const input = await screen.findByLabelText("Add labels");
  fireEvent.change(input, { target: { value: "bug" } });
  fireEvent.mouseDown(await screen.findByRole("option", { name: "bug" }));
  expect(screen.queryByRole("listbox", { name: "Labels" })).toBeNull();
  expect(slot.rpcCalls.filter(call => call.method === "updateMetadata")).toHaveLength(1);
  await act(async () => release());
});

it("hides archived auto-fixers until history is requested", async () => {
  renderSlot(app.navPanels[0]!, { subPath: "" }, {
    rpc: {
      status: () => ({ state: "connected", login: "dev", account, repos: [] }),
      getAutoFixerPreferences: () => ({ autoFix: false, autoMerge: false, execution: { providerId: "codex", model: "gpt-5.6-luna", reasoningLevel: "medium", serviceTier: "default" } }),
      listMyPullRequests: () => ({ ...list, items: [], login: "dev" }),
      listAutoFixerSessions: () => ({ sessions: [{ ...item.autoFixer, ...item, status: "archived", outcome: "merged", threadId: "archived-thread", archivedAt: item.updatedAt, policy: { fix: true, merge: false }, actions: [], automation: { fix: false, merge: false } }] }),
    },
  });
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Auto-fixers" }), { button: 0 });
  const toggle = await screen.findByRole("checkbox", { name: "Show archived" });
  expect(screen.queryByTestId("auto-fixer-session")).toBeNull();
  fireEvent.click(toggle);
  expect(screen.getByTestId("auto-fixer-session").textContent).toContain("archived");
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
});
