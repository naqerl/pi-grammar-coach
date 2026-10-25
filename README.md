# pi-grammar-coach

<img width="670" height="170" alt="image" src="https://github.com/user-attachments/assets/9a58f0b4-8b71-4933-beb4-68196adebd2b" />

Pi extension that checks the grammar of a prompt after you send it. A line above the editor shows the issue words and a corrected version, with the changed words highlighted. Casual style keeps your tone. Formal style uses a tech-professional tone.

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

The check runs from an input hook when you send a prompt. `/grammar` is a command you type in the editor.

## Agent tool

The running agent receives one tool, `grammar_dictionary`. It adds, removes, or lists spellings the coach must leave unchanged.

| Parameter | Required | Values |
|---|---|---|
| `action` | yes | `add`, `remove`, or `list` |
| `phrase` | for `add` and `remove` | the word or phrase |

While the tool is active, the agent's prompt gets the snippet "Save spellings the grammar coach must not change" and a guideline: when you say a correction rewrote a name, product, command, or other correct spelling, call `grammar_dictionary` with `action` `add` and that exact phrase.

## Commands

- `/grammar casual` / `/grammar formal`
- `/grammar model <provider/id>` or `/grammar model default`
- `/grammar dict`, `/grammar dict add <word or phrase>`, `/grammar dict remove <word or phrase>`
- `/grammar status`

`/grammar model` warns when that id is not in the model list. `/grammar dict` uses the same dictionary as `grammar_dictionary`.

## Dictionary

Names, products, and commands sometimes get rewritten (`zeroshot` becomes `zero-shot`). Add the spelling you want kept:

```sh
/grammar dict add zeroshot
```

You can also ask the agent to add it. The agent then calls `grammar_dictionary`. Matching is case-insensitive. The coach hides those spellings from the checker and puts your original form back if the checker still rewrites them (`zero-shot` or `zero shot`). Those rewrites are left out of the error log.

## Error log

Each real correction also asks the model for a tagged list of the actual mistakes (`tag`, the `wrong` span, and the `fix`). That list is not shown in the editor. It is appended to `~/.pi/agent/grammar-coach.db` in the `errors` table (`created_at`, `style`, `tag`, `wrong`, `fix`, `original`, `corrected`) for later review and flashcard generation. Protected dictionary spellings are not stored. The `dictionary` table in the same file holds the saved phrases.
