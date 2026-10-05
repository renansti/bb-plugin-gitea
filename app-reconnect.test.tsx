// @vitest-environment jsdom

import { act, cleanup, screen, waitFor } from "@testing-library/react";
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
const ops = '["https://gitea.example/","ops","ops"]';
const fetchedAt = "2026-09-28T12:00:00.000Z";
const settings = {
  baseUrl: "https://gitea.example/",
  teaProfile: "work",
  extraRepos: "",
};

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

function mine(titles: string[], account = work) {
  return {
    items: titles.map((title, index) => pull(index + 1, title)),
    truncated: false,
    errors: [],
    account,
    freshness: { state: "fresh", fetchedAt },
    login: "dev",
    preferences,
  };
}

function status(account = work) {
  return { state: "connected", login: "dev", account, repos: [] };
}

const lostAccess = {
  state: "unavailable",
  error: "Gitea rejected the token",
  repos: [],
};

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

function held() {
  let release!: () => void;
  const opened = new Promise<void>((resolve) => (release = resolve));
  return { opened, release: () => act(async () => release()) };
}

async function watchScope() {
  const scope = renderSlot(overlay, {}, { settings });
  await scope.emitRealtime("display-changed", { item: null });
  return scope;
}

async function reconnect(slot: ReturnType<typeof renderSlot>) {
  await slot.setRealtimeConnectionState("reconnecting");
  await slot.setRealtimeConnectionState("connected");
}

const skeleton = () => screen.queryByTestId("bb-list-loading");
const freshness = () =>
  screen.getByTestId("bb-freshness").getAttribute("data-state");

function calls(slot: ReturnType<typeof renderSlot>, method: string) {
  return slot.rpcCalls.filter((call) => call.method === method).length;
}

// Reads after a reconnect wait for `gate`, then return `after()`.
function listPanel(
  gate: { opened: Promise<void> },
  after: {
    status: () => unknown;
    list: () => unknown;
  },
) {
  let reconnected = false;
  const slot = renderSlot(
    panel,
    { subPath: "" },
    {
      settings,
      rpc: {
        status: async () => {
          if (!reconnected) return status();
          await gate.opened;
          return after.status();
        },
        getAutoFixerPreferences: () => preferences,
        listMyPullRequests: async () => {
          if (!reconnected) return mine(["Remembered row"]);
          await gate.opened;
          return after.list();
        },
      },
    },
  );
  return {
    slot,
    reconnect: async () => {
      reconnected = true;
      await reconnect(slot);
    },
  };
}

it("keeps remembered rows visible while a reconnect reloads them", async () => {
  await watchScope();
  const gate = held();
  const { slot, reconnect } = listPanel(gate, {
    status: () => status(),
    list: () => mine(["Refreshed row"]),
  });
  expect(await screen.findByText("Remembered row")).toBeTruthy();
  const before = calls(slot, "listMyPullRequests");

  await reconnect();
  await waitFor(() =>
    expect(calls(slot, "listMyPullRequests")).toBeGreaterThan(before),
  );
  expect(screen.getByText("Remembered row")).toBeTruthy();
  expect(skeleton()).toBeNull();
  expect(freshness()).toBe("refreshing");

  await gate.release();
  expect(await screen.findByText("Refreshed row")).toBeTruthy();
  expect(screen.queryByText("Remembered row")).toBeNull();
});

it("clears remembered rows when a reconnect shows another account", async () => {
  await watchScope();
  const gate = held();
  const { reconnect } = listPanel(gate, {
    status: () => status(ops),
    list: () => mine(["Ops row"], ops),
  });
  expect(await screen.findByText("Remembered row")).toBeTruthy();

  await reconnect();
  expect(screen.getByText("Remembered row")).toBeTruthy();
  await gate.release();
  expect(await screen.findByText("Ops row")).toBeTruthy();
  expect(screen.queryByText("Remembered row")).toBeNull();
});

