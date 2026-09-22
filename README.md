# toolcall-rescue

A safety-net extension for the [pi](https://github.com/earendil-works/pi) coding
agent. It keeps agent workflows alive when a local LLM server **drops or leaks
the model's tool calls** — a failure mode that kills the workflow *silently*:
no error, no retry, the agent just stops mid-task and waits for a human.

## The problem

Coding agents that talk to local LLM servers (ninfer, llama.cpp, DS4, vLLM, …)
depend on the server to parse tool calls out of raw token text. Some
model/server pairings — most often Qwen-family models served from quantized
weights — occasionally emit tool-call markup that the server's parser mishandles.
Three death classes have been observed and instrumented in production sessions:

### Class 1 — leaked-to-text

The model's tool-call markup arrives as **literal text** in the assistant
content, and the response finishes with a plain "stop" instead of a tool use.
The agent executes nothing. The model usually *did* mean to call a tool — the
markup is complete (or nearly so) — so a correct parser would have executed
the work; the server just failed to hand it over. Variants:

- **complete block at the tail** of the text (often because the model quoted
  the format in prose first),
- **truncated/malformed tail** — the opening envelope is present but the
  block never closes, or no parsable parameters survive (in one captured
  incident the outer parameter never closed and the inner parameter silently
  "borrowed" its closing tag).

### Class 2 — lost call (silent stop)

Worse: the leak never becomes visible text at all. The model's generated
stream (its reasoning text) contains or ends on contiguous marker strings —
quoting the format, listing the tokens, or composing a command that carries
them — and the server's parser breaks on that and **drops the response's own
tool call entirely**. The server still reports the tool-use finish reason,
but delivers zero tool calls. The agent stores a thinking-only message that
claims a tool use that never happened; the loop has nothing to execute and
ends the turn. In one session this happened **four times**; resuming cost 13
seconds, 37 minutes, and 9 minutes of human patience respectively.

### Class 3 — thinking-only dead turn

The call never becomes visible text at all, and the stop reason does not
even lie: the model writes the complete tool call into its own reasoning
(thinking block) and stops with a plain "stop" and zero tool-call blocks.
No visible leak to catch, no tool-use finish to flag — the turn ends with
the intended call unexecuted. Observed 2026-09-22: a fully closed block was
the model's last act, inside thinking. Distinct from class 2: class 2 lies
via a tool-use finish with zero calls; class 3 is a clean stop with the
call hidden in the reasoning.

### Why it's a trap to fix

The pattern itself is toxic to the pipeline. Writing a detector for it
requires emitting the pattern (in docs, regexes, test fixtures) — the act of
building the fix is the act that kills the session. Any assistant output that
ends on the marker strings can kill the workflow; the same holds for payloads
that carry them. Every file in this repository is written under that
constraint (see "Parser hygiene" below).

## How it works

The extension hooks pi's `message_end` event (fired after the model finishes
a turn; pi awaits handlers before the agent loop reads the final message, so
replacements reach the loop). It is **deterministic** — pure regex, no LLM
calls, microseconds per message — and engine-agnostic in structure (the tag
names are constants at the top; add another format, get the same net).

Three branches (plus two v0.3.2/v0.3.3 hardenings of the first two):

1. **Rescue (class 1, complete tail).** If the message ends with one or more
   complete tool-call blocks (adjacent blocks = parallel calls), the leaked
   text is replaced by a note plus real toolCall blocks with freshly minted
   ids and the stop reason is set to tool-use, so **pi's own agent loop
   executes them in the same turn**, exactly as native calls. The server's
   parser never materialized ids for the dropped calls, so there is no
   server-side identity to preserve — an accepted loss; the alternative is
   workflow death. Inner
   "borrowed closing tag" parameters are recovered best-effort from the last
   parsable parameter.
   *v0.3.2:* a rescued block whose function name fails the engine's
   tool-name constraint (`[A-Za-z0-9_-]{1,64}`) is **stripped instead of
   materialized** — an engine-invalid name in history 400s every replay and
   bricks the session (poison-in-history; the 2026-09-21 "job.sh" incident).
   Valid siblings in the same run still materialize; counted as sanitize,
   audited `reason: invalid-tool-name`.
   *v0.3.3:* when a message has **no visible text and only thinking**
   (class 3), this branch scans the reasoning text instead of the text
   content; a fully closed tail block materializes exactly as above (name
   guard included).
