// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      disconnect(): void {}
      observe(): void {}
      unobserve(): void {}
    },
  );
});

afterAll(() => vi.unstubAllGlobals());

afterEach(() => cleanup());

const app = await loadPluginApp(() => import("./app"));
const panel = app.navPanels[0]!;
const overlay = app.appOverlays[0]!;

const preferences = {
  autoFix: false,
  autoMerge: false,
  execution: {
    providerId: "codex",
    model: "gpt-5.6-luna",
    reasoningLevel: "xhigh",
    serviceTier: "default",
  },
} as const;
const work = '["https://gitea.example/","work","dev"]';
const fetchedAt = "2026-09-28T12:00:00.000Z";

type Freshness =
  | { state: "fresh" | "refreshing"; fetchedAt: string }
  | { state: "stale-error"; fetchedAt: string; error: string };

function pull(number: number, title: string) {
  return {
    repo: "acme/widgets",
    number,
    kind: "pr" as const,
    title,
    state: "open",
    author: "dev",
    labels: [],
    assignees: [],
    url: `https://gitea.example/acme/widgets/pulls/${number}`,
    body: "",
    updatedAt: "2026-09-28T12:00:00Z",
    autoFixer: {
      status: "idle" as const,
      actions: ["start" as const],
      automation: { fix: false, merge: false },
    },
  };
}

function mine(
  titles: string[],
  account = work,
  freshness: Freshness = { state: "fresh", fetchedAt },
) {
  return {
    items: titles.map((title, index) => pull(index + 1, title)),
    truncated: false,
    errors: [],
    account,
    freshness,
    login: "dev",
    preferences,
  };
}

function status(account = work) {
  return { ready: true, error: null, login: "dev", account, repos: [] };
}

const settings = {
  baseUrl: "https://gitea.example/",
  teaProfile: "work",
  extraRepos: "",
};

async function watchScope() {
  const scope = renderSlot(overlay, {}, { settings });
  await scope.emitRealtime("display-changed", { item: null });
  return scope;
}

async function showQuery(query: string, rows: string[]) {
  fireEvent.change(screen.getByPlaceholderText("Search title, body, repository"), { target: { value: query } });
  for (const row of rows) expect(await screen.findByText(row)).toBeTruthy();
}

function conversation(title: string) {
  return {
    freshness: { state: "fresh", fetchedAt },
    threadId: null,
    conversation: {
      ...pull(10, title),
      comments: [],
      commentsTruncated: false,
      headRefName: "feature",
      baseRefName: "main",
      revision: { head: "a".repeat(40), base: "b".repeat(40) },
      changedFiles: 1,
      checks: [],
      checksTruncated: false,
      reviewComments: [],
      reviewCommentsTruncated: false,
      reviews: [],
      reviewsTruncated: false,
    },
  };
}

const Panel = panel.component;

it.each(["pulls", "my-prs"])("returns to Pull requests after opening a PR from %s, including after a remount", async (listPath) => {
  await watchScope();
  const options = {
    settings,
    rpc: {
      status: () => status(),
      getAutoFixerPreferences: () => preferences,
      listMyPullRequests: () => mine(["History PR"]),
      conversation: () => conversation("History PR detail"),
    },
  };
  const slot = renderSlot(panel, { subPath: listPath }, options);
  await showQuery("", ["History PR"]);
  fireEvent.click(screen.getByText("History PR"));
  expect(slot.navigateCalls.at(-1)).toEqual({
    method: "toPluginPanel", path: "gitea",
    options: { subPath: "pulls/acme/widgets/1" },
  });
  slot.lifecycle.rerender(<Panel subPath="pulls/acme/widgets/1" />);
  expect(await screen.findByText("History PR detail")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "← Pull requests" }));
  expect(slot.navigateCalls.at(-1)).toEqual({
    method: "toPluginPanel", path: "gitea", options: { subPath: "pulls" },
  });
  // The host supplies the historical route for Back and Forward.
  slot.lifecycle.rerender(<Panel subPath={listPath} />);
  expect(await screen.findByText("History PR")).toBeTruthy();
  expect(screen.getByRole("tab", { name: /Pull requests/ }).getAttribute("aria-selected")).toBe("true");
  slot.lifecycle.rerender(<Panel subPath="pulls/acme/widgets/1" />);
  expect(await screen.findByText("History PR detail")).toBeTruthy();
  slot.lifecycle.unmount();
  renderSlot(panel, { subPath: listPath }, options);
  expect(await screen.findByText("History PR")).toBeTruthy();
  expect(screen.getByRole("tab", { name: /Pull requests/ }).getAttribute("aria-selected")).toBe("true");
});

