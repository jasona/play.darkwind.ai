import type { AutomationStep, ConfigKind, TimerDefinition } from "../model/configuration";
import { parseAutofishLine } from "../runtime/fishing-auto";
import type { Session } from "../runtime/session";

// @ts-expect-error Shared legacy/Phase 2 executor core is JavaScript.
import * as automationExecutor from "../../public/js/automation-executor-core.mjs";
// @ts-expect-error Shared definition runtime core is JavaScript.
import * as definitionRuntime from "../../public/js/definition-runtime-core.mjs";
// @ts-expect-error Shared sound catalog is JavaScript.
import { isKnownSound } from "../../public/js/sound-manager.js";

const {
  applyHighlightDefinitionsToLine,
  evaluateTriggerDefinitions,
  matchAliasDefinitions,
  resolveDefinitionTemplate,
} = definitionRuntime;
const { executeAliasLine, executeAutomationSteps, executeTriggerMatches } = automationExecutor;

type DefinitionKind = Extract<ConfigKind, "aliases" | "triggers" | "functions" | "timers">;
export type TerminalOutputFragment = {
  text: string;
  style: Record<string, unknown>;
  href?: string | null;
};

/** One session-scoped consumer of the frozen effective definitions. */
export function createTerminalAutomation({
  session,
  appendSystemMessage,
}: {
  session: Session;
  appendSystemMessage: (text: string) => void;
}): {
  sendCommand(text: string): boolean;
  getMappedCommand(event: KeyboardEvent): string | null;
  processLine(
    text: string,
    fragments: TerminalOutputFragment[],
  ): { fragments: TerminalOutputFragment[]; gag: boolean };
  dispose(): void;
} {
  const scopeKey = session.characterProfileId;
  const runtime = session.terminal.automation;
  const enabledOverrides = new Map<string, boolean>();
  const timerSignatures = new Map<string, string>();
  let snapshot = session.getEffectiveConfiguration();
  let disposed = false;

  // Per-line work reads the trigger and highlight lists on every completed
  // line; rebuilding them each time also gave the pattern cache a fresh object
  // to miss on. They are derived once per configuration or override change.
  const deriveDefinitions = (kind: DefinitionKind) =>
    snapshot[kind].map(({ definition }) => ({
      ...definition,
      enabled: enabledOverrides.get(`${kind}:${definition.id}`) ?? definition.enabled,
    }));
  type DerivedDefinitions = ReturnType<typeof deriveDefinitions>;
  let definitionCache = new Map<DefinitionKind, DerivedDefinitions>();
  let highlightDefinitions: (typeof snapshot.highlights)[number]["definition"][] | null = null;
  const invalidateDefinitions = (): void => {
    definitionCache = new Map();
    highlightDefinitions = null;
  };
  const definitions = (kind: DefinitionKind): DerivedDefinitions => {
    const cached = definitionCache.get(kind);
    if (cached) return cached;
    const derived = deriveDefinitions(kind);
    definitionCache.set(kind, derived);
    return derived;
  };
  const highlights = () =>
    (highlightDefinitions ??= snapshot.highlights.map(({ definition }) => definition));
  const findById = (kind: DefinitionKind, id: string) =>
    definitions(kind).find((definition) => definition.id === String(id || "")) ?? null;
  const findByName = (kind: DefinitionKind, value: string) => {
    const needle = String(value || "")
      .trim()
      .toLowerCase();
    return (
      definitions(kind).find((definition) => {
        const name =
          "trigger" in definition
            ? definition.trigger
            : "pattern" in definition
              ? definition.pattern
              : definition.name;
        return String(name).trim().toLowerCase() === needle;
      }) ?? null
    );
  };
  const setEnabled = (
    kind: DefinitionKind,
    definition: { id: string } | null,
    enabled: boolean,
  ) => {
    if (!definition) return { target: null, enabled: null };
    enabledOverrides.set(`${kind}:${definition.id}`, enabled);
    invalidateDefinitions();
    if (kind === "timers" && !enabled) runtime.clearTimer(definition.id);
    return { target: { ...definition, enabled }, enabled };
  };
  const manager = (kind: DefinitionKind) => ({
    findById: (id: string) => findById(kind, id),
    findByTarget: (target: string) => findByName(kind, target),
    setEnabledById(id: string, enabled: boolean) {
      return setEnabled(kind, findById(kind, id), enabled);
    },
    setEnabledByTarget(target: string, enabled: boolean) {
      return setEnabled(kind, findByName(kind, target), enabled);
    },
    toggleEnabledById(id: string) {
      const definition = findById(kind, id);
      return setEnabled(kind, definition, definition?.enabled === false);
    },
    toggleEnabledByTarget(target: string) {
      const definition = findByName(kind, target);
      return setEnabled(kind, definition, definition?.enabled === false);
    },
  });

  const aliasBase = manager("aliases");
  const triggerBase = manager("triggers");
  const functionBase = manager("functions");
  const timerBase = manager("timers");
  const aliasRuntime = {
    ...aliasBase,
    getActiveScopeKey: () => scopeKey,
    getMaxAliasDepth: () => 10,
    matchAlias: (text: string) => matchAliasDefinitions(text, definitions("aliases")),
    resolveTemplate: resolveDefinitionTemplate,
    getAutomationVariables: () => runtime.getAutomationVariables(),
    setVariable: (name: string, value: string) => runtime.setVariable(name, value),
  };
  const triggerRuntime = {
    ...triggerBase,
  };
  const functionRuntime = {
    ...functionBase,
    findFunctionById: functionBase.findById,
    findFunctionByName: functionBase.findByTarget,
    getMaxFunctionDepth: () => 10,
  };
  const playSound = (step: Extract<AutomationStep, { type: "play_sound" }>): boolean =>
    !disposed &&
    isKnownSound(step.category, step.sound) &&
    session.audio.playLocal(step.category, step.sound, step.volume);

  const context = () => ({
    managers: {
      alias: aliasRuntime,
      trigger: triggerRuntime,
      timer: timerRuntime,
      function: functionRuntime,
    },
    appendMessage: appendSystemMessage,
    sendCommand: (text: string) => session.terminal.sendCommand(text),
    scopeKey,
    scheduleWait: (delayMs: number) => runtime.scheduleWait(delayMs),
    playSound,
  });
  const executeTimer = (timer: TimerDefinition) => {
    if (disposed || timer.enabled === false) return;
    const result = executeAutomationSteps(timer.steps, {
      ...context(),
      templateContext: {
        args: [timer.name],
        remainder: timer.name,
        variables: runtime.getAutomationVariables(),
      },
      source: { prefix: "Timer", description: `timer "${timer.name}"` },
      aliasContext: { depth: 0, trail: [] },
    });
    const reschedule = () => {
      const current = findById("timers", timer.id) as TimerDefinition | null;
      if (!disposed && current?.enabled !== false && current?.recurring) startTimer(current);
    };
    if (result?.completion) result.completion.finally(reschedule);
    else reschedule();
  };
  const startTimer = (timer: TimerDefinition) => {
    if (!timer || timer.enabled === false) return { target: timer ?? null, running: false };
    runtime.scheduleTimer(timer.id, timer.durationMs, () => executeTimer(timer));
    return { target: timer, running: true };
  };
  const timerRuntime = {
    ...timerBase,
    findTimerById: timerBase.findById,
    findTimerByName: timerBase.findByTarget,
    startTimerById(id: string) {
      return startTimer(findById("timers", id) as TimerDefinition);
    },
    startTimerByName(name: string) {
      return startTimer(findByName("timers", name) as TimerDefinition);
    },
    stopTimerById(id: string) {
      const timer = findById("timers", id) as TimerDefinition | null;
      if (timer) runtime.clearTimer(timer.id);
      return { target: timer, running: false };
    },
    stopTimerByName(name: string) {
      const timer = findByName("timers", name) as TimerDefinition | null;
      return this.stopTimerById(timer?.id ?? "");
    },
    resetTimerById(id: string) {
      return this.startTimerById(id);
    },
    resetTimerByName(name: string) {
      return this.startTimerByName(name);
    },
    runTimerById(id: string) {
      const timer = findById("timers", id) as TimerDefinition | null;
      if (timer && timer.enabled !== false) executeTimer(timer);
      return { target: timer, running: Boolean(timer && runtime.getTimerRuntimeState(timer.id)) };
    },
    runTimerByName(name: string) {
      const timer = findByName("timers", name) as TimerDefinition | null;
      return this.runTimerById(timer?.id ?? "");
    },
  };

  const reconcileTimers = () => {
    const timers = definitions("timers") as TimerDefinition[];
    const timersById = new Map(timers.map((timer) => [timer.id, timer]));
    for (const [timerId, signature] of timerSignatures) {
      const timer = timersById.get(timerId);
      if (!timer || JSON.stringify(timer) !== signature) runtime.clearTimer(timerId);
      if (!timer) timerSignatures.delete(timerId);
    }
    for (const timer of timers) timerSignatures.set(timer.id, JSON.stringify(timer));
    runtime.reconcileTimers(timers, (timer) => startTimer(timer as TimerDefinition));
  };
  const unsubscribeConfiguration = session.terminal.subscribeConfiguration((next) => {
    snapshot = next;
    enabledOverrides.clear();
    invalidateDefinitions();
    reconcileTimers();
  });
  const sendCommand = (text: string): boolean => {
    // The Auto-Angler's slash command is session state, not an alias, so it
    // is answered here before the alias engine sees the line.
    const autofishArgs = parseAutofishLine(text);
    if (autofishArgs) {
      session.fishingAuto.handleCommand(autofishArgs);
      return true;
    }
    const result = executeAliasLine(text, { ...context(), isRoot: true });
    return Boolean(result.sent || result.localOnly || result.handled);
  };

  return {
    sendCommand,
    getMappedCommand(event) {
      if (event.defaultPrevented || event.repeat) return null;
      const mapping = [...snapshot.keyMappings]
        .reverse()
        .map(({ definition }) => definition)
        .find(
          (definition) =>
            definition.enabled &&
            definition.command &&
            (definition.legacyKey
              ? definition.legacyKey === event.key &&
                (definition.code === event.code || definition.code === definition.legacyKey)
              : definition.code === event.code),
        );
      return mapping?.command ?? null;
    },
    processLine(text, fragments) {
      if (disposed) return { fragments, gag: false };
      const result = evaluateTriggerDefinitions(text, definitions("triggers"));
      executeTriggerMatches(result.matches, scopeKey, context());
      return {
        fragments: applyHighlightDefinitionsToLine({ text, fragments }, highlights()).fragments,
        gag: result.gag,
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribeConfiguration();
      for (const { definition } of snapshot.timers) runtime.clearTimer(definition.id);
      enabledOverrides.clear();
      timerSignatures.clear();
    },
  };
}
