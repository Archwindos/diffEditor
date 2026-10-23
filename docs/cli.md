# DiffEditor CLI

Run `diffeditor.cmd` from the project after `npm run build`, or the packaged directory beside `DiffEditor.exe`. The packaged wrapper uses Electron's Node runtime and does not require a separate Node installation. The source wrapper requires Node. The CLI emits UTF-8 JSON and returns 0 only after receiving a successful application response.

```powershell
& 'D:\Project\diffEditor\diffeditor.cmd' baseline 'D:\paper\main.tex'
& 'D:\Project\diffEditor\diffeditor.cmd' baseline 'D:\paper\legacy.tex' --encoding gb18030
& 'D:\Project\diffEditor\diffeditor.cmd' submit --file 'C:\Users\me\AppData\Local\DiffEditor\inbox\workflow\candidate.json'
& 'D:\Project\diffEditor\diffeditor.cmd' status 'review-id'
```

There are exactly three commands:

- `baseline <paths...> [--encoding utf8|utf16le|utf16be|gb18030]` captures immutable originals and returns `{files:[{id,path,sha256,exists,text,encoding,bom}]}`. Paths resolve against the caller's cwd. Use `--` before paths beginning with `--`.
- `submit --stdin` or `submit --file <UTF-8-JSON>` creates review drafts and returns `{reviewIds,duplicate}`. Submission schema is `{requestId,title?,files:[{baselineId,text}]}`; `text` is the full candidate text. Keep a stable request ID for exact retries. No text is passed through shell interpolation.
- `status [reviewId]` returns `{reviews:[{id,title,targets,leftRevision,rightRevision,lifecycle}]}`. `lifecycle` is `open`, `closed`, or `deleted`; closed drafts can be reopened in the UI, while deleted comparisons cannot. Deleted records retain only minimal metadata and any save receipts, not draft text. Repeating a deleted submission returns the same IDs without restoring it. Each target includes its state and a receipt after a successful UI save. Closing or deleting a comparison is never approval or proof of saving.

No CLI approval, save, or force-save operation exists. Unsupported commands and malformed submissions are rejected locally before starting the app. Error output is `{ok:false,error,code}` with exit code 1. For multi-file proposals inspect each target; one successful target does not prove all targets were saved.

The CLI connects to the local per-user pipe. If absent, it searches beside `cli.cjs`, then the source project's `release/<package-version>/win-unpacked/DiffEditor.exe`, then legacy `release/win-unpacked/DiffEditor.exe`, then its development Electron installation. It starts the app without an extra console, strips `ELECTRON_RUN_AS_NODE` from the GUI environment, and waits for the pipe. A launch is never reported as successful submission. Each operation has a default 20-second connection/response deadline; stdin reading also has a bounded timeout. Requests and responses are limited to 32 MiB including framing. UTF-8 JSON messages use a single newline terminator. Broken, truncated, malformed, or oversized responses produce a nonzero exit. After transmission, failures can mean an unknown outcome; query status and retain the same request ID before retrying. Requests are never automatically replayed.

Optional environment settings:

- `DIFFEDITOR_EXE`: explicit executable path for GUI startup, with no shell arguments.
- `DIFFEDITOR_PIPE`: isolated pipe/socket name. Startup is disabled for custom pipes unless `DIFFEDITOR_EXE` is set.
- `DIFFEDITOR_TIMEOUT_MS`: integer deadline in milliseconds, 50–120000.
- `DIFFEDITOR_DATA_DIR`: app data override, inherited by a launched app; use deliberately for isolated workspaces/tests.
- `DIFFEDITOR_HOME`: used by the companion skill's helper to locate a source/packaged installation.

The companion `skills/diffeditor` folder includes automatically discoverable instructions, invocation metadata, a Python helper that uses native subprocess argument arrays, and schema documentation. Invoke it as `$diffeditor`. Its candidate inbox is `%LOCALAPPDATA%\DiffEditor\inbox` or `DIFFEDITOR_DATA_DIR\inbox`. Install/copy the complete folder so references and helper scripts remain available. It does not install hooks or change agent configuration.
