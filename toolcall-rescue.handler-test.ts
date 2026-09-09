/**
 * toolcall-rescue.handler-test.ts — handler-level regression tests
 * for the installed extension (~/.pi/agent/extensions/toolcall-rescue.ts).
 *
 * Run: node --experimental-strip-types toolcall-rescue.handler-test.ts
 *
 * WHY THIS EXISTS (v0.3.1, 2026-09-09): the pure-function suite (cases
 * A-K) never drives the message_end handler, so the v0.3.0 TDZ bug
 * (inner `const note` in the sanitize branch shadowing the counter
 * function `note`) shipped and crashed in the wild at 2026-09-09
 * 07:59Z: a leaked reply was classified correctly, then the handler
 * threw ReferenceError at `note("sanitize")` — no cut, no nudge, no
 * audit. This test fires the real handler through a pi mock and
 * asserts the observable effects of each branch: replacement content,
 * nudge, audit entry, and the persistent counter increment.
 *
 * ISOLATION: the extension resolves ~/.pi/agent/data/* via os.homedir()
 * at import time, so HOME is pointed at a fresh tmpdir BEFORE the
 * dynamic import. Production state/counter files are never touched.
 *
 * PARSER-HYGIENE: same rule as the main suite — no contiguous tag
 * string in source; all fixtures assembled from fragments.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "tcr-handler-"));
process.env.HOME = HOME;

const mod = await import("/home/erpod/.pi/agent/extensions/toolcall-rescue.ts");

const T = ["tool", "_call"].join("");
const OPEN = "<" + T + ">";
const FO = "<" + "function=";
const FC = "</" + "function>";
const PO = "<" + "parameter=";
const PC = "</" + "parameter>";

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    pass++;
    console.log("PASS  " + label);
  } else {
    fail++;
    console.log("FAIL  " + label + (detail !== undefined ? "  got: " + JSON.stringify(detail) : ""));
  }
}

interface Handler {
  (event: { message: Record<string, unknown> }, ctx: unknown): Promise<unknown>;
}
function makePi() {
  let handler: Handler = async () => undefined;
  const entries: Array<Record<string, unknown>> = [];
  const nudges: string[] = [];
  const pi: Record<string, unknown> = {
    on: (ev: string, fn: Handler) => {
      if (ev === "message_end") handler = fn;
    },
    registerCommand: () => undefined,
    appendEntry: (_type: string, data: Record<string, unknown>) => {
      entries.push(data);
    },
    sendUserMessage: async (text: string) => {
      nudges.push(text);
    },
  };
  mod.default(pi);
  return {
    fire: (msg: Record<string, unknown>) => handler({ message: msg }, { ui: undefined }),
    entries,
    nudges,
  };
}

const COUNTS_FILE = path.join(HOME, ".pi", "agent", "data", "toolcall-rescue-counts.json");
function readCounts(): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(COUNTS_FILE, "utf8"));
  } catch {
    return null;
  }
}

// ── L: SANITIZE branch — the exact v0.3.0 crash shape ─────────────────
// Truncated tail (marker present, block never closed): classified
// malformed by extractTailCalls, cut at the marker. In v0.3.0 the
// handler threw ReferenceError (TDZ) at the counter call before any
// of these effects could happen.
{
  const m = makePi();
  const text =
    "Doing it now\n" + OPEN + "\n" + FO + "bash>\n" + PO + "command>\ndate\n" + PC;
  const msg: Record<string, unknown> = {
    role: "assistant",
    stopReason: "stop",
    content: [{ type: "text", text }],
    provider: "ninfer",
    model: "qwen3.8-27b",
  };
  let threw: unknown = null;
  let result: any = null;
  try {
    result = await m.fire(msg);
  } catch (e) {
    threw = e;
  }
  check("L: sanitize branch does not throw (v0.3.0 TDZ regression)", threw === null, threw);
  const outText = result?.message?.content?.find?.((b: any) => b.type === "text")?.text ?? "";
  check("L: tail cut + cut-note in replacement", outText.includes("removed malformed tool-call text"), outText);
  check("L: marker gone from replacement", !outText.includes(OPEN), outText);
  check("L: stopReason stays stop", result?.message?.stopReason === "stop", result?.message?.stopReason);
  check("L: nudge delivered (re-issue ask)", m.nudges.length === 1 && m.nudges[0].includes("emitted as raw text"), m.nudges);
  check("L: audit entry written", m.entries.length === 1 && m.entries[0].event === "sanitize", m.entries);
  const c1 = readCounts();
  check("L: counter sanitize=1 (note() ran end-to-end)", c1 !== null && (c1 as any).byType?.sanitize === 1, c1);
  check("L: counter provider/model pair", c1 !== null && (c1 as any).byPair?.["ninfer/qwen3.8-27b"] === 1, c1);
}

// ── M: RESCUE branch — closed block at tail -> real tool calls ───────
{
  const m = makePi();
  const text =
    "I'll run it.\n\n" +
    OPEN + "\n" + FO + "bash>\n" + PO + "command>\ndate\n" + PC + "\n" + FC + "\n" + "</" + T + ">";
  const msg: Record<string, unknown> = {
    role: "assistant",
    stopReason: "stop",
    content: [{ type: "text", text }],
    provider: "ninfer",
    model: "qwen3.8-27b",
  };
  let threw: unknown = null;
  let result: any = null;
  try {
    result = await m.fire(msg);
  } catch (e) {
    threw = e;
  }
  check("M: rescue branch does not throw", threw === null, threw);
  const calls = (result?.message?.content ?? []).filter((b: any) => b.type === "toolCall");
  check("M: 1 real toolCall block (name=bash)", calls.length === 1 && calls[0].name === "bash", calls);
  check("M: id is rescue-*", typeof calls[0]?.id === "string" && calls[0].id.startsWith("rescue-"), calls[0]?.id);
  check("M: stopReason flipped to toolUse", result?.message?.stopReason === "toolUse", result?.message?.stopReason);
  check("M: no nudge on rescue", m.nudges.length === 0, m.nudges);
  check("M: audit entry written", m.entries.length === 1 && m.entries[0].event === "rescue", m.entries);
  const c2 = readCounts();
  check("M: counter rescue=1", c2 !== null && (c2 as any).byType?.rescue === 1, c2);
}

// ── N: LOST-CALL branch — tool-use finish, zero calls delivered ──────
{
  const m = makePi();
  const msg: Record<string, unknown> = {
    role: "assistant",
    stopReason: "toolUse",
    content: [{ type: "thinking", thinking: "I will now run the check." }],
    provider: "ninfer",
    model: "qwen3.8-27b",
  };
  let threw: unknown = null;
  let result: any = null;
  try {
    result = await m.fire(msg);
  } catch (e) {
    threw = e;
  }
  check("N: lost-call branch does not throw", threw === null, threw);
  check("N: stopReason normalized to stop", result?.message?.stopReason === "stop", result?.message?.stopReason);
  check("N: nudge delivered (re-issue ask)", m.nudges.length === 1 && m.nudges[0].includes("delivered no tool call"), m.nudges);
  check("N: audit entry written", m.entries.length === 1 && m.entries[0].event === "lost-call", m.entries);
  const c3 = readCounts();
  check("N: counter lostCall=1", c3 !== null && (c3 as any).byType?.lostCall === 1, c3);
}

// ── P: silent paths — plain stop text, stop WITH real calls ──────────
{
  const m = makePi();
  const r1: any = await m.fire({
    role: "assistant",
    stopReason: "stop",
    content: [{ type: "text", text: "All good, no tags." }],
    provider: "ninfer",
    model: "qwen3.8-27b",
  });
  check("P: plain stop text -> handler returns undefined", r1 === undefined, r1);
  const r2: any = await m.fire({
    role: "assistant",
    stopReason: "stop",
    content: [{ type: "text", text: "Running." }, { type: "toolCall", id: "x", name: "bash", arguments: {} }],
    provider: "ninfer",
    model: "qwen3.8-27b",
  });
  check("P: stop WITH real toolCall -> untouched", r2 === undefined, r2);
  check("P: no side effects on silent paths", m.nudges.length === 0 && m.entries.length === 0, {
    nudges: m.nudges,
    entries: m.entries,
  });
  const c4 = readCounts();
  check("P: counter unchanged by silent paths", c4 !== null && (c4 as any).total === 3, c4);
}

check("P: VERSION stamp is 0.3.1", mod.VERSION === "0.3.1", mod.VERSION);

console.log("\n" + pass + " passed, " + fail + " failed");
console.log("(isolated HOME: " + HOME + ")");
process.exit(fail === 0 ? 0 : 1);
