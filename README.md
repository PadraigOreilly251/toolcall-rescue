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
Two death classes have been observed and instrumented in production sessions:

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

Three branches:

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
2. **Sanitize (class 1, malformed tail).** If the tail carries the marker but
   no complete block survives, the region from the last opening envelope to
   the end of the text is **cut** (a short bracketed note is left so the
   transcript explains the gap) and a words-only follow-up nudge asks the
   model to re-issue the call as a real tool call.
3. **Lost-call (class 2).** If the message's stop reason says "tool use" but
   zero tool-call blocks were delivered, the call was dropped by the engine.
   The stored stop reason is normalized to a clean stop (a tool-use message
   with no calls is malformed history) and the same words-only nudge asks for
   a real re-issue.

Guardrails:

- **Tail-only rule.** A complete block followed by prose is an intentional
  quote (documentation) and is left alone. Only markup at the very end of the
  message is treated as a degraded real call.
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

```sh
node toolcall-rescue.test.ts
```

(Node ≥ 22.6 with `--experimental-strip-types`, or Node 23+; plain `node` on
Node 23+. Expect 30 passed, 0 failed.) The fixtures include the two captured
field failures (complete-tail leak; borrowed-closing-tag tail), the
intentional-quote guardrail, the truncated-tail guardrail, parallel blocks,
and the lost-call class.

## Pros and cons

### Pros

- Kills the silent-workflow-death mode for both observed classes. The
  documented incidents: one complete leak, one truncated leak (recovered
  best-effort, executed), four lost-call silent stops.
- Zero cost on normal turns: pure regex over the message text, terminal
  hook only, no LLM calls, no network. Microseconds.
- Engine-agnostic structure: per-format constants, easy to extend to other
  tool-calling markup styles.
- Auditable and reversible: everything it does is stderr-logged; disable
  with one env var or `/rescue off`; no state file to drift.
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
