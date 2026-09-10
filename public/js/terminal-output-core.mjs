import { styleToElement } from './ansi.js';
import { createTerminalOutputModel } from './terminal-output-model.mjs';

const SCREEN_READER_DELAY_MS = 180;
const BOTTOM_THRESHOLD = 5;
const USER_SCROLL_INTENT_MS = 900;

/** One DOM-owned renderer for a terminal output model. */
export function createTerminalOutputCore({
  shell,
  output,
  historyOutput,
  liveOutput,
  divider,
  pauseButton,
  liveButton,
  clearButton,
  announcer,
  subscribeOutput,
  clearOutput,
  processLine,
  onOutputLine,
  onClear,
  onSplitRatioChange,
}) {
  const ownedModel = subscribeOutput
    ? null
    : createTerminalOutputModel({ processLine, onOutputLine, onClear });
  const model = ownedModel ?? { subscribe: subscribeOutput, clear: clearOutput };
  const pendingLines = new Map();
  // Latest record per line id, and the ids whose DOM is behind the model. A
  // streaming line is upserted once per ANSI fragment; painting it on the
  // next frame instead of per upsert turns that churn into one rebuild.
  const latestRecords = new Map();
  const dirtyRecords = new Map();
  const lineElements = new Map();
  const historyLineElements = new Map();
  const liveLineElements = new Map();
  let animationFrame = 0;
  let announceTimer = 0;
  let disposed = false;
  let paused = false;
  let navigationLocked = false;
  let targetLine = null;
  let targetOutput = output;
  let announceText = '';
  let screenReaderMode = false;
  let behavior = 'pause';
  let splitActive = false;
  let splitRatio = 0.6;
  let userScrollIntentUntil = 0;
  let dividerPointerId = null;

  const isAtBottom = (element) =>
    element.scrollTop + element.clientHeight >= element.scrollHeight - BOTTOM_THRESHOLD;
  const isSplitMode = () => behavior === 'split' && historyOutput && liveOutput;
  // The history and live copies of the stream only exist while the split
  // behaviour is on; the default pause behaviour keeps one DOM tree.
  const copiesActive = () => Boolean(isSplitMode());
  const clampSplitRatio = (value) => {
    const ratio = Number(value);
    return Number.isFinite(ratio) ? Math.max(0.2, Math.min(0.8, ratio)) : 0.6;
  };
  const syncControls = () => {
    shell.classList.toggle('paused', paused);
    shell.classList.toggle('split-active', splitActive);
    shell.style.setProperty('--output-split-ratio', `${splitRatio * 100}%`);
    pauseButton.setAttribute('aria-pressed', String(paused));
    pauseButton.title = paused ? 'Resume live terminal' : 'Pause live terminal';
    liveButton.title = splitActive ? 'Return to live terminal' : 'Live terminal';
  };
  const queueLine = (host, line) => {
    const lines = pendingLines.get(host) ?? [];
    if (!pendingLines.has(host)) pendingLines.set(host, lines);
    if (!lines.includes(line)) lines.push(line);
  };
  const renderPending = () => {
    if (animationFrame) {
      cancelAnimationFrame(animationFrame);
      animationFrame = 0;
    }
    if (dirtyRecords.size) {
      for (const record of dirtyRecords.values()) {
        for (const elements of [lineElements, historyLineElements, liveLineElements]) {
          const line = elements.get(record.id);
          if (line) paintLine(record, line);
        }
      }
      dirtyRecords.clear();
    }
    for (const [host, lines] of pendingLines) {
      if (!lines.length) continue;
      const fragment = document.createDocumentFragment();
      for (const line of lines.splice(0)) fragment.append(line);
      host.append(fragment);
    }
    pendingLines.clear();
    if (splitActive && liveOutput) liveOutput.scrollTop = liveOutput.scrollHeight;
    else if (!paused) output.scrollTop = output.scrollHeight;
  };
  const scheduleRender = () => {
    if (animationFrame || disposed) return;
    animationFrame = requestAnimationFrame(() => {
      animationFrame = 0;
      renderPending();
    });
  };
  const announce = (text) => {
    if (!screenReaderMode) return;
    announceText = `${announceText}${text}`.slice(-1000);
    if (announceTimer) return;
    announceTimer = window.setTimeout(() => {
      announceTimer = 0;
      announcer.textContent = announceText;
      announceText = '';
    }, SCREEN_READER_DELAY_MS);
  };
  const appendFragment = (line, fragment) => {
    if (!fragment.text) return;
    const rendered = styleToElement(fragment.text, fragment.style);
    if (!rendered) return;
    if (fragment.href) {
      const link = document.createElement('a');
      link.href = fragment.href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.append(rendered);
      line.append(link);
    } else {
      line.append(rendered);
    }
  };
  const paintLine = (record, line) => {
    line.className = `output-line${record.cssClass ? ` ${record.cssClass}` : ''}`;
    if (record.complete) line.dataset.lineId = String(record.id);
    else delete line.dataset.lineId;
    line.replaceChildren();
    for (const fragment of record.fragments) appendFragment(line, fragment);
  };
  // Creates the line element eagerly (so navigation can find it) and leaves
  // the content to the next frame's flush.
  const ensureLine = (record, elements, host) => {
    if (elements.has(record.id)) return;
    const line = document.createElement('div');
    elements.set(record.id, line);
    queueLine(host, line);
  };
  const renderRecord = (record) => {
    latestRecords.set(record.id, record);
    dirtyRecords.set(record.id, record);
    ensureLine(record, lineElements, output);
    if (copiesActive()) {
      ensureLine(record, historyLineElements, historyOutput);
      ensureLine(record, liveLineElements, liveOutput);
    }
  };
  // Builds or drops the split copies when the behaviour setting changes.
  const syncCopies = () => {
    if (copiesActive()) {
      if (historyLineElements.size || !latestRecords.size) return;
      for (const record of latestRecords.values()) {
        dirtyRecords.set(record.id, record);
        ensureLine(record, historyLineElements, historyOutput);
        ensureLine(record, liveLineElements, liveOutput);
      }
      scheduleRender();
      return;
    }
    if (!historyLineElements.size && !liveLineElements.size) return;
    for (const [host, elements] of [[historyOutput, historyLineElements], [liveOutput, liveLineElements]]) {
      pendingLines.delete(host);
      elements.clear();
      host?.replaceChildren();
    }
  };
  const removeRecord = (id) => {
    latestRecords.delete(id);
    dirtyRecords.delete(id);
    for (const elements of [lineElements, historyLineElements, liveLineElements]) {
      const line = elements.get(id);
      for (const lines of pendingLines.values()) {
        const index = lines.indexOf(line);
        if (index >= 0) lines.splice(index, 1);
      }
      line?.remove();
      elements.delete(id);
    }
  };
  const clearDom = () => {
    pendingLines.clear();
    latestRecords.clear();
    dirtyRecords.clear();
    lineElements.clear();
    historyLineElements.clear();
    liveLineElements.clear();
    for (const host of [output, historyOutput, liveOutput]) host?.replaceChildren();
    announcer.textContent = '';
    announceText = '';
    navigationLocked = false;
    targetLine?.classList.remove('output-line-mention-target');
    targetLine = null;
  };
  const handleModelEvent = (event) => {
    if (disposed) return;
    if (event.type === 'reset') {
      clearDom();
      for (const record of event.records) renderRecord(record);
      scheduleRender();
    } else if (event.type === 'upsert') {
      renderRecord(event.record);
      scheduleRender();
    } else if (event.type === 'remove') {
      removeRecord(event.id);
    } else if (event.type === 'clear') {
      clearDom();
    } else if (event.type === 'announce') {
      announce(event.text);
    }
  };
  const unsubscribe = model.subscribe(handleModelEvent);
  const clear = () => {
    if (!disposed) model.clear();
  };
  const deactivateSplit = () => {
    if (!splitActive) return;
    splitActive = false;
    userScrollIntentUntil = 0;
    syncControls();
    renderPending();
    output.scrollTop = output.scrollHeight;
  };
  const activateSplit = () => {
    if (splitActive || !isSplitMode()) return;
    const distanceFromBottom = output.scrollHeight - output.scrollTop - output.clientHeight;
    splitActive = true;
    paused = false;
    syncControls();
    renderPending();
    historyOutput.scrollTop = Math.max(
      0,
      historyOutput.scrollHeight - historyOutput.clientHeight - distanceFromBottom,
    );
    liveOutput.scrollTop = liveOutput.scrollHeight;
  };
  const returnToLive = () => {
    if (disposed) return false;
    if (splitActive) {
      deactivateSplit();
      return true;
    }
    const changed = paused || navigationLocked || targetLine !== null || !isAtBottom(output);
    targetLine?.classList.remove('output-line-mention-target');
    targetLine = null;
    navigationLocked = false;
    paused = false;
    userScrollIntentUntil = 0;
    syncControls();
    renderPending();
    output.scrollTop = output.scrollHeight;
    return changed;
  };
  const pause = () => {
    if (splitActive) deactivateSplit();
    else {
      paused = true;
      syncControls();
    }
  };
  const onScroll = () => {
    if (disposed || navigationLocked || splitActive) return;
    if (isSplitMode()) {
      if (!isAtBottom(output) && Date.now() <= userScrollIntentUntil) activateSplit();
      return;
    }
    paused = !isAtBottom(output);
    syncControls();
  };
  const onHistoryScroll = () => {
    if (!disposed && splitActive && isAtBottom(historyOutput)) deactivateSplit();
  };
  const markUserScrollIntent = () => {
    userScrollIntentUntil = Date.now() + USER_SCROLL_INTENT_MS;
  };
  const markScrollbarPointerIntent = (event) => {
    const target = event.currentTarget;
    const rect = target.getBoundingClientRect();
    const scrollbarWidth = Math.max(0, target.offsetWidth - target.clientWidth);
    if (event.clientX >= rect.right - Math.max(16, scrollbarWidth + 4)) {
      markUserScrollIntent();
    }
  };
  const onPauseClick = () => (paused || splitActive ? returnToLive() : pause());
  const onDividerDown = (event) => {
    dividerPointerId = event.pointerId;
    divider?.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  };
  const onDividerMove = (event) => {
    if (event.pointerId !== dividerPointerId) return;
    const rect = shell.getBoundingClientRect();
    if (rect.height <= 10) return;
    splitRatio = clampSplitRatio((event.clientY - rect.top) / (rect.height - 10));
    syncControls();
  };
  const onDividerEnd = (event) => {
    if (event.pointerId !== dividerPointerId) return;
    divider?.releasePointerCapture?.(dividerPointerId);
    dividerPointerId = null;
    onSplitRatioChange?.(splitRatio);
  };

  pauseButton.addEventListener('click', onPauseClick);
  liveButton.addEventListener('click', returnToLive);
  clearButton.addEventListener('click', clear);
  output.addEventListener('scroll', onScroll);
  output.addEventListener('wheel', markUserScrollIntent, { passive: true });
  output.addEventListener('touchstart', markUserScrollIntent, { passive: true });
  output.addEventListener('pointerdown', markScrollbarPointerIntent);
  historyOutput?.addEventListener('scroll', onHistoryScroll);
  if (divider) {
    divider.addEventListener('pointerdown', onDividerDown);
    window.addEventListener('pointermove', onDividerMove);
    window.addEventListener('pointerup', onDividerEnd);
    window.addEventListener('pointercancel', onDividerEnd);
  }
  syncControls();

  return {
    appendOutput: model.appendOutput,
    appendSystemMessage: model.appendSystemMessage,
    clear,
    configure({ scrollbackBehavior, scrollbackSplitRatio, screenReaderMode: nextScreenReaderMode } = {}) {
      behavior = scrollbackBehavior === 'split' ? 'split' : 'pause';
      syncCopies();
      splitRatio = clampSplitRatio(scrollbackSplitRatio);
      screenReaderMode = nextScreenReaderMode === true;
      if (!screenReaderMode) {
        if (announceTimer) window.clearTimeout(announceTimer);
        announceTimer = 0;
        announceText = '';
        announcer.textContent = '';
      }
      if (!isSplitMode()) deactivateSplit();
      syncControls();
    },
    focus: () => output.focus({ preventScroll: true }),
    isLineAvailable: (id) => Number.isSafeInteger(id) && lineElements.has(id),
    navigateToLine: (id) => {
      if (disposed || !Number.isSafeInteger(id)) return false;
      const elements = splitActive ? historyLineElements : lineElements;
      const target = splitActive ? historyOutput : output;
      renderPending();
      const line = elements.get(id);
      if (!line || line.dataset.lineId === undefined) return false;
      targetLine?.classList.remove('output-line-mention-target');
      targetLine = line;
      targetOutput = target;
      targetLine.classList.add('output-line-mention-target');
      navigationLocked = true;
      paused = !splitActive;
      syncControls();
      const lineTop =
        line.getBoundingClientRect().top - target.getBoundingClientRect().top + target.scrollTop;
      target.scrollTop = Math.max(0, lineTop - Math.round(target.clientHeight * 0.35));
      return true;
    },
    returnToLive,
    snapshot: () => ({ buffer: targetOutput.textContent ?? '', scrollTop: targetOutput.scrollTop }),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      if (animationFrame) cancelAnimationFrame(animationFrame);
      if (announceTimer) window.clearTimeout(announceTimer);
      pauseButton.removeEventListener('click', onPauseClick);
      liveButton.removeEventListener('click', returnToLive);
      clearButton.removeEventListener('click', clear);
      output.removeEventListener('scroll', onScroll);
      output.removeEventListener('wheel', markUserScrollIntent);
      output.removeEventListener('touchstart', markUserScrollIntent);
      output.removeEventListener('pointerdown', markScrollbarPointerIntent);
      userScrollIntentUntil = 0;
      historyOutput?.removeEventListener('scroll', onHistoryScroll);
      if (divider) {
        divider.removeEventListener('pointerdown', onDividerDown);
        window.removeEventListener('pointermove', onDividerMove);
        window.removeEventListener('pointerup', onDividerEnd);
        window.removeEventListener('pointercancel', onDividerEnd);
      }
      clearDom();
      ownedModel?.dispose();
    },
  };
}
