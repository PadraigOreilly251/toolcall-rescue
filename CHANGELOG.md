# Changelog

Notable changes to `toolcall-rescue`, newest first. The version stamp shown
by `/rescue` status and in the `loaded v...` stderr line tracks these
entries. Dates are the dates the change was made in production (UTC);
session references are deliberately date + model + shape only — no session
ids or payloads in a public repo.

Hygiene note (as with every file in this repo): no contiguous instance of
the detection marker appears below; "tool-call markup", "opening envelope",
and "close" refer to the Qwen3-Coder-family XML tags.

## [0.3.6] — 2026-11-08

The rescue itself was eating legitimate answers. This is the first release where the
extension, not the model, was the cause of lost content.

### Fixed

- **(C6) Closed-pair rule.** A tail that closes its own opening envelope is
  **complete content**, not a truncation. The malformed-tail test had been treating
  the *presence* of a close tag as evidence of leaked markup. A quoted, well-formed
  JSON-bodied Hermes example does not match the `<function=…>` grammar, so it fell
  to the partial-tail branch, and everything from the last opening envelope to
  end-of-reply was cut — the example **plus all the prose that followed it**.
  - Observed twice on 2026-11-08. A technical report that *documented* the
    tool-call wire format lost its final 5,346 characters and received a nudge
    asserting its reply "ended with a tool call" — a claim that was false, and
    which the model correctly pushed back on before repeating itself into the same
    cut.
  - The rule now: **truncation is the absence of a close tag, not the presence of
    one.** The bound stays the *last* opening envelope, so a closed example followed
    by a genuine unclosed leak still sanitizes.
  - Applied to both dialects through a new required `close` field on the dialect
    record, rather than by special-casing one grammar.
  - Net effect: rescue keeps its full reach over real leaks and loses the false
    positives that destroyed real work.

### Tests

- 6 new C6 checks (64 → 70), covering: cited closed example, closed example at
  end of reply, bare closed pair with trailing prose, unclosed leak still caught,
  closed example followed by unclosed leak still caught, and the same rule for the
  Anthropic-style dialect.
- Red→green proven by removing the rule and observing exactly the 3 false-positive
  checks fail while the 3 true-positive checks stay green — i.e. the new tests
  discriminate the change rather than merely passing under it.

## [0.3.5] — 2026-11-01

A third death class, one notch removed from leaked markup: the model never emits
markup at all. The turn ends **inside its own reasoning** and the harness sees a
clean stop with no content.

### Added

- **(C5) Thinking-only dead turn with no marker evidence.** A reasoning model can
  stop inside its thinking without ever writing a tool-call marker. Observed in the
  wild when the model *quotes* a literal end-of-turn control token in its
  reasoning: the tokenizer turns the quote into the real end token and the engine
  stops on it, so not one character of the marker reaches the text. The result is a
  thinking-only message with `stopReason: "stop"` and zero visible text.
  - Why the existing branches missed it: the v0.3.3 thinking-only path requires
    marker evidence, and the lost-call path requires `stopReason: "toolUse"`. This
    turn satisfies neither, so it died silently.
  - Now: first dead turn gets a `continue` nudge; the second gets the firm
    *do not end the turn inside thinking* nudge; after two the extension stops
    nudging and notifies the user with the provider layer to fix (this is a
    server/engine fault, not a client bug) — so a persistent engine fault stays
    visible instead of looping.
  - `stopReason: "length"` and `"aborted"` remain untouched.
- **New trigger type `emptyTurn`** — counted in the persistent counter and shown as
  `E<n>` in `/rescue` status; audited as `thinking-only-empty` with `nudge` and
  `capped` fields.
- **Counter-schema forward compatibility.** `loadCounts()` defaults `emptyTurn` to
  `0` for counts files written before this version, so existing persisted state
  loads cleanly rather than producing a `undefined` in the status line.

### Tests

- 8 new checks (64 total, all passing): thinking-only with no marker nudges; marker
  present still routes to the C2 path; visible text is not nudged; `aborted` is not
  nudged; and the cap path asserts exactly two nudges, that the second is the firm
  one, and that a third dead turn is audited as `capped`.

### Related, out of scope

The engine-side counterpart for one affected engine is a config flag that closes the
thinking block and continues (off by default upstream). The client nudge here is the
provider-agnostic net for engines you cannot patch — and, unlike the flag, it also
covers the case where the same symptom arrives from a different server. See the
README's "which server actually died" note: an agent transcript records a *model*
name, and the same model name can be served by two different engines on two
different hosts, so the transcript alone cannot identify the faulty box.

## [0.3.4] — 2026-10-25

