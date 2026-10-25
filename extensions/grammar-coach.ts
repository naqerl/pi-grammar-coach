import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const WIDGET_KEY = "grammar-coach";
const CONFIG_PATH = path.join(os.homedir(), ".pi", "agent", "grammar-coach.json");

type Style = "casual" | "formal";

interface Cfg {
  style: Style;
  model?: string;
}

interface Correction {
  tags: string;
  sentence: string;
}

const ABBREV = /^(mr|mrs|ms|dr|jr|sr|st|vs|etc|e\.g|i\.e)$/i;

function loadCfg(): Cfg {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) as { style?: unknown; model?: unknown };
    return {
      style: raw.style === "formal" ? "formal" : "casual",
      model: typeof raw.model === "string" ? raw.model : undefined,
    };
  } catch {
    return { style: "casual" };
  }
}

function saveCfg(cfg: Cfg): boolean {
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", "utf8");
    return true;
  } catch {
    return false;
  }
}

function lookupModel(ctx: ExtensionContext, spec: string): Model<Api> | undefined {
  const slash = spec.indexOf("/");
  if (slash <= 0 || slash === spec.length - 1) return undefined;
  return ctx.modelRegistry.find(spec.slice(0, slash), spec.slice(slash + 1));
}

function resolveModel(ctx: ExtensionContext, cfg: Cfg): Model<Api> | undefined {
  if (cfg.model && cfg.model !== "default") return lookupModel(ctx, cfg.model);
  return ctx.model;
}

function wordKey(word: string): string {
  return word.toLowerCase().replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, "");
}

function wordsOf(text: string): string[] {
  return text.match(/\S+/g) ?? [];
}

function sameWords(original: string, corrected: string): boolean {
  const a = wordsOf(original);
  const b = wordsOf(corrected);
  if (a.length !== b.length) return false;
  return a.every((word, i) => wordKey(word) === wordKey(b[i] ?? ""));
}

/** Indexes in `corrected` that are insertions or substitutions against `original`. */
function changedWordIndexes(original: string[], corrected: string[]): Set<number> {
  const n = original.length;
  const m = corrected.length;
  const dp: number[][] = [];
  for (let i = 0; i <= n; i++) dp.push(new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (wordKey(original[i] ?? "") === wordKey(corrected[j] ?? "")) dp[i]![j] = dp[i + 1]![j + 1]! + 1;
      else dp[i]![j] = Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const changed = new Set<number>();
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (wordKey(original[i] ?? "") === wordKey(corrected[j] ?? "")) {
      i += 1;
      j += 1;
    } else if (dp[i]![j + 1]! >= dp[i + 1]![j]!) {
      changed.add(j);
      j += 1;
    } else {
      i += 1;
    }
  }
  while (j < m) {
    changed.add(j);
    j += 1;
  }
  return changed;
}

/**
 * Drop a sentence-final period. Keep a period that belongs to the last token
 * (URL, abbreviation, decimal) or that the user already typed on that token.
 */
function stripSentencePeriod(original: string, sentence: string): string {
  const trimmed = sentence.trim();
  if (!trimmed.endsWith(".")) return trimmed;
  const without = trimmed.slice(0, -1);
  const token = without.split(/\s+/).pop() ?? "";
  if (!token) return trimmed;
  if (/[./:@]|\d$/.test(token) || ABBREV.test(token)) return trimmed;
  const origLast = original.trim().split(/\s+/).pop() ?? "";
  const corrLast = trimmed.split(/\s+/).pop() ?? "";
  if (origLast.endsWith(".") && wordKey(origLast) === wordKey(corrLast)) return trimmed;
  return without.trimEnd();
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 160 ? flat.slice(0, 157) + "..." : flat;
}

function buildPrompt(style: Style, text: string): string {
  const tone = style === "formal"
    ? "Use a formal, tech-professional tone."
    : "Keep the user's tone, including informal wording.";
  return [
    "You are an English writing coach for software engineers.",
    "Correct grammar and how the sentences are formulated.",
    tone,
    "Keep names, URLs, commands, and identifiers exactly as written.",
    "Keep the original line and sentence breaks.",
    "Ignore punctuation, casing, and trailing punctuation.",
    "Change only words that are actually wrong.",
    "Return STRICT JSON only, no code fences, no prose:",
    '{"tags":["1-2 word issue"],"sentence":"corrected text"}',
    'Use an empty tags array and exactly "OK" as the sentence if the message is already correct.',
    "",
    "Message:",
    text,
  ].join("\n");
}

