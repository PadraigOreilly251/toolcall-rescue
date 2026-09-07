/**
 * toolcall-rescue.test.ts — tests for the installed extension
 * (~/.pi/agent/extensions/toolcall-rescue.ts).
 *
 * Run: node toolcall-rescue.test.ts
 *
 * PARSER-HYGIENE (same rule as the extension itself): no contiguous
 * kill-marker string anywhere in this file. All tag constants are
 * assembled from fragments at runtime; the captured fixtures are built
 * by concatenation.
 *
 * PROVENANCE: originally written to /tmp on 2026-09-07 ~00:29 (first
 * write leaked as raw text - the engine parser broke on the payload and
 * the extension's sanitize path cut it). Re-issued successfully minutes
 * later (failure is stochastic). /tmp was wiped by a host reboot at
 * 05:37; this is the permanent copy (recreated from context, verified
 * 22/22 green after recreation). 2026-09-07 13:30: case J added for the
 * lost-call class (tool-use finish, zero calls delivered -> silent
 * stop); the extension gained analyzeLostCall() for it.
 */
import { extractTailCalls, recoverInnermost, isEnabled, analyzeLostCall, hasMarkerEvidence } from "/home/erpod/.pi/agent/extensions/toolcall-rescue.ts";

const T = ["tool", "_call"].join("");
const OPEN = "<" + T + ">";
const CLOSE = "</" + T + ">";
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

// ── captured failure A: prose quotes the format, then a real block at the END
const CASE_A =
  "I've confirmed the template uses the " + OPEN + FO + "...> XML format. Now I'll examine it.\n\n" +
  OPEN + "\n" + FO + "bash>\n" + PO + "command>\ndate\n" + PC + "\n" + FC + "\n" + CLOSE;

// ── captured failure B: original incident. Outer param never closed;
//    the inner param borrows its closing tag
const CASE_B =
  OPEN + "\n" + FO + "quest>\n" + PO + "add>\n" + PO + "descriptions>\n" +
  '["Break down free space"]\n' + PC + "\n" + FC + "\n" + CLOSE;

// ── captured case C: mention only, bare marker in prose. Must NOT fire
const CASE_C =
  "The bug is that the model writes " + OPEN + " tags into its text sometimes. Let me check the logs.";

// ── guardrail D: complete block in the MIDDLE, prose after. Intentional quote.
const CASE_D =
  "Look at this example:\n" +
  OPEN + "\n" + FO + "bash>\n" + PO + "command>\ndate\n" + PC + "\n" + FC + "\n" + CLOSE +
  "\nThat is the format.";

// ── guardrail E: truncated tail (marker present, block not closed)
const CASE_E =
  "Doing it now\n" + OPEN + "\n" + FO + "bash>\n" + PO + "command>\ndate\n" + PC;

// ── guardrail F: two adjacent complete blocks at the tail (parallel calls)
const CASE_F =
  OPEN + "\n" + FO + "bash>\n" + PO + "command>\ndate\n" + PC + "\n" + FC + "\n" + CLOSE +
  OPEN + "\n" + FO + "read>\n" + PO + "path>\n" + '"file.txt"' + "\n" + PC + "\n" + FC + "\n" + CLOSE;

// ── guardrail G: plain text, no marker at all
const CASE_G = "All good, no tags here.";

// ── guardrail H: single block, numeric arg
const CASE_H = OPEN + "\n" + FO + "t>\n" + PO + "n>\n42\n" + PC + "\n" + FC + "\n" + CLOSE;

// A — must fire; extract bash/command from the REAL block, not the prose mention
const a = extractTailCalls(CASE_A);
check("A: fires with exactly 1 call", a.calls.length === 1, a);
check("A: not flagged malformed", a.malformedTail === false && a.cutIndex === null, a);
check("A: name=bash", a.calls[0]?.name === "bash", a.calls[0]);
check("A: args={command:date}", a.calls[0]?.arguments?.command === "date", a.calls[0]?.arguments);

