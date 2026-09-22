# Changelog

Notable changes to `toolcall-rescue`, newest first. The version stamp shown
by `/rescue` status and in the `loaded v...` stderr line tracks these
entries. Dates are the dates the change was made in production (UTC);
session references are deliberately date + model + shape only — no session
ids or payloads in a public repo.

Hygiene note (as with every file in this repo): no contiguous instance of
the detection marker appears below; "tool-call markup", "opening envelope",
and "close" refer to the Qwen3-Coder-family XML tags.

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
