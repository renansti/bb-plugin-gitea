import { useEffect, useMemo, useState } from "react";
import { experimental_usePluginId, useSdk, useSettings } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  agentPrompt,
  autoFixerProtocol,
  formatPromptOverrides,
  parsePromptOverrides,
  promptText,
  unknownPlaceholders,
  type AgentPromptId,
  type AgentPromptOverrides,
} from "./agent-prompts.js";

const groups: { title: string; ids: AgentPromptId[]; protocol?: boolean }[] = [
  {
    title: "Auto-fixer",
    ids: ["autoFixer", "autoFixOn", "autoFixOff", "autoMergeOn", "autoMergeOff"],
    protocol: true,
  },
  { title: "Send to agent", ids: ["issueAgent", "prReview"] },
];

function PromptEditor({
  id,
  overrides,
  onSave,
}: {
  id: AgentPromptId;
  overrides: AgentPromptOverrides;
  onSave: (next: AgentPromptOverrides) => Promise<void>;
}) {
  const definition = agentPrompt(id);
  const saved = promptText(overrides, id);
  const customized = saved !== definition.defaultText;
  const [draft, setDraft] = useState(saved);
  const [saving, setSaving] = useState(false);
  useEffect(() => setDraft(saved), [saved]);
  const unknown = useMemo(
    () => unknownPlaceholders(draft, definition.placeholders),
    [draft, definition.placeholders],
  );
  const save = async (text: string) => {
    setSaving(true);
    try {
      await onSave({ ...overrides, [id]: text });
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <label htmlFor={`prompt-${id}`} className="text-sm font-medium">
          {definition.label}
        </label>
        {customized && <Badge variant="secondary">Customized</Badge>}
      </div>
      <p className="text-xs text-muted-foreground">{definition.description}</p>
      <Textarea
        id={`prompt-${id}`}
        value={draft}
        rows={Math.min(20, draft.split("\n").length + 1)}
        className="font-mono text-xs"
        onChange={(event) => setDraft(event.target.value)}
      />
      <p className="text-xs text-muted-foreground">
        Placeholders:{" "}
        {definition.placeholders.map((name) => (
          <code key={name} className="mr-1">{`{${name}}`}</code>
        ))}
      </p>
      {unknown.length > 0 && (
        <p role="alert" className="text-xs text-destructive">
          Unknown {unknown.length === 1 ? "placeholder" : "placeholders"}:{" "}
          {unknown.map((name) => `{${name}}`).join(", ")}. The text is sent as written.
        </p>
      )}
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={saving || draft === saved}
          onClick={() => void save(draft)}
        >
          Save
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={saving || (!customized && draft === saved)}
          onClick={() => {
            setDraft(definition.defaultText);
            void save(definition.defaultText);
          }}
        >
          Reset to default
        </Button>
      </div>
    </div>
  );
}

/** Edits the prompts the plugin sends to agents, on BB's settings page for the plugin. */
export function AgentPromptSettings() {
  const sdk = useSdk();
  const pluginId = experimental_usePluginId();
  const raw = useSettings().values?.agentPrompts;
  const [pending, setPending] = useState<string | null>(null);
  useEffect(() => setPending(null), [raw]);
  const stored = pending ?? (typeof raw === "string" ? raw : "");
  const overrides = useMemo(() => parsePromptOverrides(stored), [stored]);
  const onSave = async (next: AgentPromptOverrides) => {
    const value = formatPromptOverrides(next);
    setPending(value);
    try {
      await sdk.plugins.updateSettings({ pluginId, values: { agentPrompts: value } });
    } catch (error) {
      setPending(null);
      toast.error(error instanceof Error ? error.message : "Could not save the prompt");
    }
  };
  return (
    <div className="flex flex-col gap-8">
      {groups.map((group) => (
        <section key={group.title} className="flex flex-col gap-5">
          <h3 className="text-sm font-semibold">{group.title}</h3>
          {group.ids.map((id) => (
            <PromptEditor key={id} id={id} overrides={overrides} onSave={onSave} />
          ))}
          {group.protocol && (
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium">Always added</span>
              <p className="text-xs text-muted-foreground">
                The plugin adds this text after the auto-fixer prompt and cannot be changed. It
                needs the wait command and the end markers to track each auto-fixer.{" "}
                <code>{"{autoFixRules}"}</code> and <code>{"{autoMergeRules}"}</code> take the
                rules that match the current switches.
              </p>
              <pre className="whitespace-pre-wrap rounded-md border border-border bg-muted p-3 font-mono text-xs text-muted-foreground">
                {autoFixerProtocol}
              </pre>
            </div>
          )}
        </section>
      ))}
    </div>
  );
}
