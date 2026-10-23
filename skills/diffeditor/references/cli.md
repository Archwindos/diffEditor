# CLI contract

The supported AI interface is the local CLI over a per-user named pipe. Its only commands are `baseline`, `submit`, and `status`. It has no approve, save, force, close, reopen, or delete operation. Those UI actions belong to the human.

Every successful command prints one UTF-8 JSON result and exits 0. Errors print `{ "ok": false, "error": "...", "code": "..." }` and exit nonzero. Inspect the exit code before treating a parsed object as a result. Launching the GUI alone is never success.

## Baseline and submission

`baseline <paths...> [--encoding gb18030]` returns:

```json
{"files":[{"id":"baseline-id","path":"D:\\paper\\main.tex","sha256":"...","exists":true,"text":"original text","encoding":"utf8","bom":false}]}
```

`sha256` is null for a new target. Preserve `exists`, encoding, BOM, baseline ID, and hash as returned. The application also stores its baseline independently. Use absolute file paths. Without an explicit encoding, the app detects supported encodings conservatively and rejects ambiguous input. Accepted explicit encoding names: `utf8`, `utf16le`, `utf16be`, `gb18030`.

Before generating a candidate, create a unique subdirectory under `%LOCALAPPDATA%\DiffEditor\inbox` (or `DIFFEDITOR_DATA_DIR\inbox`). Write the successful baseline JSON there using exclusive creation (`open(path, "xb")` in Python; `FileMode.CreateNew` in .NET). Do not overwrite an earlier receipt. Serialize candidate data to UTF-8 in that same directory using a JSON library. Candidates contain complete replacement text for each baseline, not a patch:

```json
{
  "requestId": "a-unique-uuid-retained-for-exact-retries",
  "title": "Revise introduction",
  "files": [{ "baselineId": "baseline-id", "text": "complete candidate text\n" }]
}
```

Submit using `submit --file <absolute-json-path>` or `submit --stdin`. Only `requestId`, optional `title`, and `files` are accepted; each file has `baselineId` and `text`. For stdin, use a subprocess argument array and `input=json.dumps(payload, ensure_ascii=False).encode("utf-8")`; do not construct a shell command containing the text. A successful result has `reviewIds` and `duplicate`, for example `{"reviewIds":["review-id"],"duplicate":false}`.

## Read status accurately

`status [reviewId]` returns `{"reviews":[...]}`. Each review exposes `id`, `title`, `targets`, `leftRevision`, `rightRevision`, and `lifecycle`. Lifecycle is independent of saving:

- `open`: comparison is open in the workspace.
- `closed`: comparison is retained but closed. If review must continue, tell the human to reopen it in the UI; do not resubmit it to make it visible.
- `deleted`: comparison is deleted; the status record is a tombstone, not an editable draft. Do not recreate it, refresh its baseline, or replay it with a new request ID without a new user request. An exact duplicate submission may still return its old review ID.

If an older version omits lifecycle, say it was not reported; do not infer open, closed, or deleted. Each target separately exposes its path, encoding, baseline hash, and status:

- `pending`: draft awaiting review/save.
- `saving`: save is in progress; no final receipt yet.
- `saved`: confirm `receipt` is also present before reporting a save. The receipt contains `operationId`, `targetPath`, `beforeHash`, `afterHash`, `savedAt`, `side`, and `backupPath` for an existing target. New targets have `beforeHash: null` and no old-file backup.
- `conflict`: the formal target changed since the baseline; preserve the draft.
- `error`: save did not succeed; report the returned error.
- `rejected`: the user rejected the proposal; preserve it and do not resubmit automatically.

One submitted target can have a different state from another. Report partial completion per path: for example, one saved with its receipt and another still pending. A closed or deleted comparison can retain a legitimately saved target and receipt; lifecycle alone neither proves nor cancels a save. An empty `reviews` result does not prove saving, deletion, or rejection. Preserve drafts on errors; a timeout is an unknown outcome. The CLI never issues automatic request replays after sending a request.

For an uncertain submission, inspect known review IDs, or inspect `status` if no IDs were returned. Retain the original baseline receipt, request ID, and payload. If retry is needed, send exactly that request, then inspect every returned review ID. Never change IDs or refresh the baseline to bypass a duplicate, closed/deleted lifecycle, conflict, or rejection. Stop after a bounded recovery attempt if the outcome is still unknown. For pending or closed review, hand back to the human instead of polling.

## Argument-array invocation

Use Python's subprocess argument arrays to call the bundled helper. This preserves Windows spaces, Unicode, `%`, `&`, quotes, backslashes, and document newlines without a command shell. The candidate belongs only in a JSON file under the inbox or in stdin bytes, never in command-line arguments or a shell here-string. Example inside an existing Python script, with `helper`, `workflow_dir`, and `target` set to absolute paths:

```python
import json
from pathlib import Path
import subprocess
import sys
from uuid import uuid4

def call(*args, payload=None):
    result = subprocess.run(
        [sys.executable, str(helper), *args],
        input=None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, shell=False, check=False,
    )
    reply = json.loads(result.stdout.decode("utf-8"))
    if result.returncode:
        raise RuntimeError(reply)  # Preserve the workflow files and report the error.
    return reply

baseline = call("baseline", str(target))
with (workflow_dir / "baseline.json").open("xb") as receipt:
    receipt.write(json.dumps(baseline, ensure_ascii=False).encode("utf-8"))

# Generate the authorized complete replacement only after reading baseline.
payload = {"requestId": str(uuid4()), "files": [
    {"baselineId": baseline["files"][0]["id"], "text": complete_candidate_text}
]}
with (workflow_dir / "candidate.json").open("xb") as candidate:
    candidate.write(json.dumps(payload, ensure_ascii=False).encode("utf-8"))
submitted = call("submit", "--file", str(workflow_dir / "candidate.json"))
# Alternatively: submitted = call("submit", "--stdin", payload=payload)
statuses = [call("status", review_id) for review_id in submitted["reviewIds"]]
```

Create `workflow_dir` as a unique directory beneath the app inbox before using this example. Keep `payload` unchanged for exact retries. Do not put complete candidate text into a shell command when launching this Python script.

## Connection and discovery

The default connection uses a per-user local named pipe. The CLI connects to an existing app or starts a supported local installation and waits up to 20 seconds. `DIFFEDITOR_TIMEOUT_MS` can set 50–120000 ms. `DIFFEDITOR_PIPE` selects an isolated test pipe and disables automatic startup unless `DIFFEDITOR_EXE` is explicitly supplied. `DIFFEDITOR_EXE` names an executable path, not a shell command. These overrides are for deliberate setup/testing, not instructions to change the user's environment.
