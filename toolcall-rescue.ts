/**
 * toolcall-rescue.ts
 *
 * Engine-agnostic safety net for local LLM servers (ninfer, llama.cpp,
 * DS4, vLLM, whatever) whose tool-call parsers silently downgrade to
 * plain text when the model's tool markup is malformed or a quant
 * wobble corrupts the tail.
 *
 * Failure mode guarded: the model emits its tool call as literal
 * markup inside the message text; the server parse fails; the reply
 * arrives with finish_reason "stop" and zero tool_calls; pi sees a
 * normal stop with no calls; the workflow dies silently.
 *
 * Rescue is deterministic (regex in code, never the model):
 *   message_end: assistant msg, stopReason "stop", no real toolCall
 *   blocks, and a fully-closed tool-call block sitting at the very
 *   END of the text -> parsed here, message replaced in place (pi
 *   awaits message_end handlers before the agent loop reads the
 *   final message; the replacement mutates the stored object) with
 *   stopReason "toolUse" + real toolCall blocks. The loop executes
 *   them in the same turn. Zero extra LLM calls.
 *
 *   Partial/malformed tail (marker present but the block is not
 *   closed, or has no parsable parameters): cut from the text so the
 *   poison never lingers in history, plus a words-only followUp
 *   nudge asking the model to re-issue the call for real (capped).
 *
 *   Lost-call (silent stop, 2026-09-07 second incident class): the
 *   engine's parser drops the model's tool call mid-stream - typically
 *   because the model's own generated text (thinking) ends on or
 *   contains a contiguous marker string, which breaks the parser's
 *   lazy parameter scan. The response arrives with a tool-use finish
 *   reason but ZERO tool calls; pi stores the message with
 *   stopReason "toolUse" and no toolCall block; the agent loop has
 *   nothing to execute and the turn ends silently, no error, no
 *   retry. Detected via stopReason + empty toolCall list; the
 *   message is normalized to "stop" (well-formed history) and a
 *   words-only followUp nudge asks for a real re-issue (shares the
 *   nudge cap).
 *
 * Anti-self-priming guard: a complete block followed by prose is an
 * intentional quote/explanation - left alone. Only a block (run) at
 * the very end of the message is rescued.
 *
 * PARSER-HYGIENE NOTE: every marker/tag string below is assembled
 * from fragments at runtime. The literal tag strings must NOT appear
 * in this file's source: a tool call whose payload carries a
 * contiguous closing tag string breaks the server's lazy parameter
 * parse (value terminates early, rest becomes trailing garbage,
 * silent text fallback). This file is the standing example of why.
 *
 * Toggle (if it rescues too eagerly, or you want raw behavior):
 *   /rescue           -> status
 *   /rescue on|off    -> enable / disable
 *   TOOLCALL_RESCUE=on|off (also 1|0, true|false) env var overrides the state file.
 *   State: ~/.pi/agent/data/toolcall-rescue.json (default: on)
 *
 * Trigger accounting (v0.3.0): every intervention (rescue / sanitize /
 * lost-call) is counted persistently in
 *   ~/.pi/agent/data/toolcall-rescue-counts.json
 * (lifetime total, per-type, per provider/model pair, last event).
 * Purely observational - shown in /rescue status, never feeds the
 * decision path. Purpose: answer "how often does the net actually fire,
 * and on which provider/model?" - the triage number for whether the
 * underlying engine bug is worth chasing down.
 *
 * Audit: every intervention -> stderr line "[toolcall-rescue] ..."
 * PLUS a persistent session entry (pi.appendEntry, customType
 * "toolcall-rescue"). The transcript itself is mutated in place by
 * this extension, so the session file keeps an independent record of
 * each intervention (what, when, how much). No removed text is stored
 * (it is the poison); only metadata.
 *
 * Version stamp: /rescue status shows the running version, so a stale
 * hot-reload or a pi-upgrade drift is visible (host-fragility watch item).
 */

export const VERSION = "0.3.0";

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Marker fragments - assembled at runtime, never contiguous in source.
const T = ["tool", "_call"].join("");
const OPEN = "<" + T + ">";
const CLOSE = "</" + T + ">";
const FUNC_OPEN = "<" + "function=";
const FUNC_CLOSE = "</" + "function>";
const PARAM_OPEN = "<" + "parameter=";
const PARAM_CLOSE = "</" + "parameter>";

