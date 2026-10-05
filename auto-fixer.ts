import { createHash } from "node:crypto";
import { z } from "zod";
import {
  autoFixerProtocol,
  fillPrompt,
  promptText,
  type AgentPromptId,
  type AgentPromptOverrides,
  type PromptValues,
} from "./agent-prompts.js";

export const autoFixerExecutionSchema = z
  .object({
    providerId: z.string().min(1),
    model: z.string().min(1),
    reasoningLevel: z.enum([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "none",
      "ultra",
      "ultracode",
    ]),
    serviceTier: z.enum(["fast", "default"]),
  })
  .strict();
export const autoFixerPolicySchema = z.union([
  z.object({ fix: z.literal(true), merge: z.boolean() }).strict(),
  z.object({ fix: z.literal(false), merge: z.literal(true) }).strict(),
]);
export type AutoFixerPolicy = z.infer<typeof autoFixerPolicySchema>;
export const automationSchema = z
  .object({ fix: z.boolean(), merge: z.boolean() })
  .strict();
export type Automation = z.infer<typeof automationSchema>;
export const automationOptions = {
  fix: z.boolean().optional(),
  merge: z.boolean().optional(),
};
export const setsAutomationOption = [
  (patch: { fix?: boolean; merge?: boolean }) =>
    patch.fix !== undefined || patch.merge !== undefined,
  { message: "Set fix, merge, or both." },
] as const;
export const automationPatchSchema = z
  .object(automationOptions)
  .strict()
  .refine(...setsAutomationOption);
export type AutomationPatch = z.infer<typeof automationPatchSchema>;
const automationOff: Automation = { fix: false, merge: false };

export function activePolicy(automation: Automation): AutoFixerPolicy | null {
  if (automation.fix) return { fix: true, merge: automation.merge };
  return automation.merge ? { fix: false, merge: true } : null;
}

export function applyAutomationPatch(
  current: Automation,
  patch: AutomationPatch,
): Automation {
  return {
    fix: patch.fix ?? current.fix,
    merge: patch.merge ?? current.merge,
  };
}

export const autoFixerPreferencesSchema = z
  .object({
    autoFix: z.boolean(),
    autoMerge: z.boolean(),
    execution: autoFixerExecutionSchema,
  })
  .strict();
export type AutoFixerPreferences = z.infer<typeof autoFixerPreferencesSchema>;
export const defaultAutoFixerPreferences: AutoFixerPreferences = {
  autoFix: false,
  autoMerge: false,
  execution: {
    providerId: "codex",
    model: "gpt-5.6-luna",
    reasoningLevel: "xhigh",
    serviceTier: "default",
  },
};

export const repositoryPattern = /^[\w.-]+\/[\w.-]+$/;
export const repositorySchema = z.string().regex(repositoryPattern);

const sessionBase = z.object({
  repo: repositorySchema,
  number: z.number().int().positive(),
  threadId: z.string().min(1),
  hostId: z.string().min(1).optional(),
  updatedAt: z.string().min(1),
  policy: autoFixerPolicySchema,
});
export const autoFixerSessionSchema = z.discriminatedUnion("status", [
  sessionBase.extend({
    status: z.literal("archived"),
    outcome: z.enum(["merged", "closed"]),
    archivedAt: z.string(),
    mergedAt: z.string().optional(),
    closedAt: z.string().optional(),
  }),
  sessionBase.extend({ status: z.literal("watching") }),
  sessionBase.extend({ status: z.literal("needs_you"), note: z.string() }),
  sessionBase.extend({
    status: z.literal("failed"),
    error: z.string().min(1),
    cleanupPending: z.boolean(),
  }),
  sessionBase.extend({ status: z.literal("merged"), mergedAt: z.string() }),
  sessionBase.extend({ status: z.literal("closed"), closedAt: z.string() }),
  sessionBase.extend({
    status: z.literal("stopped"),
    cleanupPending: z.boolean(),
  }),
]);
export type AutoFixerSession = z.infer<typeof autoFixerSessionSchema>;

