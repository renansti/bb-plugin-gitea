import { expect, it } from "vitest";
import { orderRemoteBranches } from "./branch-order";

function branch(name: string, updatedAt: string, ...authors: string[]) {
  return { name, authors, updatedAt };
}

function pull(number: number, headBranch: string, author: string, updatedAt: string) {
  return { number, url: `https://gitea.example/acme/widgets/pulls/${number}`, author, headBranch, updatedAt };
}

it("lists my pull request branches, then my branches, then the rest, newest first in each group", () => {
  const ordered = orderRemoteBranches({
    login: "Dev",
    branches: [
      branch("main", "2026-09-10T00:00:00Z", "ops"),
      branch("old-pr", "2026-09-20T00:00:00Z", "dev"),
      branch("new-pr", "2026-09-01T00:00:00Z", "dev"),
      branch("my-old", "2026-08-01T00:00:00Z", "dev"),
      branch("my-new", "2026-09-05T00:00:00Z", "ops", "DEV"),
      branch("their-pr", "2026-09-30T00:00:00Z", "ops"),
      branch("stale", "2026-01-01T00:00:00Z"),
    ],
    pulls: [
      pull(1, "old-pr", "dev", "2026-09-02T00:00:00Z"),
      pull(2, "new-pr", "dev", "2026-09-25T00:00:00Z"),
      pull(3, "their-pr", "ops", "2026-09-30T00:00:00Z"),
    ],
  });
  expect(ordered.map((entry) => [entry.name, entry.group])).toEqual([
    ["new-pr", "pull"],
    ["old-pr", "pull"],
    ["my-new", "mine"],
    ["my-old", "mine"],
    ["their-pr", "other"],
    ["main", "other"],
    ["stale", "other"],
  ]);
  expect(ordered[0]?.pull).toEqual({
    number: 2,
    url: "https://gitea.example/acme/widgets/pulls/2",
  });
  expect(ordered.find((entry) => entry.name === "their-pr")?.pull).toBeNull();
});

it("uses the newest of several open pull requests for one branch", () => {
  const ordered = orderRemoteBranches({
    login: "dev",
    branches: [branch("feature", "2026-09-01T00:00:00Z")],
    pulls: [
      pull(4, "feature", "dev", "2026-09-02T00:00:00Z"),
      pull(5, "feature", "dev", "2026-09-03T00:00:00Z"),
    ],
  });
  expect(ordered[0]).toMatchObject({ group: "pull", pull: { number: 5 } });
});

it("puts every branch in one group, sorted by commit time, when nobody is signed in", () => {
  const ordered = orderRemoteBranches({
    login: null,
    branches: [
      branch("b", "2026-09-01T00:00:00Z", "dev"),
      branch("a", "2026-09-02T00:00:00Z", "dev"),
      branch("c", "not a date"),
    ],
    pulls: [pull(1, "b", "dev", "2026-09-03T00:00:00Z")],
  });
  expect(ordered.map((entry) => [entry.name, entry.group])).toEqual([
    ["a", "other"],
    ["b", "other"],
    ["c", "other"],
  ]);
});
