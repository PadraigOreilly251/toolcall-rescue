/**
 * toolcall-rescue v0.3.5 regression tests:
 *   - engine-invalid tool-name guard (v0.3.2)
 *   - thinking-only dead-turn materialization + malformed-thinking nudge (C2)
 *   - stopReason=length malformed-tail sanitize / closed-block rescue (C3)
 *   - Anthropic <invoke> dialect in thinking (v0.3.4 C4)
 *   - thinking-only no-marker dead turn: nudge + escalation + cap (v0.3.5 C5)
 *
 * Run:  node run.ts          (Node >= 23; on Node 22 use --experimental-strip-types)
 *
 * This directory has NO index.ts, so pi's extension loader never auto-loads it.
 *
 * PARSER-HYGIENE (same rule as the extension source): marker/tag strings are
 * assembled from fragments at runtime - contiguous tag literals must NOT
 * appear in this file.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import toolcallRescue, {
  extractTailCalls,
  partitionRescuedCalls,
  VALID_TOOL_NAME_RE,
  hasMarkerEvidence,
  type RescuedCall,
} from "../toolcall-rescue.ts";

process.env.TOOLCALL_RESCUE = "on"; // force enabled regardless of state file

const T = ["tool", "_call"].join("");
const OPEN = "<" + T + ">";
const CLOSE = "</" + T + ">";
const FOPEN = "<" + "function=";
const FCLOSE = "</" + "function>";
const POPEN = "<" + "parameter=";
const PCLOSE = "</" + "parameter>";

function block(name: string, params: Array<[string, string]>): string {
  const ps = params.map(([k, v]) => POPEN + k + ">" + v + PCLOSE).join("");
  return OPEN + FOPEN + name + ">" + ps + FCLOSE + CLOSE;
}

// v0.3.4: Anthropic-style dialect, assembled from fragments (parser hygiene).
const IOPEN = "<" + "invoke" + ' name="';
const ICLOSE = "</" + "invoke>";
const PNAME_OPEN = "<" + "parameter" + ' name="';
const FCALLS_OPEN = "<" + "function_calls>";
const FCALLS_CLOSE = "</" + "function_calls>";

function invokeBlock(name: string, params: Array<[string, string]>): string {
  const ps = params.map(([k, v]) => PNAME_OPEN + k + '">' + v + PCLOSE).join("\n");
  return IOPEN + name + '">\n' + ps + "\n" + ICLOSE;
}

let failed = 0;
function check(label: string, cond: boolean): void {
  if (cond) console.log("PASS " + label);
  else {
    failed++;
    console.error("FAIL " + label);
  }
}

// ── pure: engine regex ────────────────────────────────────────────────
check("regex: 'job.sh' rejected (dot)", !VALID_TOOL_NAME_RE.test("job.sh"));
check("regex: 'bash' accepted", VALID_TOOL_NAME_RE.test("bash"));
check("regex: underscore+hyphen accepted", VALID_TOOL_NAME_RE.test("a_b-c"));
check("regex: 64 chars accepted", VALID_TOOL_NAME_RE.test("a".repeat(64)));
check("regex: 65 chars rejected", !VALID_TOOL_NAME_RE.test("a".repeat(65)));
check("regex: space rejected", !VALID_TOOL_NAME_RE.test("bad name"));
check("regex: empty rejected", !VALID_TOOL_NAME_RE.test(""));

// ── pure: parser stays lenient (parses job.sh; guard rejects later) ──
const parsed = extractTailCalls("prose\n" + block("job.sh", [["command", "x"]]));
check(
  "parser: closed 'job.sh' block still parsed (lenient parse, strict materialize)",
  parsed.calls.length === 1 && parsed.calls[0].name === "job.sh",
);
check("parser: no malformedTail for closed block", parsed.malformedTail === false);

// ── pure: partition ───────────────────────────────────────────────────
const part = partitionRescuedCalls(parsed.calls);
check("partition: 'job.sh' -> bad", part.bad.length === 1 && part.bad[0].name === "job.sh");
check("partition: no good calls", part.good.length === 0);

const parsedMixed = extractTailCalls(
  block("job.sh", [["command", "x"]]) + block("bash", [["command", "echo hi"]]),
);
const partMixed = partitionRescuedCalls(parsedMixed.calls);
check(
  "partition: mixed run -> 1 bad + 1 good",
  partMixed.bad.length === 1 &&
    partMixed.good.length === 1 &&
    partMixed.bad[0].name === "job.sh" &&
    partMixed.good[0].name === "bash",
);

// ── v0.3.4: Anthropic-style <invoke> dialect ─────────────────────────
const inv = extractTailCalls("prose\n" + invokeBlock("bash", [["command", "echo hi"]]));
check("invoke: closed block parsed", inv.calls.length === 1 && inv.calls[0].name === "bash");
check("invoke: command argument", inv.calls[0]?.arguments?.command === "echo hi");
check("invoke: no malformedTail", inv.malformedTail === false);

const invWrapped = extractTailCalls(
  FCALLS_OPEN + "\n" + invokeBlock("bash", [["command", "ls"]]) + "\n" + FCALLS_CLOSE,
);
check(
  "invoke: <function_calls> wrapper parsed",
  invWrapped.calls.length === 1 && invWrapped.calls[0].name === "bash",
);

const invParallel = extractTailCalls(
  invokeBlock("read", [["path", "/tmp/x"]]) + "\n" + invokeBlock("bash", [["command", "ls"]]),
);
check(
  "invoke: parallel blocks -> 2 calls",
  invParallel.calls.length === 2 && invParallel.calls[1].name === "bash",
);

const invProse = extractTailCalls(
  invokeBlock("bash", [["command", "ls"]]) + "\nthat's the plan, but not yet",
);
check(
  "invoke: prose after block left alone",
  invProse.calls.length === 0 && invProse.malformedTail === false,
);

const invCut = extractTailCalls("prose\n" + IOPEN + 'bash">\n' + PNAME_OPEN + 'command">echo');
check("invoke: truncated tail malformed", invCut.calls.length === 0 && invCut.malformedTail === true);
check(
  "invoke: marker evidence",
  hasMarkerEvidence(IOPEN + 'bash">' + PNAME_OPEN + 'command">x' + PCLOSE),
);

// ── handler-level (stubbed pi; counts file backed up + restored) ─────
const COUNTS_FILE = path.join(os.homedir(), ".pi", "agent", "data", "toolcall-rescue-counts.json");
const countsBackup = fs.existsSync(COUNTS_FILE) ? fs.readFileSync(COUNTS_FILE) : null;

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
}
interface OutMessage {
  content: ContentBlock[];
  stopReason: string;
}
interface Fake {
  handler: (event: { message: unknown }, ctx: unknown) => Promise<{ message: OutMessage } | undefined>;
  sent: string[];
  entries: Array<Record<string, unknown>>;
}

function makeFake(): Fake {
  const f: Fake = { handler: async () => undefined, sent: [], entries: [] };
  const pi = {
    on: (ev: string, h: Fake["handler"]) => {
      if (ev === "message_end") f.handler = h;
    },
    registerCommand: (_name: string, _def: unknown) => undefined,
    appendEntry: (_t: string, e: Record<string, unknown>) => {
      f.entries.push(e);
    },
    sendUserMessage: async (text: string, _opts: unknown) => {
      f.sent.push(text);
    },
  };
  toolcallRescue(pi as never);
  return f;
}

function msgWithText(text: string) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
    provider: "testprovider",
    model: "testmodel",
  };
}

(async () => {
  try {
    // Case 1: sole call has engine-invalid name (the 2026-09-21 incident)
    const f1 = makeFake();
    const r1 = await f1.handler(
      {
        message: msgWithText(
          "let me check\n" + block("job.sh", [["command", "check bg-1"]]),
        ),
      },
      { ui: undefined },
    );
    const m1 = r1!.message;
    check("handler: no toolCall materialized for 'job.sh'", m1.content.every((b) => b.type !== "toolCall"));
    check("handler: stopReason stays 'stop'", m1.stopReason === "stop");
    const t1 = m1.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
    check("handler: poison markup removed from text", !t1.includes(FOPEN + "job.sh"));
    check(
      "handler: cut note present, names the bad tool",
      t1.includes("engine-invalid name") && t1.includes("job.sh"),
    );
    check("handler: prior prose kept", t1.includes("let me check"));
    check("handler: nudge sent, names the bad tool", f1.sent.length === 1 && f1.sent[0].includes("job.sh"));
    check(
      "handler: audit entry sanitize/invalid-tool-name",
      f1.entries.some(
        (e) =>
          e.event === "sanitize" &&
          e.reason === "invalid-tool-name" &&
          JSON.stringify(e.badNames) === JSON.stringify(["job.sh"]),
      ),
    );

    // Case 2: mixed run - valid sibling still materializes
    const f2 = makeFake();
    const r2 = await f2.handler(
      {
        message: msgWithText(
          block("job.sh", [["command", "x"]]) + block("bash", [["command", "echo hi"]]),
        ),
      },
      { ui: undefined },
    );
    const m2 = r2!.message;
    const calls2 = m2.content.filter((b) => b.type === "toolCall");
    check(
      "handler mixed: exactly one toolCall materialized ('bash')",
      calls2.length === 1 && calls2[0].name === "bash",
    );
    check("handler mixed: stopReason 'toolUse'", m2.stopReason === "toolUse");
    const t2 = m2.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
    check("handler mixed: 'job.sh' markup gone from text", !t2.includes(FOPEN + "job.sh"));
    check("handler mixed: 'bash' markup not left as text (materialized)", !t2.includes(FOPEN + "bash"));
    check("handler mixed: nudge sent", f2.sent.length === 1 && f2.sent[0].includes("job.sh"));

    // Case 3: valid names untouched - normal rescue path still works
    const f3 = makeFake();
    const r3 = await f3.handler(
      { message: msgWithText(block("bash", [["command", "echo ok"]])) },
      { ui: undefined },
    );
    const m3 = r3!.message;
    const calls3 = m3.content.filter((b) => b.type === "toolCall");
    check(
      "handler valid: normal rescue still materializes 'bash'",
      calls3.length === 1 && calls3[0].name === "bash" && m3.stopReason === "toolUse",
    );
    check("handler valid: no nudge on clean rescue", f3.sent.length === 0);

    // Case 4: no marker in text -> no-op
    const f4 = makeFake();
    const r4 = await f4.handler({ message: msgWithText("plain prose, no markup") }, { ui: undefined });
    check("handler no-marker: message untouched", r4 === undefined);
    check("handler no-marker: no nudge, no audit", f4.sent.length === 0 && f4.entries.length === 0);

    // Case 5 (v0.3.3 C2): thinking-only dead turn - well-formed closed
    // block at the END of thinking, no text block, stop=stop.
    // The 2026-09-22 05:24Z incident (strix).
    const f5 = makeFake();
    const r5 = await f5.handler(
      {
        message: {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking:
                "Check the render loop. It probably overrides camera each frame.\n\n" +
                block("bash", [["command", "grep -n camera x.html | head -20"]]),
            },
          ],
          stopReason: "stop",
          provider: "testprovider",
          model: "thinkingmodel",
        },
      },
      { ui: undefined },
    );
    const m5 = r5!.message;
    const calls5 = m5.content.filter((b) => b.type === "toolCall");
    check(
      "C2: thinking-only closed block materialized",
      calls5.length === 1 && calls5[0].name === "bash" && m5.stopReason === "toolUse",
    );
    check(
      "C2: thinking block preserved intact",
      m5.content.some((b) => b.type === "thinking"),
    );
    check("C2: no nudge on clean materialization", f5.sent.length === 0);
    check("C2: audit rescue entry", f5.entries.some((e) => e.event === "rescue"));

    // Case 6 (v0.3.3 C2 anti-self-priming): block in the MIDDLE of
    // thinking, more reasoning after it -> not the model's last act -> no-op
    const f6 = makeFake();
    const r6 = await f6.handler(
      {
        message: {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking:
                "maybe: " +
                block("bash", [["command", "echo x"]]) +
                "\nbut actually that's wrong, let me think differently...",
            },
          ],
          stopReason: "stop",
          provider: "testprovider",
          model: "thinkingmodel",
        },
      },
      { ui: undefined },
    );
    check("C2 anti-self-priming: mid-thinking block left alone", r6 === undefined);
    check(
      "C2 anti-self-priming: no nudge, no audit",
      f6.sent.length === 0 && f6.entries.length === 0,
    );

    // Case 7 (v0.3.3 C2): thinking-only MALFORMED tail (unclosed block)
    // -> nudge only, thinking left intact, no message mutation
    const f7 = makeFake();
    const r7 = await f7.handler(
      {
        message: {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking:
                "let me run it:\n" +
                OPEN + FOPEN + "bash>" + POPEN + "command>" + "echo x",
            },
          ],
          stopReason: "stop",
          provider: "testprovider",
          model: "thinkingmodel",
        },
      },
      { ui: undefined },
    );
    check(
      "C2 malformed-thinking: no message mutation (undefined return)",
      r7 === undefined,
    );
    check("C2 malformed-thinking: nudge sent", f7.sent.length === 1);
    check(
      "C2 malformed-thinking: audit sanitize/thinking-only-malformed",
      f7.entries.some(
        (e) => e.event === "sanitize" && e.reason === "thinking-only-malformed",
      ),
    );

    // Case 8 (v0.3.3 C3): stopReason=length with unclosed markup tail in
    // TEXT -> sanitized (previously: early return, poison persisted -
    // the 2026-09-21 22:16Z incident shape)
    const f8 = makeFake();
    const r8 = await f8.handler(
      {
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "commit now:\n" + OPEN + FOPEN + "bash>" + POPEN + "command>" + "git commit -m x",
            },
          ],
          stopReason: "length",
          provider: "testprovider",
          model: "lengthmodel",
        },
      },
      { ui: undefined },
    );
    const m8 = r8!.message;
    const t8 = m8.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
    check("C3: length-cut malformed tail sanitized (markup gone)", !t8.includes(FOPEN + "bash"));
    check("C3: cut note present", t8.includes("malformed tool-call text"));
    check("C3: prior prose kept", t8.includes("commit now:"));
    check("C3: nudge sent", f8.sent.length === 1);
    check(
      "C3: stopReason stays 'length' (no toolUse from a broken tail)",
      m8.stopReason === "length",
    );

    // Case 9 (v0.3.3 C3): stopReason=length with a FULLY-CLOSED tail block
    // (the cut landed right after the close) -> materialized
    const f9 = makeFake();
    const r9 = await f9.handler(
      {
        message: {
          role: "assistant",
          content: [{ type: "text", text: block("bash", [["command", "echo done"]]) }],
          stopReason: "length",
          provider: "testprovider",
          model: "lengthmodel",
        },
      },
      { ui: undefined },
    );
    const m9 = r9!.message;
    const calls9 = m9.content.filter((b) => b.type === "toolCall");
    check(
      "C3: length-cut closed block materialized",
      calls9.length === 1 && calls9[0].name === "bash" && m9.stopReason === "toolUse",
    );
    // Case 10 (v0.3.4 C4): the 2026-10-25 19:39Z strix incident - an
    // Anthropic <invoke> block emitted INSIDE thinking, no text block,
    // stop=stop, zero toolCalls. Pre-v0.3.4 the gate required a Qwen
    // marker, so the turn died silently with the call never executed.
    const f10 = makeFake();
    const r10 = await f10.handler(
      {
        message: {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking:
                "I've got the numbers I need. Let me check the models.yaml entry.\n\n" +
                invokeBlock("bash", [["command", "echo real-payload"]]),
            },
          ],
          stopReason: "stop",
          provider: "strix",
          model: "strix",
        },
      },
      { ui: undefined },
    );
    const m10 = r10!.message;
    const calls10 = m10.content.filter((b) => b.type === "toolCall");
    check(
      "C4 strix: invoke-in-thinking materialized",
      calls10.length === 1 && calls10[0].name === "bash",
    );
    check("C4 strix: stopReason toolUse", m10.stopReason === "toolUse");
    check(
      "C4 strix: thinking preserved intact",
      m10.content.some((b) => b.type === "thinking"),
    );
    check("C4 strix: no nudge on clean materialization", f10.sent.length === 0);
    check("C4 strix: audit rescue entry", f10.entries.some((e) => e.event === "rescue"));

    // Case 11 (v0.3.5 C5): thinking-only, stop, NO marker evidence -
    // the 2026-11-01 15:33Z Qwen/Strata incident (the model quoted a
    // literal end-of-turn control token inside its reasoning; the engine
    // stopped and the turn was empty). Pre-v0.3.5: silent no-op.
    const deadThinking = {
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking:
            'The user is pushing back. Maybe there WAS a quality comparison - e.g. "does it emit ',
        },
      ],
      stopReason: "stop",
      provider: "vh114",
      model: "qwen3.8-27b",
    };
    const f11 = makeFake();
    const r11 = await f11.handler({ message: deadThinking }, { ui: undefined });
    check("C5: thinking-only no-marker -> no message mutation", r11 === undefined);
    check(
      "C5: continue nudge sent",
      f11.sent.length === 1 && f11.sent[0].includes("ended inside its thinking"),
    );
    check(
      "C5: audit thinking-only-empty (not capped)",
      f11.entries.some(
        (e) => e.event === "thinking-only-empty" && e.capped === false && e.nudge === 1,
      ),
    );

    // Case 12 (v0.3.5 C5): an aborted turn is not a dead turn - no nudge.
    const f12 = makeFake();
    const r12 = await f12.handler(
      { message: { ...deadThinking, stopReason: "aborted" } },
      { ui: undefined },
    );
    check(
      "C5 aborted: no nudge, no audit",
      r12 === undefined && f12.sent.length === 0 && f12.entries.length === 0,
    );

    // Case 13 (v0.3.5 C5): visible text with no marker stays a no-op;
    // the text path owns the decision.
    const f13 = makeFake();
    const r13 = await f13.handler(
      { message: msgWithText("plain prose, no markup") },
      { ui: undefined },
    );
    check(
      "C5 text-no-marker: no nudge (text path owns it)",
      r13 === undefined && f13.sent.length === 0 && f13.entries.length === 0,
    );

    // Case 14 (v0.3.5 C5): the second dead turn escalates; the third is
    // capped (exactly two nudges) and audited as capped.
    const f14 = makeFake();
    await f14.handler({ message: deadThinking }, { ui: undefined });
    await f14.handler({ message: deadThinking }, { ui: undefined });
    await f14.handler({ message: deadThinking }, { ui: undefined });
    check("C5 cap: exactly 2 nudges", f14.sent.length === 2);
    check(
      "C5 cap: second nudge is the firm one",
      f14.sent[1].includes("Do not end the turn inside thinking"),
    );
    check(
      "C5 cap: third dead turn audited capped",
      f14.entries.some(
        (e) => e.event === "thinking-only-empty" && e.capped === true,
      ),
    );
  } finally {
    if (countsBackup !== null) fs.writeFileSync(COUNTS_FILE, countsBackup);
  }
  console.log(failed === 0 ? "\nALL PASS (" + "see above)" : "\n" + failed + " FAILURE(S)");
  process.exit(failed === 0 ? 0 : 1);
})();