2. **Sanitize (class 1, malformed tail).** If the tail carries the marker but
   no complete block survives, the region from the last opening envelope to
   the end of the text is **cut** (a short bracketed note is left so the
   transcript explains the gap) and a words-only follow-up nudge asks the
   model to re-issue the call as a real tool call.
   *v0.3.3:* a max-tokens cut (stop reason "length") is admitted to this
   scan — before, the guard bailed before the sanitizer and the truncated
   tail persisted into history (2026-09-21: 47,002 chars of truncated
   markup replayed into the session's context on every turn). A fully
   closed tail block (the cut landed right after the close) materializes
   instead. All other stop reasons remain untouched.
3. **Lost-call (class 2).** If the message's stop reason says "tool use" but
   zero tool-call blocks were delivered, the call was dropped by the engine.
   The stored stop reason is normalized to a clean stop (a tool-use message
   with no calls is malformed history) and the same words-only nudge asks for
   a real re-issue.

Guardrails:

- **Tail-only rule.** A complete block followed by prose is an intentional
  quote (documentation) and is left alone. Only markup at the very end of the
  message is treated as a degraded real call. The rule also protects
  thinking: a block the model drafted in reasoning and then continued past is
  not its last act, and is left alone.
- **Thinking is never mutated.** A malformed tail inside a thinking block
  (v0.3.3) only nudges a re-issue — reasoning content may carry
  provider-verified signatures; tampering risks 400 on replay. Materialization
  of a closed thinking-tail block appends real toolCall blocks and leaves the
  thinking block intact.
- **Capped nudges.** Nudges share a per-process cap (default 3); after it,
  the net keeps sanitizing but says so once — it can't fix a persistently
  leaking model, only prevent silent death.
- **Audit.** Every rescue/cut/lost-call/nudge/cap event is logged to stderr
  with a `toolcall-rescue]` prefix.
- **Toggle.** On by default; `TOOLCALL_RESCUE=off` (or `0`) disables it,
  `on`/`1` forces it. A `/rescue` pi command shows status and this process's
  stats; `/rescue off|on` toggles.

### Parser hygiene (why the source looks weird)

The detection pattern is assembled **from fragments at runtime**
(`["tool", "_call"].join("")`, `"<" + ...`, etc.) instead of being written as
a literal string. The reason is the self-priming kill described above: a
contiguous marker string anywhere in a model's *generated* stream can break
the engine parser (both classes are triggered by it), and the model that
writes or reviews this code would otherwise be carrying the poison in its own
output. The tests follow the same rule — fixtures are built by
concatenation. This is defense-in-depth: the format itself is public (it is
the server-tool-calling markup of the Qwen3-Coder family), so nothing
sensitive is hidden; the fragmentation exists only so that no contiguous
instance exists in any file a model is likely to emit.

## Install

Requires pi coding agent with the `@earendil-works/pi-coding-agent` API.

```sh
mkdir -p ~/.pi/agent/extensions
cp toolcall-rescue.ts ~/.pi/agent/extensions/
```

pi auto-discovers `~/.pi/agent/extensions/`. Hot-reload with pi's `/reload`
command (no restart needed). Verify it loaded: `/rescue`.

## Test

Three suites (Node ≥ 22.6 with `--experimental-strip-types`, or Node 23+;
plain `node` on Node 23+):

```sh
node toolcall-rescue.test.ts                    # 40 pure-function unit tests
node --experimental-strip-types \
  toolcall-rescue.handler-test.ts               # 25 handler-level tests (pi mock, isolated HOME)
node toolcall-rescue-tests/run.ts               # 43 v0.3.2/v0.3.3 regression checks
```

The unit fixtures include the two captured field failures (complete-tail
leak; borrowed-closing-tag tail), the intentional-quote guardrail, the
truncated-tail guardrail, parallel blocks, and the lost-call class. The
handler suite fires the real `message_end` handler through a pi mock and
asserts each branch's observable effects (replacement content, nudge, audit
entry, counter). The regression suite covers the v0.3.2 engine-invalid
tool-name guard and the v0.3.3 thinking-only and length-cut classes,
including both captured 2026-09 incident shapes (job.sh name poison;
47,002-char truncated tail).

Note: the two root-level suites import the **installed** extension
(`~/.pi/agent/extensions/toolcall-rescue.ts`) by absolute path — copy this
repo's `toolcall-rescue.ts` into an installed pi tree before running them
there. `toolcall-rescue-tests/run.ts` imports its sibling
`../toolcall-rescue.ts` and tests the copy in this repo.

## Pros and cons

### Pros