function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A fully-closed block: open marker, function tag with a name,
// zero or more parameter pairs (see PARAM_RE), closing tags, in order.
const BLOCK_RE = new RegExp(
  esc(OPEN) + "\\s*" +
    esc(FUNC_OPEN) + "([A-Za-z0-9_.-]+)>\\s*" +
    "((?:" + esc(PARAM_OPEN) + "[^>]*>\\s*[\\s\\S]*?\\s*" + esc(PARAM_CLOSE) + ")*)" +
    "\\s*" + esc(FUNC_CLOSE) + "\\s*" + esc(CLOSE),
  "g",
);
const PARAM_RE = new RegExp(
  esc(PARAM_OPEN) + "([^>]*?)>\\s*([\\s\\S]*?)\\s*" + esc(PARAM_CLOSE),
  "g",
);

const PARAM_OPEN_ANY_RE = new RegExp(esc(PARAM_OPEN) + "([^>]*)>", "g");

/**
 * Malformed-nesting salvage: the model opened an inner parameter inside
 * this value and never closed it (it borrowed this parameter's closing
 * tag - the case-B shape). Return the innermost unterminated parameter as
 * {key: parsedValue}. A value whose inner pair is fully closed (open AND
 * close) is legitimate content - return null and leave it alone.
 */
export function recoverInnermost(raw: string): Record<string, unknown> | null {
  let lastIdx = -1;
  for (const m of raw.matchAll(PARAM_OPEN_ANY_RE)) lastIdx = m.index ?? -1;
  if (lastIdx === -1) return null;
  const closeIdx = raw.indexOf(">", lastIdx);
  const after = raw.slice(closeIdx + 1);
  if (after.includes(PARAM_CLOSE)) return null;
  const keyMatch = raw.slice(lastIdx).match(new RegExp("^" + esc(PARAM_OPEN) + "([^>]*)>"));
  if (!keyMatch) return null;
  const key = keyMatch[1].trim();
  if (!key) return null;
  return { [key]: parseValue(after) };
}

function parseValue(raw: string): unknown {
  const s = raw.trim();
  if (s === "") return "";
  if (
    s.startsWith("{") || s.startsWith("[") || s.startsWith("\"") ||
    s === "true" || s === "false" || s === "null" ||
    /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(s)
  ) {
    try {
      return JSON.parse(s);
    } catch {
      /* keep raw string */
    }
  }
  return s;
}

export interface RescuedCall {
  name: string;
  arguments: Record<string, unknown>;
  start: number;
  end: number;
}

export interface RescueAnalysis {
  calls: RescuedCall[];
  malformedTail: boolean;
  cutIndex: number | null;
}

/**
 * Analyze assistant text for leaked tool markup at the END of the
 * message. Pure function - unit-testable without pi.
 */
export function extractTailCalls(text: string): RescueAnalysis {
  const lastOpenIdx = text.lastIndexOf(OPEN);
  if (lastOpenIdx === -1) return { calls: [], malformedTail: false, cutIndex: null };

  const matches = [...text.matchAll(BLOCK_RE)];
  const last = matches[matches.length - 1];

  // A complete block starts exactly at the last marker.
  if (last && last.index === lastOpenIdx) {
    // Prose after the block -> intentional quote/explanation. Leave alone.
    if (text.slice(last.index + last[0].length).trim() !== "") {
      return { calls: [], malformedTail: false, cutIndex: null };
    }
    // Extend left over adjacent blocks (parallel calls).
    let runStart = last.index;
    for (let i = matches.length - 2; i >= 0; i--) {
      const m = matches[i];
      if (text.slice(m.index + m[0].length, runStart).trim() === "") runStart = m.index;
      else break;
    }
    const run = matches.filter((m) => m.index >= runStart);
    const calls: RescuedCall[] = [];
    for (const m of run) {
      const args: Record<string, unknown> = {};
      let n = 0;
      for (const pm of m[2].matchAll(PARAM_RE)) {
        let value = parseValue(pm[2]);
        if (typeof value === "string" && value.includes(PARAM_OPEN)) {
          // Unclosed inner parameter (case-B shape): recover the inner
          // parameter's key/value instead of keeping the garbage outer one.
          const rec = recoverInnermost(value);
          if (rec) {
            for (const [k, v] of Object.entries(rec)) {
              args[k] = v;
              n++;
            }
            continue;
          }
        }
        args[pm[1].trim()] = value;
        n++;
      }
      if (n === 0) {
        // Block closed but no parsable parameters -> malformed tail.
        return { calls: [], malformedTail: true, cutIndex: m.index };
      }
      calls.push({ name: m[1], arguments: args, start: m.index, end: m.index + m[0].length });
    }
    return { calls, malformedTail: false, cutIndex: null };
  }

  // No complete block at the last marker: partial tail.
  const region = text.slice(lastOpenIdx);
  const markupish =
    region.trim() === "" ||
    region.includes(FUNC_OPEN) || region.includes(PARAM_OPEN) ||
    region.includes(CLOSE) || region.includes(FUNC_CLOSE);
  if (markupish) {
    return { calls: [], malformedTail: true, cutIndex: lastOpenIdx };
  }
  // Prose after the marker -> marker quoted mid-sentence. Leave alone.
  return { calls: [], malformedTail: false, cutIndex: null };
}

