export type RemoteBranchGroup = "pull" | "mine" | "other";

export interface RemoteBranchInput {
  name: string;
  /** Gitea user names of the last commit's author and committer. */
  authors: readonly string[];
  /** ISO time of the last commit. */
  updatedAt: string;
}

export interface OpenPullInput {
  number: number;
  url: string;
  author: string;
  headBranch: string;
  /** ISO time of the last pull request update. */
  updatedAt: string;
}

export interface OrderedRemoteBranch {
  name: string;
  group: RemoteBranchGroup;
  pull: { number: number; url: string } | null;
  updatedAt: string;
}

const groupRank: Record<RemoteBranchGroup, number> = {
  pull: 0,
  mine: 1,
  other: 2,
};

function time(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Sorts remote branches into three groups, newest first within each group:
 * branches with an open pull request by `login`, branches whose last commit
 * is by `login`, then all other branches. Pull request branches sort by the
 * pull request's update time. The others sort by their last commit time.
 */
export function orderRemoteBranches(args: {
  branches: readonly RemoteBranchInput[];
  pulls: readonly OpenPullInput[];
  login: string | null;
}): OrderedRemoteBranch[] {
  const login = args.login?.toLowerCase() ?? null;
  const pullByBranch = new Map<string, OpenPullInput>();
  for (const pull of args.pulls) {
    if (login === null || pull.author.toLowerCase() !== login) continue;
    const current = pullByBranch.get(pull.headBranch);
    if (!current || time(pull.updatedAt) > time(current.updatedAt))
      pullByBranch.set(pull.headBranch, pull);
  }
  return args.branches
    .map((branch): OrderedRemoteBranch => {
      const pull = pullByBranch.get(branch.name);
      if (pull)
        return {
          name: branch.name,
          group: "pull",
          pull: { number: pull.number, url: pull.url },
          updatedAt: pull.updatedAt,
        };
      const mine =
        login !== null &&
        branch.authors.some((author) => author.toLowerCase() === login);
      return {
        name: branch.name,
        group: mine ? "mine" : "other",
        pull: null,
        updatedAt: branch.updatedAt,
      };
    })
    .sort(
      (left, right) =>
        groupRank[left.group] - groupRank[right.group] ||
        time(right.updatedAt) - time(left.updatedAt) ||
        left.name.localeCompare(right.name),
    );
}
