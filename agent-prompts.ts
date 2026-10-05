/**
 * Instruction text the plugin sends to agents. Each prompt has a built-in
 * default that the user can replace in the plugin settings. Prompts use
 * `{name}` placeholders, filled when the prompt is sent.
 */

export const agentPromptIds = [
  "autoFixer",
  "autoFixOn",
  "autoFixOff",
  "autoMergeOn",
  "autoMergeOff",
  "issueAgent",
  "prReview",
] as const;

export type AgentPromptId = (typeof agentPromptIds)[number];

export type AgentPromptOverrides = Partial<Record<AgentPromptId, string>>;

export type PromptValues = Record<string, string | number>;

const itemPlaceholders = ["repo", "number", "ref", "title", "url", "baseUrl"];
const autoFixerPlaceholders = [...itemPlaceholders, "login", "teaFlags", "teaApi"];

export type AgentPromptDefinition = {
  id: AgentPromptId;
  label: string;
  description: string;
  placeholders: readonly string[];
  defaultText: string;
};

export const agentPrompts: readonly AgentPromptDefinition[] = [
  {
    id: "autoFixer",
    label: "Auto-fixer",
    description:
      "Sent when an auto-fixer starts, resumes, or its Auto-fix or Auto-merge switch changes.",
    placeholders: autoFixerPlaceholders,
    defaultText: [
      "You are the Gitea PR auto-fixer for {ref}: {title}",
      "Gitea instance: {baseUrl}",
      "",
      "Use the existing checkout. Do not clone the repository or create a BB project.",
      "Use the tea CLI with the explicit login profile `{login}` on every command. Do not use gh or GitHub-specific tooling.",
      "Before you act, read the full PR, diff, conversation, reviews, review comments, and commit statuses:",
      "- `tea pulls {teaFlags} --comments {number}`",
      "- `{teaApi}/pulls/{number}` and `{teaApi}/pulls/{number}.diff`",
      "- `tea pulls review-comments {teaFlags} {number}`",
      "- `{teaApi}/commits/<head sha>/status`",
      "",
      "Repeat these steps while the PR is open:",
      "1. Read the current PR state. Reread the diff and conversation only when the head, comments, or reviews changed.",
      "2. Complete the next permitted action that can advance the PR.",
      "3. After each state change, return to step 1.",
      "",
      "Only missing credentials, missing permissions, destructive choices, and product or scope decisions require a human.",
    ].join("\n"),
  },
  {
    id: "autoFixOn",
    label: "Auto-fix on",
    description: "Rules added to the auto-fixer prompt when Auto-fix is on.",
    placeholders: autoFixerPlaceholders,
    defaultText: [
      "Auto-fix is on. Fix failing CI checks and address review feedback.",
      "You can fix, commit, push, rebase, reply to review comments (`tea pulls reply {teaFlags} {number} <comment id> <reply>`), resolve addressed review comments (`tea pulls resolve {teaFlags} <comment id>`), and mark a WIP pull request ready for review (`tea pulls edit {teaFlags} --ready {number}`, which only strips a leading `WIP: ` or `[WIP]` title prefix). Do not change the title otherwise.",
      "Test each code change before you push it.",
    ].join("\n"),
  },
  {
    id: "autoFixOff",
    label: "Auto-fix off",
    description: "Rules added to the auto-fixer prompt when Auto-fix is off.",
    placeholders: autoFixerPlaceholders,
    defaultText: [
      "Auto-fix is off. Do not change code, commit, push, rebase, reply to or resolve review comments, or edit the pull request.",
      "If a required check fails, changes are requested, or the branch conflicts with its base, finish with NEEDS_YOU and say what blocks the merge.",
    ].join("\n"),
  },
  {
    id: "autoMergeOn",
    label: "Auto-merge on",
    description: "Rules added to the auto-fixer prompt when Auto-merge is on.",
    placeholders: autoFixerPlaceholders,
    defaultText: [
      "Auto-merge is on. Gitea has no auto-merge setting that you may enable; do not try to schedule one.",
      "Merge only with `tea pulls merge {teaFlags} --style <style> {number}`, and only when your Gitea permissions allow it, branch protection is satisfied, every required status check passes, and required approvals are present.",
      "Use the repository's default merge style (`default_merge_style` from `{teaApi}`). Use squash only if the repository or a human requires it.",
    ].join("\n"),
  },
  {
    id: "autoMergeOff",
    label: "Auto-merge off",
    description: "Rules added to the auto-fixer prompt when Auto-merge is off.",
    placeholders: autoFixerPlaceholders,
    defaultText:
      "Auto-merge is off. Never merge this pull request, and do not enable or schedule a merge. A human merges it; keep watching until Gitea reports it merged or closed.",
  },
  {
    id: "issueAgent",
    label: "Send issue to agent",
    description:
      "Sent by Send to agent on an issue. The issue title, body, and recent comments are always added after it.",
    placeholders: [...itemPlaceholders, "state"],
    defaultText:
      "Read the Gitea issue {ref}, inspect its comments, and work on the requested change in the project checkout. Do not post or mutate Gitea unless asked.",
  },
  {
    id: "prReview",
    label: "Send pull request to agent",
    description:
      "Sent by Send to agent on a pull request. The pull request body, recent comments, and changed files are always added after it.",
    placeholders: [...itemPlaceholders, "state"],
    defaultText:
      "Review Gitea pull request {ref} and its changed files for correctness, missing tests, and design issues. Report findings with file and line references. Do not post or mutate Gitea unless asked.",
  },
];