function stripSpans(text: string, spans: Array<[number, number]>): string {
  let out = "";
  let pos = 0;
  for (const [s, e] of [...spans].sort((a, b) => a[0] - b[0])) {
    out += text.slice(pos, s);
    pos = e;
  }
  out += text.slice(pos);
  return out;
}

// ── Lost-call class (silent stop) ────────────────────────────────────
// The engine reported a tool-use finish but delivered zero tool calls
// (its parser dropped the call mid-stream, usually after the model's
// own generated text contained a contiguous marker string). pi stores
// the message with stopReason "toolUse" and no toolCall block; the
// agent loop has nothing to execute and ends the turn silently.

export interface LostCallVerdict {
  lostCall: boolean;
  markerEvidence: boolean;
}

/**
 * Pure decision: was a tool call signaled but never delivered?
 * Testable without pi.
 */
export function analyzeLostCall(
  stopReason: string,
  contentTypes: string[],
  allText: string,
): LostCallVerdict {
  if (stopReason !== "toolUse" || contentTypes.includes("toolCall")) {
    return { lostCall: false, markerEvidence: false };
  }
  return { lostCall: true, markerEvidence: hasMarkerEvidence(allText) };
}

/** True if any known marker string (assembled fragments) is present. */
export function hasMarkerEvidence(text: string): boolean {
  return (
    text.includes(OPEN) ||
    text.includes(CLOSE) ||
    text.includes(FUNC_OPEN) ||
    text.includes(FUNC_CLOSE) ||
    text.includes(PARAM_OPEN) ||
    text.includes(PARAM_CLOSE)
  );
}

// ── Toggle state ────────────────────────────────────────────────────────
const STATE_FILE = path.join(os.homedir(), ".pi", "agent", "data", "toolcall-rescue.json");
const MAX_RESCUES = 15;
const MAX_NUDGES = 3;

function readState(): { enabled: boolean } {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    if (typeof s.enabled === "boolean") return { enabled: s.enabled };
  } catch {
    /* no state file or bad JSON -> default */
  }
  return { enabled: true };
}

export function isEnabled(): boolean {
  const env = (process.env.TOOLCALL_RESCUE ?? "").trim().toLowerCase();
  if (env === "1" || env === "on" || env === "true") return true;
  if (env === "0" || env === "off" || env === "false") return false;
  return readState().enabled;
}

function setEnabled(v: boolean): void {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(
      STATE_FILE,
      JSON.stringify({ enabled: v, updated: new Date().toISOString() }, null, 2),
    );
  } catch (e) {
    log("failed to persist state: " + e);
  }
}

// ── Trigger accounting (persistent, observational) ───────────────────
const COUNTS_FILE = path.join(os.homedir(), ".pi", "agent", "data", "toolcall-rescue-counts.json");

export type TriggerType = "rescue" | "sanitize" | "lostCall";

export interface TriggerCounts {
  total: number;
  byType: { rescue: number; sanitize: number; lostCall: number };
  byPair: Record<string, number>; // "provider/model" -> count
  last: { type: TriggerType; provider: string; model: string; ts: string } | null;
}

export function emptyCounts(): TriggerCounts {
  return { total: 0, byType: { rescue: 0, sanitize: 0, lostCall: 0 }, byPair: {}, last: null };
}

export function loadCounts(): TriggerCounts {
  try {
    const s = JSON.parse(fs.readFileSync(COUNTS_FILE, "utf8"));
    if (s && typeof s.total === "number" && s.byType && typeof s.byType.rescue === "number") {
      return {
        total: s.total,
        byType: {
          rescue: s.byType.rescue,
          sanitize: s.byType.sanitize ?? 0,
          lostCall: s.byType.lostCall ?? 0,
        },
        byPair: s.byPair && typeof s.byPair === "object" ? s.byPair : {},
        last: s.last && typeof s.last.type === "string" ? s.last : null,
      };
    }
  } catch {
    /* no counts file or corrupt JSON -> fresh */
  }
  return emptyCounts();
}

