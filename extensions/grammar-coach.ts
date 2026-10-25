import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

const WIDGET_KEY = "grammar-coach";
const CONFIG_PATH = path.join(os.homedir(), ".pi", "agent", "grammar-coach.json");
const DEFAULT_DB_PATH = path.join(os.homedir(), ".pi", "agent", "grammar-coach.db");

type Style = "casual" | "formal";

interface Cfg {
  style: Style;
  model?: string;
}

interface GrammarError {
  tag: string;
  wrong: string;
  fix: string;
}

interface Correction {
  tags: string;
  sentence: string;
  errors: GrammarError[];
}

interface Mask {
  token: string;
  phrase: string;
}

interface DictNotice {
  text: string;
  level: "info" | "warning" | "error";
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizePhrase(phrase: string): string | undefined {
  const clean = phrase.replace(/\s+/g, " ").trim();
  if (!clean || clean.length > 80) return undefined;
  return clean;
}

/** Replace protected spellings with tokens the model is told to copy. */
function maskPhrases(text: string, phrases: string[]): { text: string; masks: Mask[] } {
  const masks: Mask[] = [];
  const sorted = [...new Set(phrases.map((phrase) => phrase.trim()).filter(Boolean))].sort((a, b) => b.length - a.length);
  let out = text;
  for (const phrase of sorted) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(phrase)}(?![\\p{L}\\p{N}])`, "giu");
    out = out.replace(re, (found) => {
      const token = `GRAMMARDICT${masks.length}`;
      masks.push({ token, phrase: found });
      return token;
    });
  }
  return { text: out, masks };
}

function unmask(text: string, masks: Mask[]): string {
  const ordered = [...masks].sort((a, b) => b.token.length - a.token.length);
  let out = text;
  for (const mask of ordered) out = out.split(mask.token).join(mask.phrase);
  return out;
}

function squash(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/** Put a protected spelling back when the model rewrites it (zeroshot → zero-shot). */
function restoreProtected(corrected: string, surfaces: string[]): string {
  let out = corrected;
  const ordered = [...surfaces].sort((a, b) => squash(b).length - squash(a).length);
  for (const surface of ordered) {
    if (!surface || out.includes(surface)) continue;
    const key = squash(surface);
    if (!key) continue;
    const tokens = [...out.matchAll(/\S+/g)];
    let start = -1;
    let end = -1;
    for (let i = 0; i < tokens.length && start === -1; i++) {
      let acc = "";
      for (let j = i; j < Math.min(tokens.length, i + 6); j++) {
        acc += squash(tokens[j]?.[0] ?? "");
        if (acc === key) {
          start = i;
          end = j;
          break;
        }
        if (acc.length > key.length) break;
      }
    }
    if (start === -1 || end === -1) continue;
    const from = tokens[start]?.index ?? -1;
    const last = tokens[end]?.[0] ?? "";
    const lastIndex = tokens[end]?.index ?? -1;
    if (from < 0 || lastIndex < 0) continue;
    out = out.slice(0, from) + surface + out.slice(lastIndex + last.length);
  }
  return out;
}

function protectedError(err: GrammarError, surfaces: string[]): boolean {
  const wrong = squash(err.wrong);
  const fix = squash(err.fix);
  if (!wrong && !fix) return false;
  return surfaces.some((surface) => {
    const key = squash(surface);
    return key !== "" && (wrong === key || fix === key);
  });
}

function buildPrompt(style: Style, text: string, phrases: string[], masked: boolean): string {
  const tone = style === "formal"
    ? "Use a formal, tech-professional tone."
    : "Keep the user's tone, including informal wording.";
  const lines = [
    "You are an English writing coach for software engineers.",
    "Correct grammar and how the sentences are formulated.",
    tone,
    "Keep names, URLs, commands, and identifiers exactly as written.",
    "Keep the original line and sentence breaks.",
    "Ignore punctuation, casing, and trailing punctuation.",
    "Change only words that are actually wrong.",
  ];
  if (phrases.length > 0) {
    lines.push("These spellings are correct. Never change them: " + phrases.join(", ") + ".");
  }
  if (masked) {
    lines.push("The message contains GRAMMARDICTn tokens. Copy every GRAMMARDICTn token exactly. Each one is a protected spelling.");
  }
  lines.push(
    "Return STRICT JSON only, no code fences, no prose:",
    '{"tags":["1-2 word issue"],"sentence":"corrected text","errors":[{"tag":"1-2 word issue","wrong":"exact span from the message","fix":"replacement for that span"}]}',
    "tags summarizes the errors. errors lists each actual mistake: wrong is copied from the message, fix is only what replaces that span.",
    'If the message is already correct, use an empty tags array, an empty errors array, and exactly "OK" as the sentence.',
    "",
    "Message:",
    text,
  );
  return lines.join("\n");
}

function parseErrors(value: unknown): GrammarError[] {
  if (!Array.isArray(value)) return [];
  const errors: GrammarError[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const rec = item as { tag?: unknown; wrong?: unknown; fix?: unknown };
    const tag = typeof rec.tag === "string" ? rec.tag.trim() : "";
    const wrong = typeof rec.wrong === "string" ? rec.wrong.trim() : "";
    const fix = typeof rec.fix === "string" ? rec.fix.trim() : "";
    if (!tag || !wrong || !fix || wrong === fix) continue;
    errors.push({ tag, wrong, fix });
  }
  return errors;
}

function parseCorrection(raw: string): Correction {
  let tags = "";
  let sentence = "";
  let errors: GrammarError[] = [];
  const jsonStart = raw.indexOf("{");
  const jsonEnd = raw.lastIndexOf("}");
  if (jsonStart !== -1 && jsonEnd > jsonStart) {
    try {
      const obj = JSON.parse(raw.slice(jsonStart, jsonEnd + 1)) as { tags?: unknown; sentence?: unknown; errors?: unknown };
      if (Array.isArray(obj.tags)) {
        tags = obj.tags.map((tag) => String(tag).trim()).filter(Boolean).join(", ");
      }
      if (typeof obj.sentence === "string") sentence = obj.sentence.trim();
      errors = parseErrors(obj.errors);
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
  return { tags, sentence, errors };
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

let db: DatabaseSync | undefined;
let dbPath: string | undefined;

function dbFile(): string {
  return process.env.GRAMMAR_COACH_DB || DEFAULT_DB_PATH;
}

function openDb(): DatabaseSync {
  const wanted = dbFile();
  if (db && dbPath === wanted) return db;
  db?.close();
  fs.mkdirSync(path.dirname(wanted), { recursive: true });
  db = new DatabaseSync(wanted);
  dbPath = wanted;
  db.exec(`
    CREATE TABLE IF NOT EXISTS dictionary (
      phrase TEXT PRIMARY KEY COLLATE NOCASE,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS errors (
      id INTEGER PRIMARY KEY,
      created_at TEXT NOT NULL,
      style TEXT NOT NULL,
      tag TEXT NOT NULL,
      wrong TEXT NOT NULL,
      fix TEXT NOT NULL,
      original TEXT NOT NULL,
      corrected TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS errors_created_at ON errors (created_at);
  `);
  return db;
}

function closeDb(): void {
  db?.close();
  db = undefined;
  dbPath = undefined;
}

function listPhrases(): string[] {
  try {
    const rows = openDb().prepare("SELECT phrase FROM dictionary ORDER BY phrase COLLATE NOCASE").all();
    return rows.map((row) => String(row.phrase));
  } catch (err: unknown) {
    log("dictionary: " + (err instanceof Error ? err.message : String(err)));
    return [];
  }
}

function addPhrase(phrase: string): "added" | "exists" | "invalid" {
  const clean = normalizePhrase(phrase);
  if (!clean) return "invalid";
  const database = openDb();
  const existing = database.prepare("SELECT phrase FROM dictionary WHERE phrase = ?").get(clean);
  if (existing) return "exists";
  database.prepare("INSERT INTO dictionary (phrase, created_at) VALUES (?, ?)").run(clean, new Date().toISOString());
  return "added";
}

function removePhrase(phrase: string): boolean {
  const clean = normalizePhrase(phrase);
  if (!clean) return false;
  const result = openDb().prepare("DELETE FROM dictionary WHERE phrase = ?").run(clean);
  return Number(result.changes) > 0;
}

function dictionaryNotice(action: string, phrase: string): DictNotice {
  if (action === "list" || action === "") {
    const phrases = listPhrases();
    return {
      text: phrases.length > 0 ? `Grammar dictionary: ${phrases.join(", ")}` : "Grammar dictionary is empty",
      level: "info",
    };
  }
  if (action === "add") {
    const result = addPhrase(phrase);
    if (result === "invalid") return { text: "Grammar dictionary: give a word or phrase to add", level: "warning" };
    const saved = normalizePhrase(phrase) ?? phrase;
    if (result === "exists") return { text: `Grammar dictionary already has ${saved}`, level: "info" };
    return { text: `Grammar dictionary added ${saved}`, level: "info" };
  }
  if (action === "remove" || action === "rm") {
    if (!phrase.trim()) return { text: "Grammar dictionary: give a word or phrase to remove", level: "warning" };
    if (!removePhrase(phrase)) return { text: "Grammar dictionary: phrase not found", level: "warning" };
    return { text: `Grammar dictionary removed ${normalizePhrase(phrase) ?? phrase}`, level: "info" };
  }
  return {
    text: "Usage: /grammar dict | /grammar dict add <word or phrase> | /grammar dict remove <word or phrase>",
    level: "warning",
  };
}

function phraseProtected(wrong: string, phrases: string[]): boolean {
  const key = wrong.trim().toLowerCase();
  return phrases.some((phrase) => phrase.trim().toLowerCase() === key);
}

function storeErrors(style: Style, original: string, corrected: string, errors: GrammarError[]): number {
  try {
    const phrases = listPhrases();
    const kept = errors.filter((err) => !phraseProtected(err.wrong, phrases) && !/GRAMMARDICT\d+/.test(err.wrong + err.fix));
    if (kept.length === 0) return 0;
    const insert = openDb().prepare(
      "INSERT INTO errors (created_at, style, tag, wrong, fix, original, corrected) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    const now = new Date().toISOString();
    for (const err of kept) insert.run(now, style, err.tag, err.wrong, err.fix, original, corrected);
    return kept.length;
  } catch (err: unknown) {
    log("errors: " + (err instanceof Error ? err.message : String(err)));
    return 0;
  }
}

const dictionaryTool = defineTool({
  name: "grammar_dictionary",
  label: "Grammar dictionary",
  description: "Add, remove, or list words and phrases the grammar coach must leave unchanged. Use this when a correction rewrites a name, product, command, or other spelling that is already correct.",
  promptSnippet: "Save spellings the grammar coach must not change",
  promptGuidelines: [
    "When the user says the grammar coach changed a name, product, command, or other correct spelling, call grammar_dictionary with action add and that exact phrase.",
  ],
  parameters: Type.Object({
    action: Type.Union([Type.Literal("add"), Type.Literal("remove"), Type.Literal("list")], {
      description: "add saves a spelling, remove deletes it, list shows the dictionary",
    }),
    phrase: Type.Optional(Type.String({ description: "Word or phrase to add or remove. Required for add and remove." })),
  }),
  async execute(_toolCallId, params) {
    const phrase = params.phrase ?? "";
    try {
      const notice = dictionaryNotice(params.action, phrase);
      return {
        content: [{ type: "text" as const, text: notice.text }],
        details: { action: params.action, phrase, phrases: listPhrases(), error: "" },
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `Grammar dictionary failed: ${message}` }],
        details: { action: params.action, phrase, phrases: [] as string[], error: message },
      };
    }
  },
});

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

  pi.registerTool(dictionaryTool);
  pi.on("session_shutdown", () => {
    closeDb();
  });

  pi.registerCommand("grammar", {
    description: "Grammar coach: /grammar casual|formal|model <provider/id>|dict|status",
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
      } else if (cmd === "dict" || cmd === "dictionary") {
        const action = (parts[1] || "list").toLowerCase();
        const phrase = parts.slice(2).join(" ").trim();
        try {
          const notice = dictionaryNotice(action, phrase);
          ctx.ui.notify(notice.text, notice.level);
        } catch (err: unknown) {
          ctx.ui.notify("Grammar dictionary: " + (err instanceof Error ? err.message : String(err)), "error");
        }
      } else if (cmd === "" || cmd === "status") {
        ctx.ui.notify(`Grammar coach: style=${cfg.style}, model=${cfg.model ?? "default"}`, "info");
      } else {
        ctx.ui.notify("Usage: /grammar casual|formal | /grammar model <provider/id|default> | /grammar dict add <phrase> | /grammar status", "warning");
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

        const phrases = listPhrases();
        const masked = maskPhrases(text, phrases);
        const sessionId = ctx.sessionManager.getSessionId();
        const headers = { ...(auth.headers ?? {}), ...(sessionId ? { "x-opencode-session": sessionId } : {}) };
        const msg = await completeSimple(model, {
          messages: [{ role: "user", content: buildPrompt(cfg.style, masked.text, phrases, masked.masks.length > 0), timestamp: Date.now() }],
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
        const surfaces = masked.masks.map((mask) => mask.phrase);
        const sentence = stripSentencePeriod(text, restoreProtected(unmask(parsed.sentence, masked.masks), surfaces));
        const tags = unmask(parsed.tags, masked.masks);
        const errors = parsed.errors
          .map((err) => ({
            tag: unmask(err.tag, masked.masks).trim(),
            wrong: unmask(err.wrong, masked.masks).trim(),
            fix: unmask(err.fix, masked.masks).trim(),
          }))
          .filter((err) => err.tag && err.wrong && err.fix && err.wrong !== err.fix && !protectedError(err, surfaces));
        if (!sentence || /^ok\.?$/i.test(sentence) || sameWords(text, sentence)) {
          log("no correction needed");
          ctx.ui.setWidget(WIDGET_KEY, undefined);
          return;
        }

        const stored = storeErrors(cfg.style, text, sentence, errors);
        const changed = changedWordIndexes(wordsOf(text), wordsOf(sentence));
        log("tags=" + JSON.stringify(tags) + " reply=" + JSON.stringify(sentence) + " stored=" + stored);
        ctx.ui.setWidget(WIDGET_KEY, widget((theme) => suggestionLine(theme, tags, sentence, changed)));
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

  const parsed = parseCorrection('```json\n{"tags":["article"],"sentence":"I went.","errors":[{"tag":"article","wrong":"went to store","fix":"went to the store"}]}\n```');
  assert(parsed.tags === "article" && parsed.sentence === "I went.", "fenced json");
  assert(parsed.errors.length === 1 && parsed.errors[0]?.wrong === "went to store", "error span");
  const ok = parseCorrection('{"tags":[],"sentence":"OK","errors":[]}');
  assert(ok.sentence === "OK" && ok.errors.length === 0, "ok sentence");

  const masked = maskPhrases("use Zeroshot and pi coding, not pie", ["zeroshot", "pi", "pi coding"]);
  assert(masked.text === "use GRAMMARDICT1 and GRAMMARDICT0, not pie", "longest phrase wins");
  assert(unmask(masked.text, masked.masks) === "use Zeroshot and pi coding, not pie", "unmask keeps the typed spelling");
  assert(maskPhrases("zeroshotter", ["zeroshot"]).text === "zeroshotter", "no match inside a word");
  assert(restoreProtected("check zero-shot status", ["zeroshot"]) === "check zeroshot status", "restore hyphenation");
  assert(restoreProtected("I have zero shot today", ["zeroshot"]) === "I have zeroshot today", "restore a split word");
  assert(
    protectedError({ tag: "spelling", wrong: "zero-shot", fix: "zeroshot" }, ["zeroshot"]),
    "protected rewrite is not an error",
  );
  assert(
    !protectedError({ tag: "article", wrong: "to store", fix: "to the store" }, ["zeroshot"]),
    "real error stays",
  );

  const dbPath = path.join(os.tmpdir(), `grammar-coach-test-${process.pid}.db`);
  process.env.GRAMMAR_COACH_DB = dbPath;
  closeDb();
  assert(addPhrase("zeroshot") === "added", "add phrase");
  assert(addPhrase("Zeroshot") === "exists", "dictionary is case-insensitive");
  assert(listPhrases().includes("zeroshot"), "list phrase");
  const stored = storeErrors("casual", "check zeroshot", "check the zeroshot", [
    { tag: "article", wrong: "check zeroshot", fix: "check the zeroshot" },
    { tag: "spelling", wrong: "zeroshot", fix: "zero-shot" },
  ]);
  assert(stored === 1, "dictionary span is not stored");
  const rows = openDb().prepare("SELECT tag, wrong, fix FROM errors").all();
  assert(rows.length === 1 && rows[0]?.tag === "article", "sqlite row");
  assert(removePhrase("ZEROSHOT"), "remove phrase");
  assert(listPhrases().length === 0, "dictionary empty");
  closeDb();
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(dbPath + "-wal", { force: true });
  fs.rmSync(dbPath + "-shm", { force: true });
  delete process.env.GRAMMAR_COACH_DB;
}

if (process.env.GRAMMAR_COACH_SELFTEST === "1") selfTest();
