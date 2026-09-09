# Performance notes

What has been measured about the client's main-thread cost, and the rules
that fell out of it. Measurements come from a headless Chromium (Edge) run
driven by Playwright with the CDP profiler attached, against a stand-in MUD
sending forty coloured lines and ten GMCP frames a second for twenty seconds.
Headless has no vsync, so frame counts are inflated; ratios between runs are
what matter.

## Findings, in order of cost

1. **Bar fills animated `width`.** A CSS transition on `width` forces a layout
   on every frame while it runs, and in a fight vitals arrive often enough
   that a bar is always mid-transition. With nothing but vitals flowing the
   renderer laid out once per frame. Fills now animate `transform: scaleX()`
   with `transform-origin` on the left (right for danger-when-full meters).
   Layouts per frame fell from one to roughly one in fourteen.
2. **The terminal kept three DOM copies of every line.** The history and live
   copies for the split scrollback were maintained even under the default
   pause behaviour, and every streaming line was rebuilt once per ANSI
   fragment into all three. The copies now exist only while the split
   behaviour is on, and line content is painted once per frame from a dirty
   set. Steady-state DOM size fell by about two thirds.
3. **The Scene loop read layout every frame.** The stage's tick read the
   pane's client size, forcing the terminal's pending layout early. The size
   is cached by the resize observer and the tick trusts it.
4. **GMCP variable flattening was quadratic in payload depth.** Both the
   session runtime and the legacy `gmcp-variables.js` re-normalised the whole
   variable path with three regexes at every node. Segment normalisation is
   memoised and names are built incrementally on the way down. A 600-item
   `Char.Items.List` frame went from about forty milliseconds to about
   thirteen. The two flatteners still both run; see below.
5. **Highlights compared styles by `JSON.stringify`, per character.** Replaced
   with a field comparison, and compiled highlight and trigger patterns are
   cached per definition object. The automation module also caches the
   derived definition lists between configuration changes instead of
   rebuilding them per line.
6. **Every information panel redrew on every publish.** Snapshots keep
   unchanged slices by reference, so a panel now skips its `innerHTML`
   rebuild when its slice is the same object or shallow-equal.
7. **`deepFreeze` re-walked already-frozen subtrees** on every snapshot
   publish; it remembers what it has frozen. The GMCP diagnostics recorder,
   which hears every frame, keeps a plain ring and builds its frozen snapshot
   only when something reads it. The transport reuses one `TextEncoder`.

## Results

Renderer busy time under the standard load, default layout: 49% before, 21%
after. With the Scene and a vital bar open at three times the text rate: 67%
before, 32% after. Long tasks from large payloads: a 58 KB inventory frame
took 52 ms in the handler before the flattener change.

## Rules of thumb

- Never transition `width`, `height`, `top`, or `left` on something that
  updates on a timer or a stream. Use `transform` or `clip-path`.
- Anything that runs per frame must not read layout (`clientWidth`,
  `scrollHeight`, `getBoundingClientRect`). Cache it from a resize observer.
- Per-line and per-packet code paths should not allocate per character or
  serialise for comparison. Cache compiled patterns by definition identity.
- A subscriber to a snapshot should compare its own slice by reference before
  redrawing.

## GMCP variables are flattened on read

Every frame used to be flattened into automation variables twice: once by
the session's own wildcard handler and once through the legacy compat bridge
(`registerGmcpVariables` in `public/js/gmcp-variables.js`, which the
bootstrap also registers on the bus). Under the dev server the two are even
different module instances, because imports from TypeScript get a `?import`
copy while the legacy graph loads the plain URL, so the legacy copy flattened
into a map only it could see.

Both flatteners now queue the latest payload per package and flatten when
the variables are read: when an alias, trigger, or function expands, or the
settings dialog lists them. Duplicate deliveries of one frame collapse to a
single queue entry, a fight's worth of frames nobody read costs nothing, and
the wiring is unchanged. The one semantic difference: if a package arrives
twice before a read, keys present only in the older payload are not kept.

## Still open

- `Char.Vitals` fans out to every information panel, the combat, audio,
  notifications, and visual-effects runtimes, and the legacy panel manager.
  Panels now skip unchanged slices, but the runtimes still rebuild and freeze
  whole snapshots per frame.
- The inventory panel rebuilds its full list through `innerHTML` whenever the
  list changes; a keyed diff would help players with large inventories.
- The stand-in dev server run and `npm test` contend for CPU; the dev-server
  integration test resets its connection under that load and passes alone.