/** Pure: one intervention increments total, byType, byPair and sets last. */
export function bumpCounts(
  c: TriggerCounts,
  type: TriggerType,
  provider: string | undefined,
  model: string | undefined,
  ts: string,
): TriggerCounts {
  const prov = provider && provider.trim() ? provider : "unknown";
  const mod = model && model.trim() ? model : "unknown";
  const pair = prov + "/" + mod;
  const byType = { ...c.byType };
  byType[type] += 1;
  return {
    total: c.total + 1,
    byType,
    byPair: { ...c.byPair, [pair]: (c.byPair[pair] ?? 0) + 1 },
    last: { type, provider: prov, model: mod, ts },
  };
}

/** Pure: top-N "provider/model" pairs by count desc, then key asc. */
export function topPairs(c: TriggerCounts, n = 3): Array<[string, number]> {
  return Object.entries(c.byPair)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n);
}

function saveCounts(c: TriggerCounts): void {
  try {
    fs.mkdirSync(path.dirname(COUNTS_FILE), { recursive: true });
    fs.writeFileSync(COUNTS_FILE, JSON.stringify(c, null, 2));
  } catch {
    /* best-effort; never crash the session over bookkeeping */
  }
}

function countsLine(c: TriggerCounts): string {
  const parts = [
    "lifetime: " + c.total +
      " (R" + c.byType.rescue + " S" + c.byType.sanitize + " L" + c.byType.lostCall + ")",
  ];
  const top = topPairs(c, 3);
  if (top.length > 0) {
    parts.push("top: " + top.map(([k, v]) => k + "=" + v).join(", "));
  }
  if (c.last) {
    parts.push("last: " + c.last.type + " @ " + c.last.provider + "/" + c.last.model + " " + c.last.ts);
  }
  return parts.join(" | ");
}

function log(msg: string): void {
  try {
    process.stderr.write("[toolcall-rescue] " + msg + "\n");
  } catch {
    /* never crash the session because of logging */
  }
}