export function parseStoredSession(raw: unknown): AutoFixerSession | null {
  const parsed = autoFixerSessionSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function parseStoredPreferences(raw: unknown): AutoFixerPreferences {
  const parsed = autoFixerPreferencesSchema.safeParse(raw);
  return parsed.success ? parsed.data : defaultAutoFixerPreferences;
}

export function sessionAutomation(
  session: AutoFixerSession | null,
): Automation {
  switch (session?.status) {
    case "watching":
    case "needs_you":
    case "failed":
      return { fix: session.policy.fix, merge: session.policy.merge };
    default:
      return automationOff;
  }
}

export type AutoFixerAction = "start" | "stop" | "retry";
const actionsSchema = z.object({
  actions: z.array(z.enum(["start", "stop", "retry"])),
  automation: automationSchema,
});
export const autoFixerSessionViewSchema = z.intersection(
  autoFixerSessionSchema,
  actionsSchema,
);
export const autoFixerViewSchema = z.intersection(
  z.discriminatedUnion("status", [
    z.object({ status: z.literal("idle") }),
    ...autoFixerSessionSchema.options,
  ]),
  actionsSchema,
);
export type AutoFixerView = z.infer<typeof autoFixerViewSchema>;

export type PullLifecycle =
  | { state: "open" }
  | { state: "merged"; mergedAt: string }
  | { state: "closed"; closedAt: string };
export type LifecycleFact = PullLifecycle | { state: "unknown"; error: string };
export const unrecognizedPullState =
  "Gitea returned an unrecognized pull request state.";

export function requireLifecycle(pull: unknown): PullLifecycle {
  const lifecycle = parseLifecycle(pull);
  if (!lifecycle) throw new Error(unrecognizedPullState);
  return lifecycle;
}

type Marker = "merged" | "closed" | "needs_you" | "failed";
const maxMessageLength = 4000;
export const giteaAutoFixerTitlePrefix = "Gitea auto-fixer:";

function clip(value: string) {
  return value.length > maxMessageLength
    ? `${value.slice(0, maxMessageLength - 1)}…`
    : value;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export function parseLifecycle(raw: unknown): PullLifecycle | null {
  if (typeof raw !== "object" || raw === null) return null;
  const pull = raw as Record<string, unknown>;
  if (pull.merged === true) {
    const mergedAt = nonEmpty(pull.merged_at) ?? nonEmpty(pull.closed_at);
    return mergedAt ? { state: "merged", mergedAt } : null;
  }
  if (pull.merged !== false) return null;
  if (pull.state === "open") return { state: "open" };
  if (pull.state === "closed") {
    const closedAt = nonEmpty(pull.closed_at) ?? nonEmpty(pull.updated_at);
    return closedAt ? { state: "closed", closedAt } : null;
  }
  return null;
}

export function parseMarker(text: string | null): Marker | null {
  const found = [
    ...(text ?? "").matchAll(
      /BB_GITEA_AUTO_FIX:\s*(MERGED|CLOSED|NEEDS_YOU|FAILED)\b/g,
    ),
  ].map((match) => match[1]!.toLowerCase() as Marker);
  return new Set(found).size === 1 ? found[0]! : null;
}

export function sessionActions(session: AutoFixerSession): AutoFixerAction[] {
  switch (session.status) {
    case "watching":
      return ["stop"];
    case "needs_you":
    case "failed":
      return ["stop", "retry"];
    case "stopped":
      return ["start"];
    case "archived":
    case "merged":
    case "closed":
      return [];
  }
}

export function repoKey(repo: string): string {
  return repo.toLowerCase();
}

export function itemKey(repo: string, number: number): string {
  return `${repoKey(repo)}#${number}`;
}

export function parseItemRef(
  raw: string,
): { repo: string; number: number } | null {
  const at = raw.lastIndexOf("#");
  const repo = raw.slice(0, at);
  const rawNumber = raw.slice(at + 1);
  const number = Number(rawNumber);
  return at > 0 && repositoryPattern.test(repo) && /^[1-9]\d*$/.test(rawNumber)
    ? { repo, number }
    : null;
}

export type StartRejection = "merged" | "closed" | "no-project";

export function startError(key: string, reason: StartRejection): string {
  return reason === "no-project"
    ? `Cannot auto-fix ${key}: no BB project has a checkout of this repository.`
    : `Cannot auto-fix ${key}: the pull request is ${reason}.`;
}

export type StartDecision =
  | { kind: "existing"; threadId: string }
  | { kind: "spawn"; projectId: string; replaces: AutoFixerSession | null }
  | { kind: "reject"; reason: StartRejection };

export function decideStart(input: {
  session: AutoFixerSession | null;
  projectId: string | null;
  lifecycle: PullLifecycle;
}): StartDecision {
  const { session, lifecycle } = input;
  if (session?.status === "merged" ||
      (session?.status === "archived" && session.outcome === "merged"))
    return { kind: "reject", reason: "merged" };
  if (session !== null && session.status !== "closed" && session.status !== "archived")
    return { kind: "existing", threadId: session.threadId };
  if (lifecycle.state !== "open")
    return { kind: "reject", reason: lifecycle.state };
  if (input.projectId === null) return { kind: "reject", reason: "no-project" };
  return { kind: "spawn", projectId: input.projectId, replaces: session };
}

export function autoFixerView(
  session: AutoFixerSession | null,
  facts: { lifecycle: LifecycleFact; projectId: string | null } | null,
): AutoFixerView {
  const start: AutoFixerAction[] =
    facts !== null &&
    facts.lifecycle.state !== "unknown" &&
    decideStart({
      session,
      projectId: facts.projectId,
      lifecycle: facts.lifecycle,
    }).kind === "spawn"
      ? ["start"]
      : [];
  const automation = sessionAutomation(session);
  return session === null
    ? { status: "idle", actions: start, automation }
    : {
        ...session,
        actions: [...sessionActions(session), ...start],
        automation,
      };
}

export function sessionView(session: AutoFixerSession) {
  return {
    ...session,
    actions: sessionActions(session),
    automation: sessionAutomation(session),
  };
}

export type AutomationDecision =
  | { kind: "unchanged" }
  | { kind: "stop" }
  | { kind: "start"; policy: AutoFixerPolicy }
  | { kind: "update"; session: WatchingSession; policy: AutoFixerPolicy }
  | {
      kind: "resume";
      session: ResumableSession;
      policy: AutoFixerPolicy;
      cleanupFirst: boolean;
    }
  | { kind: "reject"; reason: "merged" };
export type WatchingSession = Extract<AutoFixerSession, { status: "watching" }>;

export function decideAutomation(
  session: AutoFixerSession | null,
  patch: AutomationPatch,
): AutomationDecision {
  const policy = activePolicy(
    applyAutomationPatch(sessionAutomation(session), patch),
  );
  if (policy === null)
    return decideStop(session) ? { kind: "stop" } : { kind: "unchanged" };
  if (session?.status === "merged" ||
      (session?.status === "archived" && session.outcome === "merged"))
    return { kind: "reject", reason: "merged" };
  if (session === null || session.status === "closed" || session.status === "archived")
    return { kind: "start", policy };
  if (session.status !== "stopped" && samePolicy(session.policy, policy))
    return { kind: "unchanged" };
  return session.status === "watching"
    ? { kind: "update", session, policy }
    : {
        kind: "resume",
        session,
        policy,
        cleanupFirst: session.status !== "needs_you" && session.cleanupPending,
      };
}

function samePolicy(left: AutoFixerPolicy, right: AutoFixerPolicy): boolean {
  return left.fix === right.fix && left.merge === right.merge;
}

export type RetryDecision =
  | { kind: "existing"; threadId: string }
  | { kind: "reject"; reason: "merged" | "inactive" }
  | {
      kind: "resume";
      session: Extract<AutoFixerSession, { status: "needs_you" | "failed" }>;
      cleanupFirst: boolean;
    };
export type ResumableSession = Extract<
  AutoFixerSession,
  { status: "needs_you" | "failed" | "stopped" }
>;

export function decideRetry(session: AutoFixerSession | null): RetryDecision {
  switch (session?.status) {
    case undefined:
      return { kind: "reject", reason: "inactive" };
    case "archived":
      return { kind: "reject", reason: session.outcome === "merged" ? "merged" : "inactive" };
    case "closed":
    case "stopped":
      return { kind: "reject", reason: "inactive" };
    case "merged":
      return { kind: "reject", reason: "merged" };
    case "watching":
      return { kind: "existing", threadId: session.threadId };
    case "failed":
      return {
        kind: "resume",
        session,
        cleanupFirst: session.cleanupPending,
      };
    case "needs_you":
      return { kind: "resume", session, cleanupFirst: false };
  }
}

export function decideStop(
  session: AutoFixerSession | null,
): Exclude<AutoFixerSession, { status: "merged" | "closed" | "archived" }> | null {
  switch (session?.status) {
    case "watching":
    case "needs_you":
    case "failed":
      return session;
    case "stopped":
      return session.cleanupPending ? session : null;
    default:
      return null;
  }
}

function retained(session: AutoFixerSession, now: string) {
  return {
    repo: session.repo,
    number: session.number,
    threadId: session.threadId,
    ...(session.hostId ? { hostId: session.hostId } : {}),
    updatedAt: now,
    policy: session.policy,
  };
}

function terminal(
  session: AutoFixerSession,
  lifecycle: Exclude<PullLifecycle, { state: "open" }>,
  now: string,
): AutoFixerSession {
  const base = retained(session, now);
  return lifecycle.state === "merged"
    ? { ...base, status: "merged", mergedAt: lifecycle.mergedAt }
    : { ...base, status: "closed", closedAt: lifecycle.closedAt };
}

function failed(
  session: AutoFixerSession,
  error: string,
  now: string,
  cleanupPending = false,
): AutoFixerSession {
  return {
    ...retained(session, now),
    status: "failed",
    error: clip(error),
    cleanupPending,
  };
}

export function confirmedTerminal(
  session: AutoFixerSession,
  lifecycle: LifecycleFact,
  now: string,
): AutoFixerSession | null {
  return lifecycle.state === "merged" || lifecycle.state === "closed"
    ? terminal(session, lifecycle, now)
    : null;
}

export function onIdle(
  session: WatchingSession,
  lastText: string | null,
  lifecycle: LifecycleFact,
  now: string,
): AutoFixerSession {
  const marker = parseMarker(lastText);
  const summary = lastText?.trim() ?? "";
  if (lifecycle.state === "merged" || lifecycle.state === "closed")
    return (marker === "merged" || marker === "closed") &&
      marker !== lifecycle.state
      ? failed(
          session,
          `Gitea reported ${lifecycle.state.toUpperCase()}, not ${marker.toUpperCase()}.`,
          now,
        )
      : terminal(session, lifecycle, now);
  if (marker === "needs_you")
    return {
      ...session,
      status: "needs_you",
      note: clip(summary),
      updatedAt: now,
    };
  if (marker === "failed")
    return failed(session, summary || "Auto-fixer reported FAILED.", now);
  if (lifecycle.state === "unknown")
    return failed(
      session,
      `Could not confirm the Gitea pull request state: ${lifecycle.error}`,
      now,
    );
  if (marker === null)
    return failed(
      session,
      summary ||
        "Auto-fixer turn ended without a terminal marker or a confirmed Gitea terminal state.",
      now,
    );
  return failed(
    session,
    `Gitea still reports the pull request open; it did not confirm ${marker.toUpperCase()}.`,
    now,
  );
}

export function onFailed(
  session: WatchingSession,
  error: string | null,
  now: string,
): AutoFixerSession {
  return failed(session, error?.trim() || "Gitean auto-fixer thread failed.", now);
}

export function onArchived(
  session: WatchingSession,
  now: string,
): Extract<AutoFixerSession, { status: "stopped" }> {
  return stopped(session, now, false);
}

export function onCleanupFailed(
  session: AutoFixerSession,
  detail: string,
  now: string,
): AutoFixerSession {
  if (session.status === "merged" || session.status === "closed") return { ...session, updatedAt: now };
  if (session.status === "stopped")
    return { ...session, cleanupPending: true, updatedAt: now };
  const previous =
    session.status === "failed"
      ? ` (${session.error.replace(/^Cleanup failed: /, "")})`
      : "";
  return failed(session, `Cleanup failed: ${detail}${previous}`, now, true);
}

export function stopped(
  session: AutoFixerSession,
  now: string,
  cleanupPending: boolean,
): Extract<AutoFixerSession, { status: "stopped" }> {
  return { ...retained(session, now), status: "stopped", cleanupPending };
}

export function watching(
  session: AutoFixerSession,
  policy: AutoFixerPolicy,
  now: string,
): AutoFixerSession {
  return { ...retained(session, now), policy, status: "watching" };
}

export function sameSession<S extends AutoFixerSession>(
  left: S,
  right: AutoFixerSession | null,
): right is S {
  return (
    right !== null &&
    right.repo === left.repo &&
    right.number === left.number &&
    right.threadId === left.threadId &&
    right.status === left.status &&
    right.updatedAt === left.updatedAt &&
    samePolicy(right.policy, left.policy)
  );
}

export function autoStartTargets<
  T extends { repo: string; number: number; author: string; state: string },
>(input: {
  login: string;
  pulls: T[];
  projects: Map<string, string>;
  sessions: Map<string, AutoFixerSession>;
}): T[] {
  return input.pulls.filter(
    (pull) =>
      pull.state === "open" &&
      pull.author === input.login &&
      decideStart({
        session: input.sessions.get(itemKey(pull.repo, pull.number)) ?? null,
        projectId: input.projects.get(repoKey(pull.repo)) ?? null,
        lifecycle: { state: "open" },
      }).kind === "spawn",
  );
}

export function buildAutoFixerPrompt(input: {
  repo: string;
  number: number;
  title: string;
  baseUrl: string;
  login: string;
  policy: AutoFixerPolicy;
  overrides?: AgentPromptOverrides;
}): string {
  const overrides = input.overrides ?? {};
  const values: PromptValues = {
    repo: input.repo,
    number: input.number,
    ref: `${input.repo}#${input.number}`,
    title: input.title,
    url: new URL(`${input.repo}/pulls/${input.number}`, input.baseUrl).href,
    baseUrl: input.baseUrl,
    login: input.login,
    teaFlags: `--login ${input.login} --repo ${input.repo}`,
    teaApi: `tea api --login ${input.login} /api/v1/repos/${input.repo}`,
  };
  const fill = (id: AgentPromptId) => fillPrompt(promptText(overrides, id), values);
  return [
    fill("autoFixer"),
    "",
    fillPrompt(autoFixerProtocol, {
      ...values,
      autoFixRules: fill(input.policy.fix ? "autoFixOn" : "autoFixOff"),
      autoMergeRules: fill(input.policy.merge ? "autoMergeOn" : "autoMergeOff"),
    }),
  ].join("\n");
}

export const pullWatchIntervalMs = 30_000;
export const pullWatchDefaultTimeoutMs = 240_000;
export const pullWatchMaxTimeoutMs = 600_000;

export type PullSignal = {
  lifecycle: PullLifecycle["state"] | "unknown";
  head: string;
  base: string;
  mergeable: boolean | null;
  updatedAt: string;
  comments: number;
  reviewComments: number;
  checks: string;
  statuses: string[];
};

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function sha(value: unknown): string {
  return typeof value === "object" && value !== null
    ? (nonEmpty((value as Record<string, unknown>).sha) ?? "")
    : "";
}

/** The cheap change signal for one pull request: its record plus the combined head status. */
export function pullSignal(pull: unknown, combined: unknown): PullSignal {
  const entry = (
    typeof pull === "object" && pull !== null ? pull : {}
  ) as Record<string, unknown>;
  const status = (
    typeof combined === "object" && combined !== null ? combined : {}
  ) as Record<string, unknown>;
  const statuses = Array.isArray(status.statuses) ? status.statuses : [];
  return {
    lifecycle: parseLifecycle(pull)?.state ?? "unknown",
    head: sha(entry.head),
    base: sha(entry.base),
    mergeable: typeof entry.mergeable === "boolean" ? entry.mergeable : null,
    updatedAt: nonEmpty(entry.updated_at) ?? "",
    comments: count(entry.comments),
    reviewComments: count(entry.review_comments),
    checks: nonEmpty(status.state) ?? "",
    statuses: statuses
      .map((raw) => {
        const item = (
          typeof raw === "object" && raw !== null ? raw : {}
        ) as Record<string, unknown>;
        return `${nonEmpty(item.context) ?? ""}=${nonEmpty(item.status) ?? nonEmpty(item.state) ?? ""}@${nonEmpty(item.updated_at) ?? ""}`;
      })
      .sort(),
  };
}

export function signalToken(signal: PullSignal): string {
  return createHash("sha256")
    .update(JSON.stringify(signal))
    .digest("hex")
    .slice(0, 16);
}

export function describeSignal(signal: PullSignal): string {
  const mergeable =
    signal.mergeable === null ? "unknown" : signal.mergeable ? "yes" : "no";
  return `state ${signal.lifecycle} · head ${signal.head.slice(0, 12) || "unknown"} · checks ${signal.checks || "none"} · mergeable ${mergeable} · updated ${signal.updatedAt || "unknown"}`;
}

export function archived(
  session: Extract<AutoFixerSession, { status: "merged" | "closed" }>,
  now: string,
): AutoFixerSession {
  return {
    ...retained(session, now),
    status: "archived",
    outcome: session.status,
    archivedAt: now,
    ...(session.status === "merged"
      ? { mergedAt: session.mergedAt }
      : { closedAt: session.closedAt }),
  };
}
