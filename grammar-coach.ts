import { completeSimple } from "@earendil-works/pi-ai/compat";
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

function loadCfg(): Cfg {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    return {
      style: raw?.style === "formal" ? "formal" : "casual",
      model: typeof raw?.model === "string" ? raw.model : undefined,
    };
  } catch {
    return { style: "casual" };
  }
}

function saveCfg(cfg: Cfg): void {
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  } catch {}
}

function resolveModel(ctx: any, cfg: Cfg): any {
  if (cfg.model && cfg.model !== "default") {
    const all = ctx.modelRegistry?.getAll?.() ?? [];
    const found = all.find((m: any) => `${m.provider}/${m.id}` === cfg.model);
    if (found) return found;
  }
  return ctx.model;
}

export default function (pi: any) {
  let abort: AbortController | undefined;

  pi.registerCommand("grammar", {
    description: "Grammar coach: /grammar casual|formal|model <provider/id>|status",
    handler: async (args: string, ctx: any) => {
      const cfg = loadCfg();
      const parts = (args || "").trim().split(/\s+/);
      const cmd = (parts[0] || "").toLowerCase();

      if (cmd === "casual" || cmd === "formal") {
        cfg.style = cmd;
        saveCfg(cfg);
        ctx.ui.notify(`Grammar coach style: ${cfg.style}`, "info");
      } else if (cmd === "model") {
        const m = parts.slice(1).join(" ").trim();
        if (!m) {
          ctx.ui.notify(`Grammar coach model: ${cfg.model ?? "default (session model)"}`, "info");
        } else if (m.toLowerCase() === "default") {
          delete cfg.model;
          saveCfg(cfg);
          ctx.ui.notify("Grammar coach model: default (session model)", "info");
        } else {
          cfg.model = m;
          saveCfg(cfg);
          ctx.ui.notify(`Grammar coach model: ${cfg.model}`, "info");
        }
      } else if (cmd === "" || cmd === "status") {
        ctx.ui.notify(
          `Grammar coach: style=${cfg.style}, model=${cfg.model ?? "default"}`,
          "info"
        );
      } else {
        ctx.ui.notify("Usage: /grammar casual|formal | /grammar model <provider/id|default> | /grammar status", "warning");
      }
    },
  });

  pi.on("input", async (event: any, ctx: any) => {
    if (event.source !== "interactive") return;
    if (!ctx.hasUI || ctx.mode !== "tui") return;

    const text = String(event.text ?? "").trim();
    if (!text || text.startsWith("/") || text.startsWith("!")) return;
    if (text.length < 4) return;

    abort?.abort();
    abort = new AbortController();
    const signal = abort.signal;

    const log = (msg: string) => {
      try {
        fs.appendFileSync("/tmp/grammar-coach.log", new Date().toISOString() + " " + msg + "\n");
      } catch {}
    };

    const cfg = loadCfg();

    ctx.ui.setWidget(WIDGET_KEY, (_tui: any, theme: any) => {
      const c = new Container();
      c.addChild(new Text(theme.fg("accent", theme.bold("✏")), 1, 0));
      return c;
    });

    try {
      log("start text=" + JSON.stringify(text) + " style=" + cfg.style + " model=" + (cfg.model ?? "default"));
      const model = resolveModel(ctx, cfg);
      if (!model) { log("no model"); ctx.ui.setWidget(WIDGET_KEY, undefined); return; }

      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth?.ok) { log("auth failed"); ctx.ui.setWidget(WIDGET_KEY, undefined); return; }

      const sessionId = ctx.sessionManager?.getSessionId?.();
      const headers = { ...(auth.headers || {}), ...(sessionId ? { "x-opencode-session": sessionId } : {}) };

      const style = cfg.style;
      const prompt = [
        "You are an English writing coach for software engineers.",
        `Rewrite the user's message as one corrected sentence in a ${style}, tech-professional tone.`,
        "Focus on grammar and how the sentence is formulated; ignore punctuation, casing, and trailing punctuation.",
        "If it is already correct, output exactly: OK",
        "Otherwise output ONLY the corrected sentence. No explanations, no extra lines.",
        "",
        "Message:",
        text,
      ].join("\n");

      const msg = await completeSimple(model, {
        messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
      }, { signal, apiKey: auth.apiKey, headers });

      if (signal.aborted) return;

      let reply = (msg.content ?? [])
        .filter((p: any) => p.type === "text")
        .map((p: any) => p.text)
        .join(" ")
        .trim()
        .replace(/\s+/g, " ");
      // Drop a trailing period (user doesn't want the trailing dot).
      reply = reply.replace(/\.$/, "").trim();

      if (!reply || /^ok\.?$/i.test(reply)) {
        log("no correction needed");
        ctx.ui.setWidget(WIDGET_KEY, undefined);
        return;
      }

      // Highlight the words that actually changed (same word count only).
      const origWords = text.split(/\s+/);
      const corrWords = reply.split(/\s+/);
      const changed = new Set<number>();
      if (origWords.length === corrWords.length && origWords.length > 0) {
        for (let i = 0; i < corrWords.length; i++) {
          if (corrWords[i].toLowerCase() !== (origWords[i] || "").toLowerCase()) changed.add(i);
        }
      }

      log("reply=" + JSON.stringify(reply));
      ctx.ui.setWidget(WIDGET_KEY, (_tui: any, theme: any) => {
        const c = new Container();
        const segs: string[] = [theme.fg("accent", "✏")];
        corrWords.forEach((w, i) => {
          segs.push(changed.has(i) ? theme.fg("error", w) : w);
        });
        c.addChild(new Text(segs.join(" "), 1, 0));
        return c;
      });
    } catch (err: any) {
      log("error: " + (err?.message || err));
      ctx.ui.setWidget(WIDGET_KEY, (_tui: any, theme: any) => {
        const c = new Container();
        c.addChild(new Text(theme.fg("error", "✏ error"), 1, 0));
        c.addChild(new Text(theme.fg("dim", String(err?.message || err)), 1, 0));
        return c;
      });
    }
  });
};