export default function toolcallRescue(pi: ExtensionAPI) {
  const stats = { rescues: 0, nudges: 0, lostCalls: 0, capNotified: false };
  let counts = loadCounts();
  const audit = (event: string, detail: Record<string, unknown>): void => {
    try {
      pi.appendEntry("toolcall-rescue", {
        version: VERSION,
        event,
        ts: new Date().toISOString(),
        ...detail,
      });
    } catch {
      /* audit is best-effort; never crash the session */
    }
  };

  pi.on("message_end", async (event, ctx) => {
    const msg = event.message;
    if (msg.role !== "assistant") return;
    if (!isEnabled()) return;

    // Count an intervention (persistent + provider/model attribution).
    // Observational only - never feeds the decision path.
    const note = (type: TriggerType): void => {
      counts = bumpCounts(
        counts,
        type,
        (msg as { provider?: string }).provider,
        (msg as { model?: string }).model,
        new Date().toISOString(),
      );
      saveCounts(counts);
    };

    // ── Lost-call class: tool-use finish, zero calls delivered ────────
    const allText = msg.content
      .map((b) => {
        const bb = b as { type: string; text?: string; thinking?: string };
        return bb.text ?? bb.thinking ?? "";
      })
      .join("\n");
    const lost = analyzeLostCall(msg.stopReason, msg.content.map((b) => b.type), allText);
    if (lost.lostCall) {
      stats.lostCalls++;
      note("lostCall");
      log(
        "lost tool call: finish signaled tool use but zero calls delivered (marker evidence: " +
          lost.markerEvidence +
          "); normalizing stopReason and nudging re-issue",
      );
      audit("lost-call", {
        provider: (msg as { provider?: string }).provider,
        model: (msg as { model?: string }).model,
        markerEvidence: lost.markerEvidence,
      });
      if (stats.nudges < MAX_NUDGES) {
        stats.nudges++;
        try {
          await pi.sendUserMessage(
            "Your previous reply said it would use a tool, but the engine delivered no tool call - it was dropped before reaching pi. Re-issue the intended tool call now, as a real tool call.",
            { deliverAs: "followUp" },
          );
          log("lost-call nudge delivered (" + stats.nudges + "/" + MAX_NUDGES + ")");
        } catch (e) {
          log("lost-call nudge failed: " + e);
        }
      } else {
        log("lost-call nudge cap reached; normalized only");
      }
      return { message: { ...msg, stopReason: "stop" as const } as typeof msg };
    }

    if (msg.stopReason !== "stop") return;
    if (msg.content.some((b) => b.type === "toolCall")) return;

    const text = msg.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    if (!text.includes(OPEN)) return;

    const r = extractTailCalls(text);

    if (r.calls.length > 0) {
      if (stats.rescues >= MAX_RESCUES) {
        if (!stats.capNotified) {
          stats.capNotified = true;
          log("rescue cap reached (" + MAX_RESCUES + "); notifying user");
          try {
            await pi.sendUserMessage(
              "toolcall-rescue: this model has leaked tool-call markup as literal text " +
                MAX_RESCUES +
                " times this session; auto-rescue is now disabled. The model/engine tool parser pairing appears broken - consider switching models or inspecting the server's tool-call parser.",
              { deliverAs: "followUp" },
            );
          } catch (e) {
            log("cap notice failed: " + e);
          }
        }
        return;
      }
      stats.rescues++;
      note("rescue");
      const toolCalls = r.calls.map((c, i) => ({
        type: "toolCall" as const,
        id: "rescue-" + Date.now() + "-" + i,
        name: c.name,
        arguments: c.arguments,
      }));
      const remaining = stripSpans(
        text,
        r.calls.map((c) => [c.start, c.end] as [number, number]),
      ).trim();
      const content = [
        ...msg.content.filter((b) => b.type !== "text"),
        ...(remaining ? [{ type: "text" as const, text: remaining }] : []),
        ...toolCalls,
      ];
      const names = toolCalls.map((t) => t.name).join(", ");
      log("rescued " + toolCalls.length + " tool call(s) from text: " + names);
      audit("rescue", {
        provider: (msg as { provider?: string }).provider,
        model: (msg as { model?: string }).model,
        names,
        count: toolCalls.length,
      });
      try {
        ctx.ui?.notify?.("[toolcall-rescue] rescued: " + names, "info");
      } catch {
        /* non-UI mode */
      }
      return { message: { ...msg, content, stopReason: "toolUse" as const } as typeof msg };
    }

    if (r.malformedTail && r.cutIndex !== null) {
      note("sanitize");
      const prefix = text.slice(0, r.cutIndex).trim();
      const note = prefix
        ? prefix + "\n\n[toolcall-rescue: removed malformed tool-call text at end of previous reply]"
        : "[toolcall-rescue: removed malformed tool-call text from previous reply]";
      const content = [
        ...msg.content.filter((b) => b.type !== "text"),
        { type: "text" as const, text: note },
      ];
      log("malformed tail sanitized (" + (text.length - r.cutIndex) + " chars removed)");
      audit("sanitize", {
        provider: (msg as { provider?: string }).provider,
        model: (msg as { model?: string }).model,
        charsRemoved: text.length - r.cutIndex,
      });
      if (stats.nudges < MAX_NUDGES) {
        stats.nudges++;
        try {
          await pi.sendUserMessage(
            "Your previous reply ended with a tool call that was emitted as raw text instead of a structured tool call. It could not be recovered and was removed. Re-issue the intended tool call now, as a real tool call.",
            { deliverAs: "followUp" },
          );
          log("nudge delivered (" + stats.nudges + "/" + MAX_NUDGES + ")");
        } catch (e) {
          log("nudge failed: " + e);
        }
      } else {
        log("nudge cap reached; sanitized only");
      }
      return { message: { ...msg, content } as typeof msg };
    }
  });

  pi.registerCommand("rescue", {
    description: "toolcall-rescue: on | off | status",
    handler: async (args, ctx) => {
      const a = args.trim().toLowerCase();
      if (a === "on") {
        setEnabled(true);
        ctx.ui.notify("toolcall-rescue: ON", "info");
        log("enabled via /rescue on");
      } else if (a === "off") {
        setEnabled(false);
        ctx.ui.notify("toolcall-rescue: OFF", "info");
        log("disabled via /rescue off");
      } else {
        const env = process.env.TOOLCALL_RESCUE;
        ctx.ui.notify(
          "toolcall-rescue: " + (isEnabled() ? "ON" : "OFF") +
            (env === "0" || env === "1" ? " (env override TOOLCALL_RESCUE=" + env + ")" : "") +
            " | this process: " + stats.rescues + " rescued, " + stats.nudges + " nudged, " + stats.lostCalls + " lost-call(s) normalized"
            + " | " + countsLine(counts) + " | v" + VERSION,
          "info",
        );
      }
    },
  });

  log("loaded v" + VERSION + " (enabled=" + isEnabled() + ")");
}