- Kills the silent-workflow-death mode for both observed classes. The
  documented incidents: one complete leak, one truncated leak (recovered
  best-effort, executed), four lost-call silent stops.
- Zero cost on normal turns: pure regex over the message text, terminal
  hook only, no LLM calls, no network. Microseconds.
- Engine-agnostic structure: per-format constants, easy to extend to other
  tool-calling markup styles.
- Auditable, reversible, and measured: everything it does is stderr-logged
  and counted; disable with one env var or `/rescue off`; the only state
  files are two small JSONs (toggle + trigger counts) in
  `~/.pi/agent/data/`.
- **Persistent trigger counter (v0.3.0).** Every intervention (rescue /
  sanitize / lost-call) is counted lifetime, per type, and per
  provider/model pair (`~/.pi/agent/data/toolcall-rescue-counts.json`).
  `/rescue` status shows lifetime total, top provider/model pairs, and the
  last event. Purely observational — it answers "how often does the net
  actually fire, and on which provider/model?", the triage number for
  whether the underlying engine bug is worth chasing down.
- **Engine-invalid name guard (v0.3.2).** A rescued call whose tool name
  fails the engine's constraint is stripped, not materialized: a bad name in
  history 400s every replay and bricks the session (2026-09-21 "job.sh"
  incident).
- **Wider net (v0.3.3).** The scan also sees calls the model wrote entirely
  into its reasoning (thinking-only messages, class 3) and cuts junk left by
  a max-tokens cut (stop reason "length") instead of storing it.
- Executes the model's actual intent (rescue path) instead of just
  complaining — the work that was "lost" usually runs.
- Unit-tested against captured field failures, not just synthetic ones.

### Cons

- **Executes degraded intent without a confirmation step.** A complete block
  at the end of a message is treated as a real call by design (that is the
  incident shape). If a model ever ends a message on a complete *example*
  block, that example gets executed with no confirmation. Rare (messages
  usually end in prose) but real.
- **Blunts forensics.** Sanitize/lost-call handling mutates the stored
  message in place; the original leaked text is gone (a cut-note survives).
  Mitigations since v0.2.0: every intervention also appends a persistent
  session audit entry (metadata only — what, when, how much; never the
  removed text, which is the poison), and `/rescue` shows the running
  version. The raw payload itself is still unrecoverable; pair with your
  engine's server-side parse-failure log if it has one (ninfer: warning
  lines + `--request-log-jsonl` per-request parse diagnostics) to close the
  forensic loop.
- **Rescued calls have minted ids.** The reconstructed toolCall blocks get
  fresh ids (the server never materialized ids for the dropped calls).
  Anything that keys on server-side call ids (provider streaming state,
  external tool-result correlators) cannot link them — in practice there is
  no server-side record to link to at all.
- **Blind to unknown formats.** Detection is exact-string (fragmented)
  matching of one markup family. A model that leaks a *different* engine's
  format gets no protection until a format block is added.
- **Nudge cap degrades to the old failure mode.** After 3 nudges per process
  the net stops nudging (it still sanitizes/cuts). A genuinely broken model
  then dies the old silent way again — with one prior notice on stderr.
- **Fragile to host changes.** It depends on pi's message-end replacement
  semantics and on the engine parser staying broken in the same way (the net
  is a patch around a parser bug, not a fix of it). pi upgrades or parser
  changes can silently deactivate it.
- **Discussing the bug can trigger it.** Sessions that document this
  extension quote the marker strings; a message that ends on a quoted list is
  exactly the class-2 trigger. (This very repo was built under that
  constraint, and two of its own build sessions died to it before the
  lost-call branch existed.)

## Prior art

Both failure classes are documented cross-framework Qwen-family problems,
not one-off pi bugs (found 2026-09):

