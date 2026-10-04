import type {
  BbPluginApi,
  JsonValue,
  PluginRpcHandlers,
} from "@get-bb/plugin-sdk";
import type { PluginEnvironmentProviderCreateResult } from "@get-bb/plugin-sdk/environment-provider";
import {
  GITEA_BRANCH_ENVIRONMENT_PROVIDER_ID,
  giteaBranchHostContract,
  giteaBranchInputsSchema,
  type branchRpcContract,
} from "./branch-contract.js";
import {
  orderRemoteBranches,
  type OpenPullInput,
  type RemoteBranchInput,
} from "./branch-order.js";

const HOST_TIMEOUT_MS = 15 * 60 * 1000;
const REMOTE_BRANCH_TTL_MS = 30_000;
const ADOPTED_RESOURCE = { adopted: true } as const;

export interface RemoteBranchData {
  branches: RemoteBranchInput[];
  pulls: OpenPullInput[];
  truncated: boolean;
}

export interface BranchProviderDeps {
  /** The Gitea repository (owner/name) of an origin remote URL, or null when it is not on the configured instance. */
  repoFromRemote(remote: string): string | null;
  /** The Gitea repository of a local checkout's origin remote. */
  repoFromCheckout(path: string): Promise<string | null>;
  /** The signed-in Gitea user. */
  login(): Promise<string>;
  readRemoteBranches(repo: string, signal?: AbortSignal): Promise<RemoteBranchData>;
}