// B — must fire; best-effort: name=quest, descriptions recovered from inner param
const b = extractTailCalls(CASE_B);
check("B: fires with exactly 1 call", b.calls.length === 1, b);
check("B: name=quest", b.calls[0]?.name === "quest", b.calls[0]);
check(
  "B: inner key 'descriptions' recovered",
  Array.isArray(b.calls[0]?.arguments?.descriptions),
  b.calls[0]?.arguments,
);
check(
  "B: value parsed as JSON array",
  JSON.stringify(b.calls[0]?.arguments?.descriptions) === JSON.stringify(["Break down free space"]),
  b.calls[0]?.arguments,
);
check("B: outer garbage key 'add' dropped", !("add" in (b.calls[0]?.arguments ?? {})), b.calls[0]?.arguments);

// C — must NOT fire
const c = extractTailCalls(CASE_C);
check("C: silent (no calls, no cut)", c.calls.length === 0 && c.malformedTail === false && c.cutIndex === null, c);

// D — block mid-message with prose after: leave alone
const d = extractTailCalls(CASE_D);
check("D: silent (prose follows block)", d.calls.length === 0 && d.malformedTail === false, d);

// E — truncated tail: flag malformed, cut at the marker
const e = extractTailCalls(CASE_E);
check(
  "E: flagged malformed with cut at marker",
  e.malformedTail === true && e.cutIndex === CASE_E.lastIndexOf(OPEN),
  e,
);
check("E: no calls extracted", e.calls.length === 0, e);

// F — parallel blocks at the tail: both rescued
const f = extractTailCalls(CASE_F);
check("F: both calls rescued", f.calls.length === 2 && f.calls[0]?.name === "bash" && f.calls[1]?.name === "read", f);
check("F: quoted-string arg JSON-parsed", f.calls[1]?.arguments?.path === "file.txt", f.calls[1]?.arguments);

// G — plain text
const g = extractTailCalls(CASE_G);
check("G: silent (no marker)", g.calls.length === 0 && g.malformedTail === false, g);

// H — numeric arg + recoverInnermost sanity
const h = extractTailCalls(CASE_H);
check("H: numeric arg parsed as number", h.calls[0]?.arguments?.n === 42, h.calls[0]?.arguments);
check(
  "H: fully-closed inner param is legitimate content (null)",
  recoverInnermost(PO + "inner>value " + PC) === null,
);
check("H: unterminated inner param recovered", recoverInnermost(PO + "inner>value")?.inner === "value");

// I — env override
process.env.TOOLCALL_RESCUE = "off";
check("I: TOOLCALL_RESCUE=off disables", isEnabled() === false);
process.env.TOOLCALL_RESCUE = "on";
check("I: TOOLCALL_RESCUE=on enables", isEnabled() === true);
delete process.env.TOOLCALL_RESCUE;
check("I: no env -> default on", isEnabled() === true);

// J — lost-call class: tool-use finish, zero calls delivered (silent stop)
check(
  "J: toolUse + no toolCall block = lost call",
  analyzeLostCall("toolUse", ["thinking"], "plain thinking").lostCall === true,
);
check(
  "J: no marker evidence in plain thinking",
  analyzeLostCall("toolUse", ["thinking"], "plain thinking").markerEvidence === false,
);
check(
  "J: marker evidence detected in thinking",
  analyzeLostCall("toolUse", ["thinking"], "checking " + OPEN + " and " + CLOSE).markerEvidence === true,
);
check(
  "J: toolUse WITH a toolCall block is NOT lost",
  analyzeLostCall("toolUse", ["thinking", "toolCall"], OPEN).lostCall === false,
);
check(
  "J: stop finish is NOT a lost call",
  analyzeLostCall("stop", ["thinking"], OPEN).lostCall === false,
);
check("J: hasMarkerEvidence true on function tag", hasMarkerEvidence(FO + "bash>") === true);
check("J: hasMarkerEvidence true on bare close marker", hasMarkerEvidence(CLOSE) === true);
check("J: hasMarkerEvidence false on prose", hasMarkerEvidence("no tags here") === false);

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail === 0 ? 0 : 1);
