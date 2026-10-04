// @vitest-environment jsdom

import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

afterEach(() => cleanup());

const app = await loadPluginApp(() => import("./app"));
const registration = app.environmentProviderInputs.find(
  (entry) => entry.environmentProviderId === "gitea-branch",
)!;

const rpc = {
  remoteBranches: () => ({
    repo: "acme/widgets",
    truncated: false,
    error: null,
    branches: [
      {
        name: "review",
        group: "pull",
        pull: { number: 7, url: "https://gitea.example/acme/widgets/pulls/7" },
        updatedAt: "2026-09-02T00:00:00Z",
      },
      { name: "mine", group: "mine", pull: null, updatedAt: "2026-09-05T00:00:00Z" },
    ],
  }),
  branchDefaultBase: () => ({ branch: "main" }),
  branchWorktrees: () => ({
    worktrees: [{ path: "/src/widgets-wt", branch: "old", locked: false, prunable: false }],
  }),
};

function render(value: unknown) {
  const onChange = vi.fn();
  renderSlot(
    registration,
    {
      projectId: "project-1",
      target: { kind: "existing-host", hostId: "host-1" },
      value: value as never,
      onChange,
    },
    { rpc, branchesState: { branches: ["develop"], remoteBranches: [], isLoading: false } },
  );
  return onChange;
}

async function open(label: string) {
  await act(async () => {
    fireEvent.click(await screen.findByRole("combobox", { name: "Gitea branch" }));
  });
  await screen.findByText(label);
}

it("lists Work in, then Remote branch, then Local branch, and picks a remote branch", async () => {
  const onChange = render({ kind: "new", from: { kind: "default" } });
  expect(await screen.findByText("main")).toBeTruthy();
  await open("review");
  const menu = within(screen.getByRole("dialog"));
  const headers = ["Work in:", "Remote branch:", "Local branch:"].map((label) =>
    menu.getByText(label),
  );
  for (let index = 1; index < headers.length; index += 1)
    expect(
      headers[index - 1]!.compareDocumentPosition(headers[index]!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  expect(screen.getByText("#7")).toBeTruthy();
  expect(screen.getByText("develop")).toBeTruthy();
  const rows = screen.getAllByRole("button").map((row) => row.textContent);
  expect(rows.indexOf("review#7")).toBeLessThan(rows.indexOf("mine"));

  await act(async () => fireEvent.click(screen.getByText("review")));
  expect(onChange).toHaveBeenLastCalledWith({
    status: "ready",
    value: { kind: "remote", name: "review" },
  });
});

it("starts a new branch from a local branch", async () => {
  const onChange = render({ kind: "new", from: { kind: "default" } });
  await open("develop");
  await act(async () => fireEvent.click(screen.getByText("develop")));
  expect(onChange).toHaveBeenLastCalledWith({
    status: "ready",
    value: { kind: "new", from: { kind: "named", name: "develop" } },
  });
});

it("switches a picked existing worktree to a remote branch", async () => {
  const onChange = render({ kind: "existing", path: "/src/widgets-wt" });
  await open("Keep current branch");
  expect(within(screen.getByRole("dialog")).queryByText("Local branch:")).toBeNull();
  await screen.findByText("review");
  await act(async () => fireEvent.click(screen.getByText("review")));
  expect(onChange).toHaveBeenLastCalledWith({
    status: "ready",
    value: { kind: "existing", path: "/src/widgets-wt", remoteBranch: "review" },
  });
});

it("fills in the default inputs when there is no value", () => {
  const onChange = render(null);
  expect(onChange).toHaveBeenCalledWith({
    status: "ready",
    value: { kind: "new", from: { kind: "default" } },
  });
});
