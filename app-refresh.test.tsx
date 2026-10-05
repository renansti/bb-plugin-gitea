// @vitest-environment jsdom

import { act, cleanup, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
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

// Only intervals are fake, so Testing Library waits still use real timeouts.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
});

afterEach(() => {
  cleanup();
  setHidden(false);
  vi.useRealTimers();
});

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
const settings = {
  baseUrl: "https://gitea.example/",
  teaProfile: "work",
  extraRepos: "",
};
const interval = 45_000;

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

function mine(titles: string[]) {
  return {
    items: titles.map((title, index) => pull(index + 1, title)),
    truncated: false,
    errors: [],
    account: work,
    freshness: { state: "fresh", fetchedAt },
    login: "dev",
    preferences,
  };
}

function status() {
  return { state: "connected", login: "dev", account: work, repos: [] };
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
      draft: false,
      checks: { state: "loaded", values: [], truncated: false },
      reviews: [],
      reviewsTruncated: false,
      reviewComments: [],
    },
  };
}

function setHidden(hidden: boolean) {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => (hidden ? "hidden" : "visible"),
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

async function watchScope(values: Record<string, string | number> = settings) {
  const scope = renderSlot(overlay, {}, { settings: values });
  await scope.emitRealtime("display-changed", { item: null });
  return scope;
}

function calls(slot: ReturnType<typeof renderSlot>, method: string) {
  return slot.rpcCalls.filter((call) => call.method === method);
}

const advance = (ms: number) => act(async () => vi.advanceTimersByTime(ms));

async function listPanel(extra: Record<string, number> = {}) {
  const values = { ...settings, ...extra };
  await watchScope(values);
  const slot = renderSlot(
    panel,
    { subPath: "my-prs" },
    {
      settings: values,
      rpc: {
        status: () => status(),
        getAutoFixerPreferences: () => preferences,
        listMyPullRequests: () => mine(["Pull row"]),
        listMyIssues: () => ({ ...mine([]), preferences: undefined }),
      },
    },
  );
  expect(await screen.findByText("Pull row")).toBeTruthy();
  await waitFor(() => expect(calls(slot, "listMyIssues")).toHaveLength(1));
  return slot;
}

it("reloads a visible list from the cache after the interval", async () => {
  const slot = await listPanel();
  const pulls = calls(slot, "listMyPullRequests").length;

  await advance(interval - 1);
  expect(calls(slot, "listMyPullRequests")).toHaveLength(pulls);

  await advance(1);
  await waitFor(() =>
    expect(calls(slot, "listMyPullRequests").length).toBeGreaterThan(pulls),
  );
  expect(calls(slot, "listMyIssues")).toHaveLength(2);
  for (const call of slot.rpcCalls.filter((call) => call.method.startsWith("list")))
    expect(call.input).toMatchObject({ refresh: false });
});

it("waits while the tab is hidden and loads once when it is visible again", async () => {
  const slot = await listPanel();
  const pulls = calls(slot, "listMyPullRequests").length;

  setHidden(true);
  await advance(interval * 3);
  expect(calls(slot, "listMyPullRequests")).toHaveLength(pulls);
  expect(calls(slot, "listMyIssues")).toHaveLength(1);

  await act(async () => setHidden(false));
  await waitFor(() => expect(calls(slot, "listMyIssues")).toHaveLength(2));
  await act(async () => setHidden(false));
  expect(calls(slot, "listMyIssues")).toHaveLength(2);
});

it("does not load when the tab becomes visible before a load was due", async () => {
  const slot = await listPanel();

  setHidden(true);
  await advance(interval - 1);
  await act(async () => setHidden(false));
  expect(calls(slot, "listMyIssues")).toHaveLength(1);
});

it("stops the timer when the view unmounts", async () => {
  const slot = await listPanel();
  const before = slot.rpcCalls.length;

  slot.unmount();
  await advance(interval * 3);
  expect(slot.rpcCalls).toHaveLength(before);
});

it("does not reload when the interval setting is 0", async () => {
  const slot = await listPanel({ refreshSeconds: 0 });
  const before = slot.rpcCalls.length;

  await advance(interval * 3);
  expect(slot.rpcCalls).toHaveLength(before);
});

it.each(["auto-fixers"])("does not reload lists on the %s tab", async (subPath) => {
  await watchScope();
  const slot = renderSlot(
    panel,
    { subPath },
    {
      settings,
      rpc: {
        status: () => status(),
        getAutoFixerPreferences: () => preferences,
        listAutoFixerSessions: () => ({ sessions: [] }),
        listMyPullRequests: () => mine([]),
        listMyIssues: () => ({ ...mine([]), preferences: undefined }),
      },
      sdk: {
        plugins: {
          getSettings: async () => ({ ok: true as const, schema: {}, values: {} }),
        },
      },
    },
  );
  await waitFor(() => expect(calls(slot, "listMyIssues")).toHaveLength(1));
  const lists = () =>
    slot.rpcCalls.filter((call) => call.method.startsWith("list") && call.method !== "listAutoFixerSessions");
  const before = lists().length;

  await advance(interval * 3);
  expect(lists()).toHaveLength(before);
});

it("reloads a visible conversation from the cache after the interval", async () => {
  await watchScope();
  let reads = 0;
  const slot = renderSlot(
    panel,
    { subPath: "pulls/acme/widgets/10" },
    {
      settings,
      rpc: {
        status: () => status(),
        getAutoFixerPreferences: () => preferences,
        conversation: () => {
          reads += 1;
          return conversation(reads === 1 ? "First detail" : "Newer detail");
        },
      },
    },
  );
  expect(await screen.findByText("First detail")).toBeTruthy();
  const lists = slot.rpcCalls.filter((call) => call.method.startsWith("list")).length;

  await advance(interval);
  expect(await screen.findByText("Newer detail")).toBeTruthy();
  expect(calls(slot, "conversation").at(-1)?.input).toMatchObject({
    refresh: false,
  });
  expect(slot.rpcCalls.filter((call) => call.method.startsWith("list"))).toHaveLength(lists);
});