One blind spot closed: a **second leaked-markup grammar**. Models trained on
Claude transcripts emit Anthropic-style invoke/parameter tags instead of the
Qwen3-Coder-family envelope the net was built around.

### Added

- **Anthropic-style dialect (class 1 / class 3).** The tail scan now parses a
  named invoke block containing one or more named parameter pairs, optionally
  wrapped in a function_calls envelope. Both the text path and the v0.3.3
  thinking-only path use it; the grammar is chosen by the last marker actually
  present.
  - The pre-0.3.4 gate required the Qwen opening envelope, so a message whose
    only markup was the Anthropic form returned before the parser ran. The
    gate now uses the same marker-evidence predicate as the lost-call branch.
  - `hasMarkerEvidence` recognizes the invoke/parameter tags, so lost-call
    reporting has evidence for this grammar too.
  - Incident: 2026-10-25 19:39Z (strix) — a complete invoke block was the
    model's last act, inside thinking, stopReason "stop", zero toolCall
    blocks. The turn died silently and the intended command never ran.
    Frequency check across the local session store: 10 occurrences in 2
    session files; 9 were harmless (a real toolCall accompanied the
    narration), 1 was this dead turn.
- **Regression tests.** 13 new checks (56 total): bare block, function_calls
  wrapper, parallel blocks, prose-after-block guardrail, truncated tail,
  marker evidence, and a handler-level reproduction of the strix dead turn.

## [0.3.3] — 2026-09-22

Two blind spots closed after a session kept leaking. Both classes were found
by forensics on live session files; both had been slipping the net because
the `message_end` scan only looked at *visible text* of *stop* replies.

### Added

- **Class 3 — thinking-only dead turn (C2).** When an assistant message has
  *no visible text block and only thinking*, the tail scan now runs over the
  joined reasoning text instead of the (empty) text content.
  - A fully-closed tool-call block at the very end of the thinking
    materializes exactly like the text path (v0.3.2 name guard included);
    the loop executes it in the same turn. The thinking block itself is left
    intact.
  - A *malformed* tail inside thinking only sends the words-only re-issue
    nudge — no message mutation. Reasoning content may carry
    provider-verified thinking signatures; tampering with it risks 400 on
    every replay.
  - Audited as sanitize with `reason: "thinking-only-malformed"`.
  - Anti-self-priming preserved: a block the model drafted in thinking and
    then continued past is not its last act and is left alone; messages
    with visible text are still decided by the text path only.
  - Incident: 2026-09-22 05:24Z (strix) — a well-formed closed block was
    the model's last act, inside thinking; stopReason "stop", zero toolCall
    blocks, ~2.2 KB of thinking. The intended command never ran until the
    user reported the dead turn 32 s later and the model re-issued it.
- **Max-tokens cut admitted to the scan (C3).** `stopReason "length"`
  previously hit the early `stop`-only guard and returned before the
  sanitizer, so whatever the cut left behind persisted into history.
  - Unclosed markup tail in a length-cut reply → sanitize + nudge (prior
    prose kept, bracketed cut-note appended, stopReason stays "length").
  - Fully-closed tail block (the cut landed right after the close) →
    materializes; a complete call the model finished before hitting the
    limit is recovered.
  - All other stopReasons ("error", "aborted", content-filter, …) remain
    untouched.
  - Incident: 2026-09-21 22:16Z (ninfer, qwen3.8-27b) — a max-tokens cut
    left 47,002 chars of truncated tool-call markup in the reply: a real
    git-commit command whose parameter value was overrun by a 46,089-char
    contiguous digit run, outer parameter never closed. The whole block
    persisted and was replayed into that session's context on every turn.
- Regression suite `toolcall-rescue-tests/run.ts` (43 checks): the v0.3.2
  name-guard cases plus the v0.3.3 classes — thinking-only materialization,
  thinking-only anti-self-priming (mid-thinking block left alone),
  thinking-only malformed-tail nudge, length-cut malformed-tail sanitize,
  length-cut closed-block materialization. Includes both captured incident
  shapes. The directory has no `index.ts`, so pi's extension loader never
  auto-loads it.

### Changed

- `toolcall-rescue.handler-test.ts`: VERSION pin 0.3.1 → 0.3.3.
- README: class 3 documented; branch behavior and guardrails extended
  (name guard, thinking-never-mutated, length-cut admission); test section
  now lists all three suites.

### Related host-side fixes (not repo code)

- The 47,002-char truncated tail above was stripped from the affected
  session file (replaced by a 241-char bracketed note; original preserved
  in a `.bak-c4-20260922` copy next to the file). C3 is the fix that makes
  this manual cleanup unnecessary going forward.
- A tool-name poison written by v0.3.1-era rescue (the 0.3.2 incident
  below) was surgically removed from the same session store the day before;
  a standalone scan tool was built to keep the store verified-clean.

