<script lang="ts">
  import { onMount } from "svelte";
  import type { Readable } from "svelte/store";
  import type { Session } from "../runtime/session.ts";
  import { loadClientSettings, saveClientSettings } from "../app/client-settings.ts";
  import { createTerminalInputController } from "../terminal/input-controller.ts";
  // @ts-expect-error Retained preset constants are JavaScript without declarations.
  import { OUTPUT_SCROLLBACK_PRESETS } from "../../public/js/constants.js";
  // @ts-expect-error The reusable imperative terminal core is legacy JavaScript.
  import { createTerminalOutputCore } from "../../public/js/terminal-output-core.mjs";
  import {
    createTerminalIsland,
    registerTerminalIsland,
    type TerminalIsland,
  } from "./terminal-island";
  import type { PanelState } from "./workspace";

  let {
    panelId,
    state: panelState,
    session,
    registerLineNavigator,
  }: {
    panelId: string;
    state: Readable<PanelState>;
    session?: Session;
    registerLineNavigator?: (navigate: (lineId: number) => boolean) => (() => void) | void;
  } = $props();
  let host = $state<HTMLElement>();
  let output = $state<HTMLElement>();
  let historyOutput = $state<HTMLElement>();
  let liveOutput = $state<HTMLElement>();
  let divider = $state<HTMLElement>();
  let commandInput = $state<HTMLInputElement>();
  let sendButton = $state<HTMLButtonElement>();
  let batchDialog = $state<HTMLDialogElement>();
  let batchInput = $state<HTMLTextAreaElement>();
  let batchForm = $state<HTMLFormElement>();
  let island: TerminalIsland | undefined;

  function focusCommandInput(event: MouseEvent): void {
    if (!(event.target instanceof HTMLElement)) return;
    const clickedOutput = event.target.closest(".terminal-output");
    if (!clickedOutput) return;
    const selection = window.getSelection();
    if (!selection?.toString() || !clickedOutput.contains(selection.anchorNode)) {
      commandInput?.focus();
    }
  }

  onMount(() => {
    if (!host) return;
    if (!session) {
      island = createTerminalIsland(host, panelId);
      let previousBuffer: string | undefined;
      let previousAppend: unknown;
      const unsubscribe = panelState.subscribe((value) => {
        const candidate = value.buffer ?? value.output ?? value.text;
        const buffer = Array.isArray(candidate) ? candidate.join("\n") : candidate;
        if (typeof buffer === "string" && buffer !== previousBuffer) {
          island?.replace?.(buffer);
          previousBuffer = buffer;
        }
        if (typeof value.append === "string" && value.append !== previousAppend) {
          island?.append?.(value.append);
          previousAppend = value.append;
        }
      });
      return () => {
        unsubscribe();
        island?.dispose();
        island = undefined;
      };
    }
    if (!output || !commandInput || !sendButton || !batchDialog || !batchInput || !batchForm)
      return;
    const outputShell = output.parentElement!;
    island = registerTerminalIsland(output, panelId);
    const terminal = createTerminalOutputCore({
      shell: output.parentElement!,
      output,
      historyOutput,
      liveOutput,
      divider,
      pauseButton: output.parentElement!.querySelector<HTMLButtonElement>("[data-action=pause]")!,
      liveButton: output.parentElement!.querySelector<HTMLButtonElement>("[data-action=live]")!,
      clearButton: output.parentElement!.querySelector<HTMLButtonElement>("[data-action=clear]")!,
      announcer: output.parentElement!.querySelector<HTMLElement>(
        "[data-testid=terminal-announcer]",
      )!,
      subscribeOutput: session.terminal.subscribeOutput,
      clearOutput: session.terminal.clearOutput,
      onSplitRatioChange: (scrollbackSplitRatio: number) => {
        const settings = loadClientSettings(localStorage).settings;
        settings.scrollbackSplitRatio = scrollbackSplitRatio;
        saveClientSettings(localStorage, settings, session.configuration.getSnapshot().themeKey);
      },
    });
    const applyTerminalSettings = () => {
      const settings = loadClientSettings(localStorage).settings;
      terminal.configure(settings);
      session.terminal.setOutputRecordLimit(
        OUTPUT_SCROLLBACK_PRESETS[settings.outputScrollbackPreset],
      );
    };
    let geometryFrame = 0;
    let characterWidth = 0;
    let lineHeight = 0;
    const updateGeometry = () => {
      geometryFrame = 0;
      if (!output) return;
      const activeOutput =
        output.parentElement?.classList.contains("split-active") && liveOutput
          ? liveOutput
          : output;
      const rect = activeOutput.getBoundingClientRect();
      const style = getComputedStyle(activeOutput);
      const probe = document.createElement("span");
      probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre";
      probe.textContent = "MMMMMMMMMM";
      activeOutput.append(probe);
      characterWidth = probe.getBoundingClientRect().width / 10;
      lineHeight = probe.getBoundingClientRect().height;
      probe.remove();
      if (!characterWidth || !lineHeight) return;
      const settings = loadClientSettings(localStorage).settings;
      const width =
        settings.terminalWidthColumns ??
        Math.max(
          40,
          Math.floor(
            (rect.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)) /
              characterWidth,
          ),
        );
      const height = Math.max(
        8,
        Math.floor(
          (rect.height - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)) /
            lineHeight,
        ),
      );
      session.terminal.updateGeometry(width, height);
    };
    const scheduleGeometry = () => {
      if (!geometryFrame) geometryFrame = requestAnimationFrame(updateGeometry);
    };
    const geometryObserver = new ResizeObserver(scheduleGeometry);
    geometryObserver.observe(output);
    geometryObserver.observe(output.parentElement!);
    if (liveOutput) geometryObserver.observe(liveOutput);
    applyTerminalSettings();
    scheduleGeometry();
    const refreshTerminalSettings = () => {
      applyTerminalSettings();
      scheduleGeometry();
    };
    window.addEventListener("darkflow:client-settings-changed", refreshTerminalSettings);
    const unregisterLineNavigator = registerLineNavigator?.(terminal.navigateToLine);
    const input = createTerminalInputController({
      session,
      input: commandInput,
      sendButton,
      output,
      batchDialog,
      batchInput,
      batchForm,
      appendEcho: (text) => session.terminal.appendOutput(`> ${text}\n`, "echo-line"),
      appendSystemMessage: session.terminal.appendSystemMessage,
      executeCommand: session.terminal.executeCommand,
      getMappedCommand: session.terminal.getMappedCommand,
      returnOutputToLive: terminal.returnToLive,
    });
    outputShell.addEventListener("click", focusCommandInput);

    return () => {
      window.removeEventListener("darkflow:client-settings-changed", refreshTerminalSettings);
      outputShell.removeEventListener("click", focusCommandInput);
      geometryObserver.disconnect();
      if (geometryFrame) cancelAnimationFrame(geometryFrame);
      unregisterLineNavigator?.();
      input.dispose();
      terminal.dispose();
      island?.dispose();
      island = undefined;
    };
  });
