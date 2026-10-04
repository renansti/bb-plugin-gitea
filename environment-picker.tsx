import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  experimental_useBranches,
  useRpc,
  type PluginEnvironmentProviderInputsProps,
} from "@get-bb/plugin-sdk/app";
import type { giteaRpcContract } from "./server.js";
import {
  giteaBranchInputsSchema,
  type GiteaBranchInputs,
} from "./branch-inputs.js";
import type { DiscoveredWorktree, RemoteBranch } from "./branch-contract.js";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  COARSE_POINTER_COMPACT_ICON_SIZE_CLASS,
  COARSE_POINTER_COMPACT_ICON_SIZE_SHRINK_CLASS,
  COARSE_POINTER_ICON_SIZE_SHRINK_CLASS,
} from "@/components/ui/coarse-pointer-sizing";
import { LIST_HOVER_TRANSITION } from "@/components/ui/motion";
import { cn } from "@/lib/utils";

const DEFAULT_INPUTS: GiteaBranchInputs = {
  kind: "new",
  from: { kind: "default" },
};
const ROW_CLASS_NAME =
  "flex w-full min-w-0 items-center gap-2 rounded-sm px-2 py-[0.3125rem] text-left text-xs outline-none hover:bg-state-hover hover:text-foreground focus-visible:bg-state-hover focus-visible:text-foreground";
const TRIGGER_CLASS_NAME =
  "h-8 w-fit max-w-full min-w-0 items-center justify-start gap-1 border-none bg-transparent px-1 text-xs leading-tight text-muted-foreground shadow-none hover:text-muted-foreground";

type Intent = "new" | "existing";

