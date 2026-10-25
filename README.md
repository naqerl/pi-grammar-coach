# pi-grammar-coach

<img width="670" height="170" alt="image" src="https://github.com/user-attachments/assets/9a58f0b4-8b71-4933-beb4-68196adebd2b" />

See a grammar fix for the prompt you just sent, keep names and commands spelled your way, and save the real mistakes for later review.

## What you can do

**See the correction.** Send a prompt. A line above the editor shows the issue words and a corrected version, with the changed words highlighted. Casual style keeps your tone. Formal style uses a tech-professional tone.

**Keep a spelling.** When a name, product, or command gets rewritten (`zeroshot` becomes `zero-shot`):

```sh
/grammar dict add zeroshot
```

Or ask the agent to add it. The agent calls `grammar_dictionary`.

**Pick a tone or a model.**

```sh
/grammar casual
/grammar formal
/grammar model <provider/id>
/grammar model default
/grammar status
```

**Review mistakes later.** Each real correction stores a tagged list of the actual errors in `~/.pi/agent/grammar-coach.db` for review and flashcard generation.

## Install

```sh
pi install git:github.com/naqerl/pi-grammar-coach
```

Pi provides `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui`. This package lists them as peer dependencies.

To load the file without the package:

```sh
mkdir -p ~/.pi/agent/extensions
cp extensions/grammar-coach.ts ~/.pi/agent/extensions/
```

If both the package and that copied file are installed, Pi loads the coach twice. Use one.

## Details

The check runs from an input hook when you send a prompt. `/grammar` is a command you type in the editor.

### Commands

- `/grammar casual` / `/grammar formal`
- `/grammar model <provider/id>` or `/grammar model default`
- `/grammar dict`, `/grammar dict add <word or phrase>`, `/grammar dict remove <word or phrase>`
- `/grammar status`

`/grammar model` warns when that id is not in the model list. `/grammar dict` uses the same dictionary as `grammar_dictionary`.

### Agent tool

The running agent receives one tool, `grammar_dictionary`. It adds, removes, or lists spellings the coach must leave unchanged.

| Parameter | Required | Values |
|---|---|---|
| `action` | yes | `add`, `remove`, or `list` |
| `phrase` | for `add` and `remove` | the word or phrase |

While the tool is active, the agent's prompt gets the snippet "Save spellings the grammar coach must not change" and a guideline: when you say a correction rewrote a name, product, command, or other correct spelling, call `grammar_dictionary` with `action` `add` and that exact phrase.

### Dictionary

Matching is case-insensitive. A longer phrase wins over a shorter one, so `pi coding` stays whole when `pi` is also saved. The coach hides those spellings from the checker and puts your original form back if the checker still rewrites them (`zero-shot` or `zero shot`). Those rewrites are left out of the error log.

### Error log

The editor line stays the short correction. The model also returns each mistake as `tag`, the `wrong` span, and the `fix`. Those rows are appended to `~/.pi/agent/grammar-coach.db` in the `errors` table (`created_at`, `style`, `tag`, `wrong`, `fix`, `original`, `corrected`). Protected dictionary spellings are left out. The `dictionary` table in the same file holds the saved phrases.