## [0.3.2] — 2026-09-21/22

Shipped in the 0.3.3 sync commit (never pushed on its own).

### Added

- **Engine-invalid tool-name guard.** Rescued blocks whose function name
  fails the engine's tool-name constraint — `[A-Za-z0-9_-]{1,64}`, the
  pattern OpenAI-compat servers validate `tool_call` names in message
  history against — are now **stripped from the text instead of
  materialized**:
  - the poison never reaches history. A single bad name in a recorded
    assistant message makes the server 400 every history replay
    ("function name must match …", param "messages") and bricks the
    session — "poison-in-history".
  - a words-only nudge asks the model to re-issue the intended action as a
    real tool call (for shell commands: the bash tool with the command
    string as an argument).
  - sibling calls in the same run with valid names still materialize, so a
    bad name can no longer veto a good one.
  - Counted as sanitize; audited `reason: "invalid-tool-name"` with the bad
    names and the number of materialized good siblings.
  - Incident: 2026-09-21 23:28Z (ninfer, qwen3.8-27b) — the model called
    the shell script `job.sh` as if it were a tool (primed by job-runner
    hints in context); the rescue materialized it, the core correctly
    answered "Tool job.sh not found", and the recorded name 400'd the
    session on every subsequent replay until the message was manually
    stripped.
- Unit tests for the constraint regex (dot/space/length boundaries) and for
  the good/bad partition (pure, incl. mixed runs); handler-level tests for
  the incident shape (invalid name: no toolCall, stop stays "stop", markup
  gone from text, cut-note names the tool, nudge names the tool, audit
  entry) and the mixed-run shape (valid sibling still materializes).

### Unchanged (deliberate)

- The parser stays **lenient**: it still parses `job.sh`-style names into
  `RescuedCall` objects. The guard sits at *materialization* time —
  lenient parse, strict materialize — so the salvage data is preserved for
  auditing and a future engine with a looser constraint loses nothing.

## [0.3.1] — 2026-09-09

### Fixed

- v0.3.0 regression (temporal dead zone): the sanitize branch's inner
  `const note` (the cut-note text) shadowed the new counter function `note`
  for the whole block, so the first real malformed-tail leak under v0.3.0
  threw `ReferenceError` at the `note("sanitize")` call before the cut ran
  — leak left in history, no nudge, no audit. In the wild 2026-09-09
  07:59Z: a leaked reply was correctly classified and then lost. The inner
  binding was renamed `cutNote`.
- Handler-level regression tests added (pi mock, isolated HOME): the
  v0.3.0 counter path had shipped broken precisely because the pure-function
  suite never drives the `message_end` handler. The new suite fires the real
  handler and asserts each branch's observable effects — replacement
  content, nudge, audit entry, persistent counter increment — plus the
  silent no-op paths.

## [0.3.0] — 2026-09-07

### Added

- Persistent trigger counter: every intervention (rescue / sanitize /
  lost-call) is counted in `~/.pi/agent/data/toolcall-rescue-counts.json` —
  lifetime total, per type, per provider/model pair, last event. Purely
  observational (shown in `/rescue` status; never feeds the decision path):
  the triage number for "how often does the net actually fire, and on which
  provider/model?" — i.e. whether the underlying engine parser bug is worth
  chasing down.
- Provider/model attribution in every audit entry.
- 10 new unit tests (40 total).

## [0.2.0] — 2026-09-07 (initial commit)

### Added

- The extension itself: `message_end` safety net for the two observed death
  classes — **class 1 (leaked-to-text)**: complete tail blocks rescued into
  real toolCall blocks and executed in the same turn by pi's own loop
  (zero extra LLM calls); malformed tails cut with a bracketed note plus a
  capped words-only re-issue nudge. **Class 2 (lost call / silent stop)**:
  tool-use stop reason with zero delivered calls normalized to a clean stop
  plus the same capped nudge.
- Deterministic fragment-assembled detection (parser hygiene), tail-only
  anti-self-priming rule, `TOOLCALL_RESCUE` env toggle, `/rescue` command,
  stderr audit logging.
- Persistent session audit entries (`appendEntry`, custom type
  `toolcall-rescue`): the transcript is mutated in place by this extension,
  so the session file keeps an independent record of each intervention
  (metadata only — never the removed text, which is the poison).
- Version stamp in `/rescue` status (stale hot-reload / pi-upgrade drift is
  visible).
- 30-case test suite incl. the two captured field failures (complete-tail
  leak; borrowed-closing-tag tail), the intentional-quote guardrail, the
  truncated-tail guardrail, parallel blocks, and the lost-call class.
