// @vitest-environment jsdom

import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { agentPrompt } from "./agent-prompts.js";

afterEach(() => cleanup());

const app = await loadPluginApp(() => import("./app"));
const section = app.settingsSections.find((entry) => entry.id === "prompts")!;

function renderSection(settings: Record<string, string> = {}) {
  const updateSettings = vi.fn(async ({ values }: { values: Record<string, unknown> }) => ({
    ok: true as const,
    schema: {},
    values,
  }));
  renderSlot(section, {}, { settings, sdk: { plugins: { updateSettings } } });
  return updateSettings;
}

function box(label: string) {
  return screen.getByLabelText(label) as HTMLTextAreaElement;
}

function buttonsFor(label: string) {
  const block = box(label).parentElement!;
  const buttons = [...block.querySelectorAll("button")];
  return {
    save: buttons.find((button) => button.textContent === "Save")!,
    reset: buttons.find((button) => button.textContent === "Reset to default")!,
  };
}

it("starts each box with the default text", () => {
  renderSection();
  expect(box("Send issue to agent").value).toBe(agentPrompt("issueAgent").defaultText);
  expect(screen.queryByText("Customized")).toBeNull();
  expect(screen.getByText(/BB_GITEA_AUTO_FIX: MERGED/)).toBeTruthy();
});

it("saves only the changed prompt", async () => {
  const updateSettings = renderSection();
  const { save } = buttonsFor("Send issue to agent");
  expect(save.disabled).toBe(true);
  fireEvent.change(box("Send issue to agent"), { target: { value: "Fix {ref}" } });
  await act(async () => fireEvent.click(save));
  expect(updateSettings).toHaveBeenCalledWith(
    expect.objectContaining({ values: { agentPrompts: '{\n  "issueAgent": "Fix {ref}"\n}' } }),
  );
  expect(screen.getByText("Customized")).toBeTruthy();
});

it("warns about unknown placeholders but still allows saving", () => {
  renderSection();
  fireEvent.change(box("Send issue to agent"), { target: { value: "Fix {reop}" } });
  expect(screen.getByRole("alert").textContent).toContain("{reop}");
  expect(buttonsFor("Send issue to agent").save.disabled).toBe(false);
});

it("resets a customized prompt and keeps the others", async () => {
  const updateSettings = renderSection({
    agentPrompts: JSON.stringify({ issueAgent: "Mine", prReview: "Review {ref}" }),
  });
  expect(box("Send issue to agent").value).toBe("Mine");
  expect(screen.getAllByText("Customized")).toHaveLength(2);
  await act(async () => fireEvent.click(buttonsFor("Send issue to agent").reset));
  expect(updateSettings).toHaveBeenCalledWith(
    expect.objectContaining({ values: { agentPrompts: '{\n  "prReview": "Review {ref}"\n}' } }),
  );
  expect(box("Send issue to agent").value).toBe(agentPrompt("issueAgent").defaultText);
});