function parseInputs(value: unknown): GiteaBranchInputs | null {
  const parsed = giteaBranchInputsSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function worktreeLabel(path: string): string {
  return path.split("/").filter(Boolean).slice(-2).join("/") || path;
}

function matches(query: string, ...values: string[]): boolean {
  const normalized = query.trim().toLowerCase();
  return (
    normalized.length === 0 ||
    values.some((value) => value.toLowerCase().includes(normalized))
  );
}

function SectionHeader({ label }: { label: string }) {
  return (
    <div className="flex h-7 items-center px-2 text-xs font-medium text-muted-foreground">
      {label}
    </div>
  );
}

function Row({
  icon,
  selected,
  disabled,
  title,
  onSelect,
  children,
}: {
  icon: string;
  selected: boolean;
  disabled?: boolean;
  title: string;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={cn(
        ROW_CLASS_NAME,
        LIST_HOVER_TRANSITION,
        disabled &&
          "cursor-not-allowed text-muted-foreground opacity-60 hover:bg-transparent hover:text-muted-foreground",
      )}
      disabled={disabled}
      title={title}
      onClick={onSelect}
    >
      <Icon
        name={icon}
        className={cn("text-muted-foreground", COARSE_POINTER_COMPACT_ICON_SIZE_SHRINK_CLASS)}
      />
      {children}
      <Icon
        name="Check"
        className={cn(selected ? "opacity-100" : "opacity-0", COARSE_POINTER_ICON_SIZE_SHRINK_CLASS)}
      />
    </button>
  );
}

function Note({ children }: { children: ReactNode }) {
  return (
    <p className="px-2 py-3 text-center text-xs text-muted-foreground">{children}</p>
  );
}

function useScoped<T>(key: string | null, load: (key: string) => Promise<T>) {
  const [state, setState] = useState<{
    key: string;
    value: T | null;
    loading: boolean;
    error: string | null;
  } | null>(null);
  const request = useRef(0);
  const reload = useCallback(
    async (nextKey = key) => {
      const id = ++request.current;
      if (nextKey === null) {
        setState(null);
        return;
      }
      setState((current) => ({
        key: nextKey,
        value: current?.key === nextKey ? current.value : null,
        loading: true,
        error: null,
      }));
      try {
        const value = await load(nextKey);
        if (id === request.current)
          setState({ key: nextKey, value, loading: false, error: null });
      } catch (error) {
        if (id === request.current)
          setState((current) => ({
            key: nextKey,
            value: current?.key === nextKey ? current.value : null,
            loading: false,
            error: error instanceof Error ? error.message : String(error),
          }));
      }
    },
    [key, load],
  );
  useEffect(() => () => void (request.current += 1), []);
  return [state?.key === key ? state : null, reload] as const;
}

/**
 * The "Gitea branch" environment control. Lists where to work, the
 * repository's Gitea branches, and the local branches a new thread branch
 * can start from.
 */
export function GiteaBranchInputsControl({
  projectId,
  target,
  value,
  onChange,
}: PluginEnvironmentProviderInputsProps) {
  const hostId = target.kind === "existing-host" ? target.hostId : null;
  const rpc = useRpc<typeof giteaRpcContract>();
  const inputs = parseInputs(value);
  const selectedIntent: Intent = inputs?.kind === "existing" ? "existing" : "new";
  const [intent, setIntent] = useState<Intent>(selectedIntent);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const inputRef = useRef<HTMLInputElement>(null);

  const branchState = experimental_useBranches({
    hostId,
    projectId,
    query: intent === "new" ? deferredQuery.trim().toLowerCase() : "",
  });

  const loadRemote = useCallback(
    (key: string) => rpc.call("remoteBranches", { projectId: key, refresh: false }),
    [rpc],
  );
  const [remote, reloadRemote] = useScoped(projectId, loadRemote);
  const refreshRemote = useCallback(async () => {
    if (projectId === null) return;
    await rpc
      .call("remoteBranches", { projectId, refresh: true })
      .then(() => reloadRemote())
      .catch(() => undefined);
  }, [projectId, rpc, reloadRemote]);

  const scopeKey = projectId !== null && hostId !== null ? `${projectId}\n${hostId}` : null;
  const loadWorktrees = useCallback(
    (key: string) => {
      const [project, host] = key.split("\n") as [string, string];
      return rpc.call("branchWorktrees", { projectId: project, hostId: host });
    },
    [rpc],
  );
  const [worktreeState, reloadWorktrees] = useScoped(scopeKey, loadWorktrees);

  const loadDefault = useCallback(
    (key: string) => rpc.call("branchDefaultBase", { projectId: key, hostId }),
    [rpc, hostId],
  );
  const [defaultBase, reloadDefault] = useScoped(projectId, loadDefault);

  const needsDefault = inputs === null;
  useEffect(() => {
    if (needsDefault) onChange({ status: "ready", value: DEFAULT_INPUTS });
  }, [needsDefault, onChange]);

  useEffect(() => {
    void reloadRemote();
    void reloadDefault();
  }, [reloadRemote, reloadDefault]);

  useEffect(() => {
    if (open) setIntent(selectedIntent);
  }, [open, selectedIntent]);

  const remoteBranches: RemoteBranch[] = (remote?.value?.branches ?? []).filter((branch) =>
    matches(deferredQuery, branch.name, branch.pull ? `#${branch.pull.number}` : ""),
  );
  const localBranches = useMemo(
    () =>
      [...new Set([...branchState.branches, ...branchState.remoteBranches])].filter((branch) =>
        matches(deferredQuery, branch),
      ),
    [branchState.branches, branchState.remoteBranches, deferredQuery],
  );
  const worktrees: DiscoveredWorktree[] = (worktreeState?.value?.worktrees ?? []).filter(
    (worktree) => matches(deferredQuery, worktree.path, worktree.branch ?? ""),
  );
  const existingPath = inputs?.kind === "existing" ? inputs.path : null;

  const updateOpen = (nextOpen: boolean) => {
    if (nextOpen) {
      void branchState.refresh().catch(() => undefined);
      void refreshRemote();
      if (selectedIntent === "existing") void reloadWorktrees();
    } else {
      setQuery("");
    }
    setOpen(nextOpen);
  };
  const submit = (next: GiteaBranchInputs, close = true) => {
    onChange({ status: "ready", value: next });
    if (close) updateOpen(false);
  };
  const pickRemote = (name: string) =>
    submit(
      intent === "existing" && existingPath !== null
        ? { kind: "existing", path: existingPath, remoteBranch: name }
        : { kind: "remote", name },
    );

  const trigger = (() => {
    const defaultLabel = defaultBase?.value?.branch ?? "default";
    switch (inputs?.kind) {
      case "remote":
        return { prefix: "Remote branch:", value: inputs.name, title: `Work on ${inputs.name} in a new worktree` };
      case "existing":
        return {
          prefix: "Reuse:",
          value: inputs.remoteBranch
            ? `${worktreeLabel(inputs.path)} · ${inputs.remoteBranch}`
            : worktreeLabel(inputs.path),
          title: inputs.remoteBranch
            ? `Switch ${inputs.path} to ${inputs.remoteBranch}`
            : inputs.path,
        };
      default: {
        const base = inputs?.from.kind === "named" ? inputs.from.name : defaultLabel;
        return { prefix: "Local branch:", value: base, title: `Create a worktree from ${base}` };
      }
    }
  })();

  const enterSelection = (() => {
    if (intent === "existing" && existingPath === null) {
      const worktree = worktrees.find((candidate) => !candidate.prunable);
      return worktree ? () => submit({ kind: "existing", path: worktree.path }, false) : null;
    }
    const firstRemote = remoteBranches[0];
    if (firstRemote) return () => pickRemote(firstRemote.name);
    const firstLocal = intent === "new" ? localBranches[0] : undefined;
    return firstLocal
      ? () => submit({ kind: "new", from: { kind: "named", name: firstLocal } })
      : null;
  })();

  const remoteSection = (
    <>
      <SectionHeader label="Remote branch:" />
      {remote?.value?.repo === null ? (
        <Note>This project's origin is not on Gitea.</Note>
      ) : remote?.value?.error || remote?.error ? (
        <Note>{remote?.value?.error ?? remote?.error}</Note>
      ) : remoteBranches.length === 0 ? (
        <Note>{remote === null || remote.loading ? "Loading branches..." : "No branches found."}</Note>
      ) : (
        remoteBranches.map((branch) => (
          <Row
            key={branch.name}
            icon={branch.pull ? "GitPullRequest" : "GitBranch"}
            selected={
              (inputs?.kind === "remote" && inputs.name === branch.name) ||
              (inputs?.kind === "existing" && inputs.remoteBranch === branch.name)
            }
            title={branch.pull ? `${branch.name} (pull request #${branch.pull.number})` : branch.name}
            onSelect={() => pickRemote(branch.name)}
          >
            <span className="min-w-0 flex-1 truncate">{branch.name}</span>
            {branch.pull ? (
              <span className="shrink-0 text-muted-foreground">#{branch.pull.number}</span>
            ) : null}
          </Row>
        ))
      )}
      {remote?.value?.truncated ? <Note>Showing the first branches only.</Note> : null}
    </>
  );

  return (
    <Popover open={open} onOpenChange={updateOpen}>
      <PopoverTrigger asChild disabled={projectId === null}>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={projectId === null}
          aria-label="Gitea branch"
          role="combobox"
          aria-expanded={open}
          className={cn(LIST_HOVER_TRANSITION, TRIGGER_CLASS_NAME)}
        >
          <span className="contents" title={trigger.title}>
            <Icon name="GitMerge" className={COARSE_POINTER_COMPACT_ICON_SIZE_SHRINK_CLASS} />
            <span className="flex min-w-0 items-baseline gap-1 truncate">
              <span data-promptbox-hide-compact="" className="shrink-0 text-muted-foreground">
                {trigger.prefix}
              </span>
              <span className="min-w-0 truncate font-medium text-foreground">{trigger.value}</span>
            </span>
          </span>
          <Icon
            name="ChevronDown"
            className={cn("shrink-0 text-muted-foreground", COARSE_POINTER_COMPACT_ICON_SIZE_CLASS)}
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        collisionPadding={16}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          inputRef.current?.focus();
        }}
        className="flex w-full min-w-0 flex-col overflow-hidden p-0 md:w-80 md:max-h-[calc(100vh-6rem)]"
      >
        <div className="shrink-0 border-b border-border p-1.5">
          <div className="relative">
            <Icon
              name="Search"
              className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              ref={inputRef}
              aria-label={intent === "existing" && existingPath === null ? "Search worktrees" : "Search branches"}
              placeholder={intent === "existing" && existingPath === null ? "Search worktrees" : "Search branches"}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                event.stopPropagation();
                enterSelection?.();
              }}
              className="h-8 border-0 bg-transparent pl-8 pr-2 text-xs shadow-none focus-visible:ring-0"
            />
          </div>
        </div>
        <div
          className="min-h-0 max-h-[60vh] overflow-y-auto overscroll-contain px-1 pb-1 pt-0 md:max-h-96"
          onWheel={(event) => event.stopPropagation()}
        >
          <SectionHeader label="Work in:" />
          <Row
            icon="Plus"
            selected={intent === "new"}
            title="Create a worktree for this thread"
            onSelect={() => {
              setIntent("new");
              setQuery("");
            }}
          >
            <span className="min-w-0 flex-1 truncate">New worktree</span>
          </Row>
          <Row
            icon="FolderGit"
            disabled={projectId === null || hostId === null}
            selected={intent === "existing"}
            title="Use a worktree you already have"
            onSelect={() => {
              setIntent("existing");
              setQuery("");
              void reloadWorktrees();
            }}
          >
            <span className="min-w-0 flex-1 truncate">Existing worktree</span>
          </Row>
          <div className="my-1 h-px bg-border/60" />
          {intent === "new" ? (
            <>
              {remoteSection}
              <div className="my-1 h-px bg-border/60" />
              <SectionHeader label="Local branch:" />
              <Row
                icon="GitMerge"
                selected={inputs?.kind === "new" && inputs.from.kind === "default"}
                title="Start a new branch from the repository's default branch"
                onSelect={() => submit(DEFAULT_INPUTS)}
              >
                <span className="min-w-0 flex-1 truncate">Default branch</span>
              </Row>
              {localBranches.map((branch) => (
                <Row
                  key={branch}
                  icon="GitMerge"
                  selected={
                    inputs?.kind === "new" &&
                    inputs.from.kind === "named" &&
                    inputs.from.name === branch
                  }
                  title={`Start a new branch from ${branch}`}
                  onSelect={() => submit({ kind: "new", from: { kind: "named", name: branch } })}
                >
                  <span className="min-w-0 flex-1 truncate">{branch}</span>
                </Row>
              ))}
              {localBranches.length === 0 && branchState.isLoading ? (
                <Note>Loading branches...</Note>
              ) : null}
            </>
          ) : (
            <>
              <SectionHeader label="Existing worktree:" />
              {worktrees.length === 0 ? (
                <Note>
                  {worktreeState === null || worktreeState.loading
                    ? "Loading worktrees..."
                    : worktreeState.error
                      ? "Could not load worktrees. Select Existing worktree to retry."
                      : (worktreeState.value?.worktrees.length ?? 0) === 0
                        ? "No existing worktrees found."
                        : "No matching worktrees found."}
                </Note>
              ) : null}
              {worktrees.map((worktree) => (
                <Row
                  key={worktree.path}
                  icon="FolderGit"
                  selected={worktree.path === existingPath}
                  disabled={worktree.prunable}
                  title={worktree.path}
                  onSelect={() => {
                    submit({ kind: "existing", path: worktree.path }, false);
                    setQuery("");
                  }}
                >
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="min-w-0 truncate text-left [direction:rtl]">
                      <bdi dir="ltr">{worktree.path}</bdi>
                    </span>
                    <span className="min-w-0 truncate text-xs text-muted-foreground">
                      {worktree.branch ?? "Detached HEAD"}
                      {worktree.locked ? " · locked" : ""}
                      {worktree.prunable ? " · prunable" : ""}
                    </span>
                  </span>
                </Row>
              ))}
              {existingPath !== null ? (
                <>
                  <div className="my-1 h-px bg-border/60" />
                  <Row
                    icon="GitMerge"
                    selected={inputs?.kind === "existing" && inputs.remoteBranch === undefined}
                    title="Keep the worktree on its current branch"
                    onSelect={() => submit({ kind: "existing", path: existingPath })}
                  >
                    <span className="min-w-0 flex-1 truncate">Keep current branch</span>
                  </Row>
                  {remoteSection}
                </>
              ) : null}
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