const definitions = new Map(agentPrompts.map((prompt) => [prompt.id, prompt]));

export function agentPrompt(id: AgentPromptId): AgentPromptDefinition {
  return definitions.get(id)!;
}

/**
 * The part of the auto-fixer prompt that the user cannot change. The plugin
 * relies on the wait command and the end markers to track each auto-fixer.
 * `{autoFixRules}` and `{autoMergeRules}` take the Auto-fix and Auto-merge
 * prompts that match the current switches.
 */
export const autoFixerProtocol = [
  "If no permitted action is possible, wait for a change: `bb gitea pr-watch {repo} {number} --since <token>`, passing the token from its previous output as `--since` (omit it the first time). It checks the PR and its CI status every 30 seconds and returns within a few minutes. On `changed`, read the PR state again. On `unchanged`, run it again. On `inactive`, this auto-fixer was stopped: end your turn without further action.",
  "Do not use `sleep` to wait for Gitea.",
  "",
  "These Auto-fix and Auto-merge settings replace any earlier instructions in this thread:",
  "{autoFixRules}",
  "{autoMergeRules}",
  "Stay in this turn until the PR is merged, closed, manually stopped, or requires a human.",
  "",
  "Your final response must contain exactly one of these markers:",
  "BB_GITEA_AUTO_FIX: MERGED",
  "BB_GITEA_AUTO_FIX: CLOSED",
  "BB_GITEA_AUTO_FIX: NEEDS_YOU",
  "BB_GITEA_AUTO_FIX: FAILED",
  "Use FAILED only for an execution failure.",
].join("\n");

const placeholderPattern = /\{([A-Za-z][A-Za-z0-9]*)\}/g;

/** Replaces each known `{name}` with its value. Unknown names stay as written. */
export function fillPrompt(template: string, values: PromptValues): string {
  return template.replace(placeholderPattern, (match, name: string) =>
    Object.hasOwn(values, name) ? String(values[name]) : match,
  );
}

/** The placeholder names in `text` that the prompt does not accept, in order of first use. */
export function unknownPlaceholders(text: string, accepted: readonly string[]): string[] {
  const names = [...text.matchAll(placeholderPattern)].map((match) => match[1]!);
  return [...new Set(names.filter((name) => !accepted.includes(name)))];
}

/**
 * Reads the stored overrides. Invalid JSON, unknown ids, and values that are
 * not strings are ignored, so a bad setting never blocks an agent.
 */
export function parsePromptOverrides(raw: string): AgentPromptOverrides {
  let parsed: unknown;
  try {
    parsed = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const overrides: AgentPromptOverrides = {};
  for (const id of agentPromptIds) {
    const value = (parsed as Record<string, unknown>)[id];
    if (typeof value === "string") overrides[id] = value;
  }
  return overrides;
}

/**
 * Writes the overrides for storage. Text that is blank or equal to the default
 * is dropped, so only real changes are stored. No changes store an empty string.
 */
export function formatPromptOverrides(overrides: AgentPromptOverrides): string {
  const kept = Object.fromEntries(
    agentPromptIds.flatMap((id) => {
      const value = overrides[id];
      return value !== undefined && value.trim() && value !== agentPrompt(id).defaultText
        ? [[id, value]]
        : [];
    }),
  );
  return Object.keys(kept).length ? JSON.stringify(kept, null, 2) : "";
}

/** The text to send for a prompt: the user's override, or the default. */
export function promptText(overrides: AgentPromptOverrides, id: AgentPromptId): string {
  const value = overrides[id];
  return value !== undefined && value.trim() ? value : agentPrompt(id).defaultText;
}