it("records distinct list routes and restores tabs when those routes are replayed", async () => {
  await watchScope();
  const slot = renderSlot(panel, { subPath: "issues" }, {
    settings,
    rpc: {
      status: () => status(),
      getAutoFixerPreferences: () => preferences,
      listMyPullRequests: () => mine([]),
      listMyIssues: () => mine([]),
      listItems: () => mine([]),
      listAutoFixerSessions: () => ({ sessions: [] }),
    },
  });
  for (const [path, label] of [
    ["pulls", "Pull requests"], ["auto-fixers", "Auto-fixers"], ["issues", "Issues"],
  ]) {
    fireEvent.mouseDown(screen.getByRole("tab", { name: new RegExp(`^${label}`) }), { button: 0 });
    expect(slot.navigateCalls.at(-1)).toEqual({
      method: "toPluginPanel", path: "gitea", options: { subPath: path },
    });
    slot.lifecycle.rerender(<Panel subPath={path!} />);
  }
  for (const [path, label] of [["pulls", "Pull requests"], ["issues", "Issues"], ["auto-fixers", "Auto-fixers"]]) {
    slot.lifecycle.rerender(<Panel subPath={path!} />);
    expect(screen.getByRole("tab", { name: new RegExp(`^${label}`) }).getAttribute("aria-selected")).toBe("true");
  }
});

function connected() {
  return { state: "connected", login: "dev", account: work, repos: [{ repo: "acme/widgets", projectId: null }] };
}

it.each([
  ["my-issues", "issues", "Issues", "Assignee"],
  ["my-prs", "pulls", "Pull requests", "Author"],
])("redirects %s to %s with the filter set to you", async (oldPath, path, label, filter) => {
  const scrollIntoView = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = vi.fn();
  await watchScope();
  const slot = renderSlot(panel, { subPath: path }, {
    settings,
    rpc: {
      status: () => connected(),
      getAutoFixerPreferences: () => preferences,
      listMyPullRequests: () => mine([]),
      listMyIssues: () => mine([]),
      listItems: () => mine([]),
    },
  });
  expect(await screen.findByText(`${filter}: dev`)).toBeTruthy();
  fireEvent.click(screen.getByRole("combobox", { name: filter }));
  fireEvent.click(screen.getByRole("option", { name: `${filter}: All` }));
  slot.lifecycle.rerender(<Panel subPath={oldPath} />);
  expect(slot.navigateCalls.at(-1)).toEqual({
    method: "toPluginPanel", path: "gitea", options: { subPath: path, replace: true },
  });
  expect(screen.getByRole("tab", { name: new RegExp(`^${label}`) }).getAttribute("aria-selected")).toBe("true");
  expect(screen.getByRole("combobox", { name: filter }).textContent).toBe(`${filter}: dev`);
  Element.prototype.scrollIntoView = scrollIntoView;
});

it.each([
  ["my-issues/new", "All", true],
  ["new", "dev", true],
  ["new", "All", false],
])("assigns a new issue from %s to you only when Assignee was set to you (Assignee: %s)", async (path, assignee, assignToMe) => {
  const scrollIntoView = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = vi.fn();
  await watchScope();
  const rpc = {
    status: () => connected(),
    getAutoFixerPreferences: () => preferences,
    listMyPullRequests: () => mine([]),
    listMyIssues: () => mine([]),
    listItems: () => mine([]),
    createIssue: () => ({ repo: "acme/widgets", number: 1, kind: "issue" }),
  };
  const slot = renderSlot(panel, { subPath: "issues" }, { settings, rpc });
  await waitFor(() => expect(screen.getByRole("combobox", { name: "Assignee" }).textContent).not.toBe("Assignee: me"));
  fireEvent.click(screen.getByRole("combobox", { name: "Assignee" }));
  fireEvent.click(await screen.findByRole("option", { name: `Assignee: ${assignee}` }));
  slot.lifecycle.rerender(<Panel subPath={path} />);
  if (path !== "new")
    expect(slot.navigateCalls.at(-1)).toEqual({
      method: "toPluginPanel", path: "gitea", options: { subPath: "new", replace: true },
    });
  fireEvent.click(await screen.findByRole("combobox", { name: "Repository" }));
  fireEvent.click(await screen.findByRole("option", { name: "acme/widgets" }));
  fireEvent.change(screen.getByLabelText("Issue title"), { target: { value: "Assigned?" } });
  fireEvent.click(screen.getByRole("button", { name: "Create issue" }));
  expect(slot.rpcCalls.find((call) => call.method === "createIssue")?.input)
    .toMatchObject({ assignToMe });
  Element.prototype.scrollIntoView = scrollIntoView;
});