function isAdopted(resource: JsonValue | null): boolean {
  return (
    typeof resource === "object" &&
    resource !== null &&
    !Array.isArray(resource) &&
    resource.adopted === true
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Registers the "Gitea branch" environment provider and returns the RPC
 * handlers its picker uses.
 */
export function registerBranchProvider(
  bb: BbPluginApi,
  deps: BranchProviderDeps,
): PluginRpcHandlers<typeof branchRpcContract> {
  const host = bb.hosts.experimental_client({
    contract: giteaBranchHostContract,
  });

  async function checkoutSource(projectId: string, hostId: string | null) {
    const projects = await bb.sdk.projects.list();
    const sources = (
      projects.find((project) => project.id === projectId)?.sources ?? []
    ).filter((source) => source.type === "local_path");
    return hostId === null
      ? (sources.find((source) => source.isDefault) ?? sources[0])
      : sources.find((source) => source.hostId === hostId);
  }

  async function orderedBranches(repo: string, signal?: AbortSignal) {
    const [data, login] = await Promise.all([
      deps.readRemoteBranches(repo, signal),
      deps.login(),
    ]);
    return {
      branches: orderRemoteBranches({ ...data, login }),
      truncated: data.truncated,
    };
  }

  type Ordered = Awaited<ReturnType<typeof orderedBranches>>;
  const orderedCache = new Map<string, { at: number; value: Promise<Ordered> }>();

  function cachedBranches(repo: string, refresh: boolean, signal?: AbortSignal) {
    const now = Date.now();
    const cached = orderedCache.get(repo);
    if (!refresh && cached && now - cached.at < REMOTE_BRANCH_TTL_MS)
      return cached.value;
    const value = orderedBranches(repo, signal);
    orderedCache.set(repo, { at: now, value });
    value.catch(() => {
      if (orderedCache.get(repo)?.value === value) orderedCache.delete(repo);
    });
    return value;
  }

  async function adopt(
    context: {
      host: { id: string };
      projectCheckout: { path: string };
      signal: AbortSignal;
      experimental_claimPath(path: string): Promise<boolean>;
      report: { step(text: string): void };
    },
    path: string,
    branch: string | null,
  ): Promise<PluginEnvironmentProviderCreateResult> {
    if (branch !== null) context.report.step(`Switching the worktree to ${branch}`);
    const result = await host.call(
      "useExisting",
      { sourcePath: context.projectCheckout.path, path, branch },
      { hostId: context.host.id, signal: context.signal, timeoutMs: HOST_TIMEOUT_MS },
    );
    if (result.status === "failed") return result;
    if (!(await context.experimental_claimPath(result.path)))
      return {
        status: "failed",
        message: `${result.path} is already in use by another environment.`,
      };
    return {
      status: "created",
      path: result.path,
      ownsPath: false,
      resource: ADOPTED_RESOURCE,
    };
  }

  async function createOwned(
    context: {
      host: { id: string };
      projectCheckout: { path: string };
      pathKey: string;
      signal: AbortSignal;
      report: { step(text: string): void };
    },
    branch:
      | { kind: "checkout"; name: string }
      | { kind: "new"; name: string; base: string | null },
  ): Promise<PluginEnvironmentProviderCreateResult> {
    context.report.step(
      branch.kind === "checkout"
        ? `Creating a worktree on ${branch.name}`
        : `Creating a worktree from ${branch.base ?? "the default branch"}`,
    );
    try {
      const result = await host.call(
        "create",
        { sourcePath: context.projectCheckout.path, pathKey: context.pathKey, branch },
        { hostId: context.host.id, signal: context.signal, timeoutMs: HOST_TIMEOUT_MS },
      );
      if (result.status === "failed") return result;
      return {
        status: "created",
        path: result.path,
        ownsPath: true,
        ...(result.baseBranch === null ? {} : { mergeBaseBranch: result.baseBranch }),
      };
    } catch (error) {
      if (context.signal.aborted) throw error;
      return { status: "failed", message: errorMessage(error) };
    }
  }

  bb.experimental_environments.register({
    id: GITEA_BRANCH_ENVIRONMENT_PROVIDER_ID,
    displayName: "Gitea branch",
    description: "Work on a Gitea branch in a worktree.",
    icon: "gitea/teacup",
    requires: { gitCheckout: true },
    inputs: giteaBranchInputsSchema,
    policy: { pathKeys: "per-attempt" },
    availability(context) {
      if (context.gitRemote === null || deps.repoFromRemote(context.gitRemote))
        return { status: "available" };
      return {
        status: "unavailable",
        message: "This project's origin remote is not on the configured Gitea instance.",
      };
    },
    experimental_existingPath: (inputs) =>
      inputs.kind === "existing" && inputs.remoteBranch === undefined
        ? inputs.path
        : null,
    async create(context) {
      const inputs = context.inputs;
      switch (inputs.kind) {
        case "existing":
          return adopt(context, inputs.path, inputs.remoteBranch ?? null);
        case "remote":
          return createOwned(context, { kind: "checkout", name: inputs.name });
        case "new":
          return createOwned(context, {
            kind: "new",
            name: context.suggestedBranchName,
            base: inputs.from.kind === "named" ? inputs.from.name : null,
          });
      }
    },
    async restore(context) {
      if (context.inputs.kind === "existing")
        return adopt(context, context.inputs.path, null);
      const branchName = context.previous.environment.branchName;
      if (branchName === null)
        return {
          status: "failed",
          message:
            "The removed worktree had no branch checked out, so there is no branch to restore it on.",
        };
      return createOwned(context, { kind: "checkout", name: branchName });
    },
    async remove(context) {
      if (isAdopted(context.resource) || context.path === null)
        return { status: "removed" };
      if (context.hostId === null)
        return { status: "failed", message: "The worktree machine is unknown." };
      try {
        return await host.call(
          "remove",
          { path: context.path },
          { hostId: context.hostId, signal: context.signal, timeoutMs: HOST_TIMEOUT_MS },
        );
      } catch (error) {
        if (context.signal.aborted) throw error;
        return { status: "failed", message: errorMessage(error) };
      }
    },
  });

  return {
    async remoteBranches(
      { projectId, refresh },
      { experimental_signal: signal }: { experimental_signal?: AbortSignal } = {},
    ) {
      const source = await checkoutSource(projectId, null);
      const repo = source ? await deps.repoFromCheckout(source.path) : null;
      if (repo === null)
        return { repo: null, branches: [], truncated: false, error: null };
      try {
        const ordered = await cachedBranches(repo, refresh, signal);
        return { repo, ...ordered, error: null };
      } catch (error) {
        if (signal?.aborted) throw error;
        return { repo, branches: [], truncated: false, error: errorMessage(error) };
      }
    },
    async branchDefaultBase({ projectId, hostId }) {
      const source = await checkoutSource(projectId, hostId);
      if (source === undefined) return { branch: null };
      return host.call(
        "defaultBaseBranch",
        { sourcePath: source.path },
        { hostId: source.hostId },
      );
    },
    async branchWorktrees({ projectId, hostId }) {
      const source = await checkoutSource(projectId, hostId);
      if (source === undefined) return { worktrees: [] };
      return host.call("listWorktrees", { sourcePath: source.path }, { hostId });
    },
  };
}
