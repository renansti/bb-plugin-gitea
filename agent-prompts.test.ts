import { describe, expect, it } from "vitest";
import {
  agentPrompt,
  agentPrompts,
  fillPrompt,
  formatPromptOverrides,
  parsePromptOverrides,
  promptText,
  unknownPlaceholders,
} from "./agent-prompts.js";
import { buildAutoFixerPrompt, type AutoFixerPolicy } from "./auto-fixer.js";

describe("agent prompts", () => {
  it("fills known placeholders and keeps unknown ones as written", () => {
    expect(fillPrompt("{ref} {title} {foo} {}", { ref: "a/b#1", title: "T" })).toBe(
      "a/b#1 T {foo} {}",
    );
  });

  it("does not fill placeholders inside filled values", () => {
    expect(fillPrompt("{title}", { title: "{ref}", ref: "x" })).toBe("{ref}");
  });

  it("lists each unknown placeholder once", () => {
    expect(unknownPlaceholders("{repo} {reop} {reop} {x1}", ["repo"])).toEqual(["reop", "x1"]);
  });

  it("uses only placeholders each default accepts", () => {
    for (const prompt of agentPrompts)
      expect(unknownPlaceholders(prompt.defaultText, prompt.placeholders)).toEqual([]);
  });

  it("ignores invalid JSON, unknown ids, and values that are not strings", () => {
    expect(parsePromptOverrides("{")).toEqual({});
    expect(parsePromptOverrides("[]")).toEqual({});
    expect(parsePromptOverrides('{"autoFixer":"A","other":"B","prReview":3}')).toEqual({
      autoFixer: "A",
    });
  });

  it("stores only prompts that differ from the default", () => {
    expect(
      formatPromptOverrides({
        autoFixer: "Custom",
        issueAgent: agentPrompt("issueAgent").defaultText,
        prReview: "  ",
      }),
    ).toBe('{\n  "autoFixer": "Custom"\n}');
    expect(formatPromptOverrides({ issueAgent: agentPrompt("issueAgent").defaultText })).toBe("");
    expect(parsePromptOverrides(formatPromptOverrides({ prReview: 'Say "hi"\nthen go' }))).toEqual({
      prReview: 'Say "hi"\nthen go',
    });
  });

  it("falls back to the default for blank text", () => {
    expect(promptText({ issueAgent: "\n" }, "issueAgent")).toBe(agentPrompt("issueAgent").defaultText);
    expect(promptText({ issueAgent: "Mine" }, "issueAgent")).toBe("Mine");
  });
});

describe("custom auto-fixer prompts", () => {
  const input = {
    repo: "acme/widgets",
    number: 42,
    title: "Fix it",
    baseUrl: "https://gitea.example/prefix/",
    login: "work",
    policy: { fix: true, merge: false } as AutoFixerPolicy,
  };

  it("replaces the instructions and keeps the wait command and end markers", () => {
    const prompt = buildAutoFixerPrompt({
      ...input,
      overrides: { autoFixer: "Run npm test before every push in {ref} ({url}). {nope}" },
    });
    expect(prompt).toMatch(
      /^Run npm test before every push in acme\/widgets#42 \(https:\/\/gitea\.example\/prefix\/acme\/widgets\/pulls\/42\)\. \{nope\}\n/,
    );
    expect(prompt).not.toContain("You are the Gitea PR auto-fixer");
    expect(prompt).toContain("bb gitea pr-watch acme/widgets 42 --since <token>");
    expect(prompt).toContain("BB_GITEA_AUTO_FIX: NEEDS_YOU");
    expect(prompt).toContain("Auto-fix is on.");
  });

  it("uses the custom rules that match the switches", () => {
    const overrides = {
      autoFixOn: "FIX ON {teaFlags}",
      autoFixOff: "FIX OFF",
      autoMergeOn: "MERGE ON {teaApi}",
      autoMergeOff: "MERGE OFF",
    };
    const fixOnly = buildAutoFixerPrompt({ ...input, overrides });
    expect(fixOnly).toContain("FIX ON --login work --repo acme/widgets\nMERGE OFF");
    expect(fixOnly).not.toContain("FIX OFF");
    const mergeOnly = buildAutoFixerPrompt({ ...input, policy: { fix: false, merge: true }, overrides });
    expect(mergeOnly).toContain("FIX OFF\nMERGE ON tea api --login work /api/v1/repos/acme/widgets");
  });
});
