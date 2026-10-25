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

## Commands

- `/grammar casual` / `/grammar formal`
- `/grammar model <provider/id>` or `/grammar model default`
- `/grammar status`

`/grammar model` warns when that id is not in the model list.