</script>

<section
  bind:this={host}
  class="phase0-terminal-panel"
  data-panel-id={panelId}
  data-workspace-owned="true"
  data-tutorial-target="terminal"
>
  {#if session}
    <div class="terminal-output-shell">
      <div class="terminal-controls">
        <button data-action="live" type="button" title="Return to live terminal">Live</button>
        <button data-action="pause" type="button" aria-pressed="false">Paused</button>
        <button data-action="clear" type="button">Clear</button>
      </div>
      <div
        bind:this={output}
        class="terminal-output"
        aria-label="Terminal output"
        tabindex="-1"
      ></div>
      <div class="terminal-output-split">
        <div
          bind:this={historyOutput}
          class="terminal-output terminal-history-output"
          aria-label="Scrollback history"
          tabindex="-1"
        ></div>
        <div
          bind:this={divider}
          class="terminal-output-divider"
          role="separator"
          aria-label="Resize terminal history"
          aria-orientation="horizontal"
        ></div>
        <div
          bind:this={liveOutput}
          class="terminal-output terminal-live-output"
          aria-label="Live output"
          tabindex="-1"
        ></div>
      </div>
      <div class="terminal-input-bar">
        <input
          bind:this={commandInput}
          aria-label="Command input"
          autocomplete="off"
          autocapitalize="off"
          autocorrect="off"
          placeholder="Enter command..."
          spellcheck="false"
          data-tutorial-target="command-input"
        />
        <button bind:this={sendButton} type="button">Send</button>
      </div>
      <dialog bind:this={batchDialog} aria-label="Multiline command input">
        <form bind:this={batchForm} method="dialog">
          <label>
            Command batch
            <textarea bind:this={batchInput} autocomplete="off" spellcheck="false"></textarea>
          </label>
          <div class="terminal-batch-actions">
            <button type="button" onclick={() => batchDialog?.close()}>Cancel</button>
            <button type="submit">Send batch</button>
          </div>
        </form>
      </dialog>
      <div
        data-testid="terminal-announcer"
        class="sr-only"
        aria-live="polite"
        aria-atomic="false"
      ></div>
    </div>
  {/if}
</section>

<style>
  .phase0-terminal-panel {
    height: 100%;
    min-height: 0;
    overflow: hidden;
  }

  .terminal-output-shell {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    background: rgb(0 0 0 / var(--df-terminal-background-alpha, 1));
    overflow: hidden;
  }

  .terminal-output {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 8px 12px;
    color: #c9d1d9;
    font-family: var(--df-terminal-font-family, var(--df-font-mono, monospace));
    font-size: var(--df-terminal-font-size, inherit);
    line-height: 1.4;
    white-space: pre-wrap;
    overflow-wrap: break-word;
  }

  .terminal-output-split {
    display: none;
    flex: 1;
    flex-direction: column;
    min-height: 0;
  }

  :global(.terminal-output-shell.split-active > .terminal-output) {
    display: none;
  }

  :global(.terminal-output-shell.split-active) .terminal-output-split {
    display: flex;
  }

  .terminal-history-output {
    flex: 0 0 calc(var(--output-split-ratio, 60%) - 5px);
  }

  .terminal-live-output {
    flex: 1 1 0;
  }

  .terminal-output-divider {
    flex: 0 0 10px;
    background: linear-gradient(
      to bottom,
      transparent 3px,
      var(--df-border-muted, #484f58) 3px 7px,
      transparent 7px
    );
    cursor: row-resize;
    touch-action: none;
  }

  .terminal-controls {
    display: flex;
    gap: 0.5rem;
    flex: 0 0 auto;
    padding: 0.5rem;
    background: var(--df-panel, #161b22);
  }

  .terminal-input-bar,
  .terminal-batch-actions {
    display: flex;
    gap: 0.5rem;
    padding: 0.5rem;
  }

  .terminal-input-bar input,
  dialog textarea {
    flex: 1;
    min-width: 0;
  }

  dialog textarea {
    display: block;
    min-height: 8rem;
    width: 100%;
  }
</style>