- **QwenLM/qwen-code issue #10692** (2026-07): "tool_call-dialect XML tool
  calls leak as plain text" — class 1, officially filed; qwen-code recovers
  some dialects but misses the `<tool_call>` dialect its own system prompt
  teaches (same self-priming dynamic as this extension's hygiene rule).
- **llama.cpp issue #20837**: Qwen3.5 "prints tool calls in XML and stops"
  — the class-1 symptom, engine-side.
- **llama.cpp issue #21158**: Qwen3.5-27B tool-call parsing broken; reported
  community workaround is denying structured tools entirely and routing
  everything through one exec tool.
- **froggeric/Qwen-Fixed-Chat-Templates PR #45** (merged into v21, 2026-07):
  class-2 root cause on llama.cpp/ik_llama — the tool-call grammar triggers
  on the envelope opener but the parser expects Hermes JSON inside, while
  the v16+ template teaches XML inside; instruction-faithful models dump the
  whole call into content with zero tool_calls and "the turn just ends".
  Fix: teach the native Hermes JSON form in the template. (Custom engines
  that parse the XML dialect deliberately — like the one this was built on —
  are not covered by that fix.)
- **Hugging Face Qwen3.6-27B discussion #13** (2026-09): "sometimes the
  qwen3.6 model will respond with empty tool call which causing the agent
  loop terminated" on vLLM — class 2, third framework.
- **NVIDIA developer forums** (2026): Qwen3.5 tool calls leaking into the
  reasoning block, model "would stop as if it were done".
- **geo-agent issue #121**: client-side handling of text-format qwen3 tool
  calls; documents truncation-induced leaks (matches the captured
  "truncated tail" incident here).
- **Pattern-level**: instructor / PydanticAI codify the standard
  "retry on invalid structured output" — retry, don't salvage. Salvaging a
  parseable call out of leaked text, plus a capped re-issue nudge for
  unsalvageable ones, is the more aggressive half of this net.

To the best of the author's search (2026-09-07), no pi extension doing this
exists upstream; this is the first (client-side, both classes, same-turn).

## Limitations / honest split

- **What it fixes:** silent workflow death *on the pi side* for the observed
  classes. It does not fix the server parser, the quant, or the model.
- **What it cannot know:** whether a rescued block is the model's true intent
  or a quoted example (tail-only rule is the heuristic boundary).
- **Unverified:** the exact parser mechanism inside the servers that breaks
  (candidates: lazy parameter scanning that ends values at contiguous
  closing-tag strings; stochastic fragility). The net is deliberately
  mechanism-agnostic.

## Provenance

v0.3.3 (2026-09-22): two blind spots closed after a session kept leaking.
(C2) Thinking-only dead turn (class 3): when a message has no visible text
and only thinking, the tail scan now runs over the reasoning text; a fully
closed tail block materializes (name guard included), a malformed tail only
nudges a re-issue (the thinking block is left intact — provider-verified
signatures may exist). Anti-self-priming preserved: blocks the model
drafted and then continued past are excluded; messages with visible text
are still decided by the text path only. (C3) Max-tokens cut (stop reason
"length") is now admitted to the scan: unclosed tails are sanitized +
nudged (before, 47,002 chars of truncated markup persisted into session
history and replayed on every turn), fully-closed tail blocks materialize.
All other stop reasons untouched. Regression suite:
toolcall-rescue-tests/run.ts (43 checks, both incident shapes included).

v0.3.2 (2026-09-22): engine-invalid tool names. A rescued block whose
function name fails the engine's tool-name constraint
(`[A-Za-z0-9_-]{1,64}`) used to be materialized as-is; the engine then 400s
every history replay ("function name must match ...") and the session
bricks — poison-in-history. 2026-09-21 23:28Z in the wild: the model called
the shell script "job.sh" as if it were a tool; the rescue materialized it
and the recorded name 400'd the session on every subsequent replay. Now:
names failing the constraint are stripped from the text (poison never
reaches history) with a nudge to re-issue the action as a real tool call;
sibling calls with valid names still materialize. Counted as sanitize;
audited `reason: invalid-tool-name`.

v0.3.1 (2026-09-09): fix v0.3.0 regression - the sanitize branch's inner
`const note` shadowed the new counter function `note` (temporal dead zone),
so the first real malformed-tail leak under v0.3.0 crashed the handler
before the cut ran (leak left in history, no nudge, no audit). Renamed the
inner binding; added handler-level regression tests (pi mock, isolated
HOME) covering all three branches plus the silent paths.

v0.3.0 (2026-09-07): persistent trigger counter (lifetime + per
provider/model), shown in `/rescue` status; provider/model in audit entries.

v0.2.0 (2026-09-07): lost-call branch, persistent session audit entries
(`appendEntry`), version stamp in `/rescue` status.

Built in production incident response, September 2026, after multiple
workflow deaths across several local serving engines (ninfer, llama.cpp,
DS4, vLLM), all with Qwen-family models; a cross-provider pattern consistent
with engine-side parser fragility rather than one bad quant. First incident
was a truncated tool call in the transcript (class 1); the lost-call class
(class 2) was identified by forensics on a session file — a thinking-only
assistant message with a tool-use stop reason and zero delivered calls,
recurring.

## License

MIT — see [LICENSE](./LICENSE).
