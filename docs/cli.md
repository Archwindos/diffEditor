# DiffEditor CLI

Run `diffeditor.cmd` from the project after `npm run build`, or the packaged directory beside `DiffEditor.exe`. The packaged wrapper uses Electron's Node runtime and does not require a separate Node installation. The source wrapper requires Node. The CLI emits UTF-8 JSON and returns 0 after receiving a valid application response. A `wait` result may report attention or timeout; exit 0 alone does not prove saving.

```powershell
& 'D:\Project\diffEditor\diffeditor.cmd' baseline 'D:\paper\main.tex'
& 'D:\Project\diffEditor\diffeditor.cmd' baseline 'D:\paper\legacy.tex' --encoding gb18030
& 'D:\Project\diffEditor\diffeditor.cmd' submit --file 'C:\Users\me\AppData\Local\DiffEditor\inbox\workflow\candidate.json'
& 'D:\Project\diffEditor\diffeditor.cmd' wait 'review-id' --timeout 1800
& 'D:\Project\diffEditor\diffeditor.cmd' status 'review-id'
```

There are exactly four commands:

- `baseline <paths...> [--encoding utf8|utf16le|utf16be|gb18030]` captures immutable originals and returns `{files:[{id,path,sha256,exists,text,encoding,bom}]}`. Paths resolve against the caller's cwd. Use `--` before paths beginning with `--`.
- `submit --stdin` or `submit --file <UTF-8-JSON>` creates review drafts and returns `{reviewIds,duplicate}`. Submission schema is `{requestId,title?,files:[{baselineId,text}]}`; `text` is the full candidate text. Keep a stable request ID for exact retries. No text is passed through shell interpolation.
- `status [reviewId]` returns `{reviews:[{id,title,targets,leftRevision,rightRevision,lifecycle}]}`. `lifecycle` is `open`, `closed`, or `deleted`; closed drafts can be reopened in the UI, while deleted comparisons cannot. Deleted records retain only minimal metadata and any save receipts, not draft text. Repeating a deleted submission returns the same IDs without restoring it. Each target includes its state and a receipt after a successful UI save. Closing or deleting a comparison is never approval or proof of saving.
- `wait <reviewId> [reviewId...] [--timeout <seconds>]` observes the selected reviews and returns `{reason:'saved'|'attention'|'timeout',reviews:[...]}` using the same status objects as `status`. Timeout defaults to 1800 seconds and accepts integers 1–86400. The read-only pipe request is command `wait`, payload `{reviewIds:string[],timeoutMs:number}`. `saved` requires at least one target per selected review and every target saved with a receipt. Partial saves with other targets pending continue waiting. If incomplete targets include `conflict`, `error`, or `rejected`, or belong to a closed/deleted comparison, the result is `attention`. Otherwise the deadline returns `timeout` with the current per-file state. All three result reasons exit 0; connection/pipe failures exit nonzero. `wait` cannot approve or save anything.

No CLI approval, save, or force-save operation exists. Unsupported commands and malformed submissions are rejected locally before starting the app. Error output is `{ok:false,error,code}` with exit code 1. For multi-file proposals inspect each target; one successful target does not prove all targets were saved.

A saved target must have both `status: saved` and a `receipt` containing `operationId`, `targetPath`, `beforeHash`, `afterHash`, `side`, and `savedAt`, plus `backupPath` for an existing target. A new target has `beforeHash: null` and no old-file backup. Saved receipts still establish saving after the comparison is closed or deleted. They record the bytes and side the user saved, which may be the original or manually edited text; they do not establish full acceptance of the submitted AI draft.

AI callers should submit, send a short commentary asking the user to review/save in the app, then keep the current turn active with `wait` for all returned review IDs. The user does not need to confirm again in chat. When a shell call yields a session ID, continue waiting on that same process with tool waits of at most 60 seconds; do not use frequent `status` polling, detach a background wait after a final answer, or imply that it will wake an ended chat. Stop on user interruption. On `attention`, report each file without resubmitting or rewriting. On `timeout`, report saved and pending files and finish without indefinitely restarting. After a connection failure, inspect the same IDs and resume waiting only within the remaining overall deadline; do not resubmit. If an old app does not support `wait`, tell the user to exit it from its tray menu and start the updated app; do not automatically kill/quit their app or fall back to later chat confirmation.

The CLI connects to the local per-user pipe. If absent, it searches beside `cli.cjs`, then the source project's `release/<package-version>/win-unpacked/DiffEditor.exe`, then legacy `release/win-unpacked/DiffEditor.exe`, then its development Electron installation. It starts the app without an extra console, strips `ELECTRON_RUN_AS_NODE` from the GUI environment, and waits for the pipe. A launch is never reported as successful submission. Each operation has a default 20-second connection deadline. Ordinary operations use that response deadline too; `wait` observes reviews for its separate `--timeout`. Stdin reading also has a bounded timeout. Requests and responses are limited to 32 MiB including framing. UTF-8 JSON messages use a single newline terminator. Broken, truncated, malformed, or oversized responses produce a nonzero exit. After transmission, failures can mean an unknown outcome; query status and retain the same request ID before retrying. Requests are never automatically replayed.

Optional environment settings:

- `DIFFEDITOR_EXE`: explicit executable path for GUI startup, with no shell arguments.
- `DIFFEDITOR_PIPE`: isolated pipe/socket name. Startup is disabled for custom pipes unless `DIFFEDITOR_EXE` is set.
- `DIFFEDITOR_TIMEOUT_MS`: integer deadline in milliseconds, 50–120000.
- `DIFFEDITOR_DATA_DIR`: app data override, inherited by a launched app; use deliberately for isolated workspaces/tests.
- `DIFFEDITOR_HOME`: used by the companion skill's helper to locate a source/packaged installation.

The companion `skills/diffeditor` folder includes automatically discoverable instructions, invocation metadata, a Python helper that uses native subprocess argument arrays, and schema documentation. Invoke it as `$diffeditor`. Its candidate inbox is `%LOCALAPPDATA%\DiffEditor\inbox` or `DIFFEDITOR_DATA_DIR\inbox`. Install/copy the complete folder so references and helper scripts remain available. It does not install hooks or change agent configuration.