function parseCorrection(raw: string): Correction {
  let tags = "";
  let sentence = "";
  const jsonStart = raw.indexOf("{");
  const jsonEnd = raw.lastIndexOf("}");
  if (jsonStart !== -1 && jsonEnd > jsonStart) {
    try {
      const obj = JSON.parse(raw.slice(jsonStart, jsonEnd + 1)) as { tags?: unknown; sentence?: unknown };
      if (Array.isArray(obj.tags)) {
        tags = obj.tags.map((tag) => String(tag).trim()).filter(Boolean).join(", ");
      }
      if (typeof obj.sentence === "string") sentence = obj.sentence.trim();
    } catch {
      // The line fallback below covers a non-JSON reply.
    }
  }
  if (!sentence) {
    const lines = raw.split(/\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.length > 1) {
      tags = (lines[0] ?? "").replace(/^tags:\s*/i, "").trim();
      sentence = lines.slice(1).join(" ").trim();
    } else {
      sentence = lines[0] ?? "";
    }
  }
  return { tags, sentence };
}

function textOf(msg: AssistantMessage): string {
  return msg.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function suggestionLine(theme: Theme, tags: string, reply: string, changed: Set<number>): string {
  let line = theme.fg("accent", "✏");
  if (tags && tags.toLowerCase() !== "none") {
    line += " " + theme.fg("dim", `${tags} ·`);
  }
  const tokens = [...reply.matchAll(/(\S+)(\s*)/g)];
  for (let i = 0; i < tokens.length; i++) {
    const word = tokens[i]?.[1] ?? "";
    const trail = tokens[i]?.[2] ?? "";
    if (i === 0) line += " ";
    line += (changed.has(i) ? theme.fg("warning", word) : word) + trail;
  }
  return line;
}

function log(msg: string): void {
  try {
    fs.appendFileSync("/tmp/grammar-coach.log", new Date().toISOString() + " " + msg + "\n");
  } catch {
    // The coach still works when the log file is not writable.
  }
}

function widget(line: (theme: Theme) => string): (tui: unknown, theme: Theme) => Container {
  return (_tui, theme) => {
    const c = new Container();
    c.addChild(new Text(line(theme), 1, 0));
    return c;
  };
}

export default function (pi: ExtensionAPI) {
  let abort: AbortController | undefined;
  let generation = 0;

  pi.registerCommand("grammar", {
    description: "Grammar coach: /grammar casual|formal|model <provider/id>|status",
    handler: async (args, ctx) => {
      const cfg = loadCfg();
      const parts = (args || "").trim().split(/\s+/);
      const cmd = (parts[0] || "").toLowerCase();

      const saved = (next: Cfg, message: string) => {
        if (!saveCfg(next)) {
          ctx.ui.notify("Grammar coach: could not save ~/.pi/agent/grammar-coach.json", "error");
          return;
        }
        ctx.ui.notify(message, "info");
      };

      if (cmd === "casual" || cmd === "formal") {
        cfg.style = cmd;
        saved(cfg, `Grammar coach style: ${cfg.style}`);
      } else if (cmd === "model") {
        const spec = parts.slice(1).join(" ").trim();
        if (!spec) {
          ctx.ui.notify(`Grammar coach model: ${cfg.model ?? "default (session model)"}`, "info");
        } else if (spec.toLowerCase() === "default") {
          delete cfg.model;
          saved(cfg, "Grammar coach model: default (session model)");
        } else if (!lookupModel(ctx, spec) && ctx.modelRegistry.getAll().length > 0) {
          ctx.ui.notify(`Grammar coach: unknown model ${spec}. Use provider/id or default.`, "warning");
        } else if (!spec.includes("/")) {
          ctx.ui.notify("Grammar coach: model must be provider/id, or default.", "warning");
        } else {
          cfg.model = spec;
          saved(cfg, `Grammar coach model: ${cfg.model}`);
        }
      } else if (cmd === "" || cmd === "status") {
        ctx.ui.notify(`Grammar coach: style=${cfg.style}, model=${cfg.model ?? "default"}`, "info");
      } else {
        ctx.ui.notify("Usage: /grammar casual|formal | /grammar model <provider/id|default> | /grammar status", "warning");
      }
    },
  });

  pi.on("input", (event, ctx) => {
    if (event.source !== "interactive") return;
    if (!ctx.hasUI || ctx.mode !== "tui") return;

    const text = event.text.trim();
    if (!text || text.startsWith("/") || text.startsWith("!") || text.length < 4) {
      if (text.startsWith("/") || text.startsWith("!") || (text.length > 0 && text.length < 4)) {
        generation += 1;
        abort?.abort();
        ctx.ui.setWidget(WIDGET_KEY, undefined);
      }
      return;
    }

    generation += 1;
    const gen = generation;
    abort?.abort();
    abort = new AbortController();
    const signal = abort.signal;
    const stale = () => gen !== generation || signal.aborted;

    ctx.ui.setWidget(WIDGET_KEY, widget((theme) => theme.fg("accent", "✏") + " " + theme.fg("dim", "checking")));

    void (async () => {
      const cfg = loadCfg();
      try {
        log("start text=" + JSON.stringify(text) + " style=" + cfg.style + " model=" + (cfg.model ?? "default"));
        const model = resolveModel(ctx, cfg);
        if (!model) {
          log("no model");
          if (stale()) return;
          ctx.ui.setWidget(WIDGET_KEY, widget((theme) => theme.fg("dim", "grammar: model not found")));
          return;
        }

        const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
        if (stale()) return;
        if (!auth.ok) {
          log("auth failed");
          ctx.ui.setWidget(WIDGET_KEY, widget((theme) => theme.fg("dim", "grammar: " + oneLine(auth.error || "not signed in"))));
          return;
        }

        const sessionId = ctx.sessionManager.getSessionId();
        const headers = { ...(auth.headers ?? {}), ...(sessionId ? { "x-opencode-session": sessionId } : {}) };
        const msg = await completeSimple(model, {
          messages: [{ role: "user", content: buildPrompt(cfg.style, text), timestamp: Date.now() }],
        }, { signal, apiKey: auth.apiKey, headers });
        if (stale()) return;

        if (msg.stopReason === "error") {
          const reason = oneLine(msg.errorMessage || "model error");
          log("error: " + reason);
          ctx.ui.setWidget(WIDGET_KEY, widget((theme) => theme.fg("dim", "grammar: " + reason)));
          return;
        }

        const raw = textOf(msg);
        if (!raw || /^ok\.?$/i.test(raw)) {
          log("no correction needed");
          ctx.ui.setWidget(WIDGET_KEY, undefined);
          return;
        }

        const parsed = parseCorrection(raw);
        const sentence = stripSentencePeriod(text, parsed.sentence);
        if (!sentence || /^ok\.?$/i.test(sentence) || sameWords(text, sentence)) {
          log("no correction needed");
          ctx.ui.setWidget(WIDGET_KEY, undefined);
          return;
        }

        const changed = changedWordIndexes(wordsOf(text), wordsOf(sentence));
        log("tags=" + JSON.stringify(parsed.tags) + " reply=" + JSON.stringify(sentence));
        ctx.ui.setWidget(WIDGET_KEY, widget((theme) => suggestionLine(theme, parsed.tags, sentence, changed)));
      } catch (err: unknown) {
        if (stale() || (err instanceof Error && err.name === "AbortError")) return;
        const message = err instanceof Error ? err.message : String(err);
        log("error: " + message);
        if (stale()) return;
        ctx.ui.setWidget(WIDGET_KEY, widget((theme) => theme.fg("error", "grammar: " + oneLine(message))));
      }
    })();
  });
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function selfTest(): void {
  assert(sameWords("continue", "continue"), "identical");
  assert(sameWords("Hello,", "hello"), "case and comma");
  assert(sameWords("Nice, but it doesn't copy.", "nice but it doesn't copy"), "punctuation only");
  assert(!sameWords("it's wrong", "its wrong"), "apostrophe is grammar");
  assert(!sameWords("and it does not work locally", "It does not work locally"), "dropped word");

  const sub = changedWordIndexes(["that", "was", "rigth"], ["that", "was", "right"]);
  assert(sub.size === 1 && sub.has(2), "substitution");
  const ins = changedWordIndexes(["I", "see", "pane"], ["I", "see", "the", "pane"]);
  assert(ins.size === 1 && ins.has(2), "insertion");
  const del = changedWordIndexes(["and", "reload", "tmux", "by", "yourself"], ["Reload", "tmux", "yourself"]);
  assert(del.size === 0, "deletions stay unmarked");
  const ext = changedWordIndexes(["but", "the", "ext", "is", "still", "wrong"], ["but", "the", "extension", "is", "still", "wrong"]);
  assert(ext.size === 1 && ext.has(2), "word grew");
  const art = changedWordIndexes(wordsOf("I has went to store yesterday"), wordsOf("I went to the store yesterday"));
  assert(art.size === 1 && art.has(3) && wordsOf("I went to the store yesterday")[3] === "the", "article insert");

  assert(stripSentencePeriod("go", "Go.") === "Go", "sentence period");
  assert(stripSentencePeriod("yesterday", "I went to the store yesterday.") === "I went to the store yesterday", "added period");
  assert(
    stripSentencePeriod("see http://127.0.0.1:8090.", "see http://127.0.0.1:8090.") === "see http://127.0.0.1:8090.",
    "url period",
  );
  assert(stripSentencePeriod("wait", "Wait etc.") === "Wait etc.", "abbreviation");
  assert(stripSentencePeriod("Go.", "Go.") === "Go.", "user's own period");

  const parsed = parseCorrection('```json\n{"tags":["article"],"sentence":"I went."}\n```');
  assert(parsed.tags === "article" && parsed.sentence === "I went.", "fenced json");
  const ok = parseCorrection('{"tags":[],"sentence":"OK"}');
  assert(ok.sentence === "OK", "ok sentence");
}

if (process.env.GRAMMAR_COACH_SELFTEST === "1") selfTest();