it("clears remembered rows when a reconnect shows lost access", async () => {
  await watchScope();
  const gate = held();
  const { reconnect } = listPanel(gate, {
    status: () => lostAccess,
    list: () => Promise.reject(new Error(lostAccess.error)),
  });
  expect(await screen.findByText("Remembered row")).toBeTruthy();

  await reconnect();
  expect(screen.getByText("Remembered row")).toBeTruthy();
  await gate.release();
  await waitFor(() =>
    expect(screen.queryByText("Remembered row")).toBeNull(),
  );
  expect(screen.getAllByText(lostAccess.error).length).toBeGreaterThan(0);
});

function itemPanel(
  gate: { opened: Promise<void> },
  after: { status: () => unknown; title: string },
) {
  let reconnected = false;
  const slot = renderSlot(
    panel,
    { subPath: "pulls/acme/widgets/10" },
    {
      settings,
      rpc: {
        status: async () => {
          if (!reconnected) return status();
          await gate.opened;
          return after.status();
        },
        getAutoFixerPreferences: () => preferences,
        conversation: async () => {
          if (!reconnected) return conversation("Remembered detail");
          await gate.opened;
          return conversation(after.title);
        },
      },
    },
  );
  return {
    slot,
    reconnect: async () => {
      reconnected = true;
      await reconnect(slot);
    },
  };
}

it("keeps the open conversation visible while a reconnect reloads it", async () => {
  await watchScope();
  const gate = held();
  const { slot, reconnect } = itemPanel(gate, {
    status: () => status(),
    title: "Refreshed detail",
  });
  expect(await screen.findByText("Remembered detail")).toBeTruthy();
  const before = calls(slot, "conversation");

  await reconnect();
  await waitFor(() =>
    expect(calls(slot, "conversation")).toBeGreaterThan(before),
  );
  expect(screen.getByText("Remembered detail")).toBeTruthy();

  await gate.release();
  expect(await screen.findByText("Refreshed detail")).toBeTruthy();
  expect(screen.queryByText("Remembered detail")).toBeNull();
});

it("clears the open conversation when a reconnect shows another account", async () => {
  await watchScope();
  const gate = held();
  const reread = held();
  let reads = 0;
  let reconnected = false;
  const slot = renderSlot(
    panel,
    { subPath: "pulls/acme/widgets/10" },
    {
      settings,
      rpc: {
        status: async () => {
          if (!reconnected) return status();
          await gate.opened;
          return status(ops);
        },
        getAutoFixerPreferences: () => preferences,
        conversation: async () => {
          reads += 1;
          if (!reconnected) return conversation("Work detail");
          if (reads === 2) return new Promise<never>(() => {});
          await reread.opened;
          return conversation("Ops detail");
        },
      },
    },
  );
  expect(await screen.findByText("Work detail")).toBeTruthy();

  reconnected = true;
  await reconnect(slot);
  expect(screen.getByText("Work detail")).toBeTruthy();
  await gate.release();
  await waitFor(() => expect(screen.queryByText("Work detail")).toBeNull());
  await reread.release();
  expect(await screen.findByText("Ops detail")).toBeTruthy();
});

it("still clears the open conversation on a full display change", async () => {
  const scope = await watchScope();
  const reread = held();
  let reads = 0;
  renderSlot(
    panel,
    { subPath: "pulls/acme/widgets/10" },
    {
      settings,
      rpc: {
        status: () => status(),
        getAutoFixerPreferences: () => preferences,
        conversation: async () => {
          reads += 1;
          if (reads === 1) return conversation("Old detail");
          await reread.opened;
          return conversation("New detail");
        },
      },
    },
  );
  expect(await screen.findByText("Old detail")).toBeTruthy();

  await scope.emitRealtime("display-changed", { item: null });
  await waitFor(() => expect(reads).toBe(2));
  expect(screen.queryByText("Old detail")).toBeNull();
  await reread.release();
  expect(await screen.findByText("New detail")).toBeTruthy();
});
