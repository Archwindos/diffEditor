# CLI contract

Use this protocol for files requiring review under [SKILL.md](../SKILL.md). The first draft of an AI-created formal document normally bypasses it; later revisions of user-facing material require review. Code and internal agent progress records are outside automatic review unless explicitly requested. Each round reviews one file's accumulated result within the current authorized task; intermediate edits to its temporary working draft are not separate rounds.

The supported AI interface is the local CLI over a per-user named pipe. Its commands are `baseline`, `submit`, `status`, `wait`, and `withdraw`. It has no approve, save, force, close, reopen, or delete operation. Those UI actions belong to the human. `wait` observes results; `withdraw` only retracts the AI's own unsaved proposal.

Every successful command prints one UTF-8 JSON result and exits 0. For `wait`, exit 0 means a valid observation result; it can report `attention` or `timeout`, neither of which proves saving. Errors print `{ "ok": false, "error": "...", "code": "..." }` and exit nonzero. Inspect both exit code and JSON result. Launching the GUI alone is never success.

## Baseline and submission

`baseline <paths...> [--encoding gb18030]` returns:

```json
{"files":[{"id":"baseline-id","path":"D:\\paper\\main.tex","sha256":"...","exists":true,"text":"original text","encoding":"utf8","bom":false}]}
```

`sha256` is null for a new target. Preserve `exists`, encoding, BOM, baseline ID, and hash as returned. The application also stores its baseline independently. Use absolute file paths. Without an explicit encoding, the app detects supported encodings conservatively and rejects ambiguous input. Accepted explicit encoding names: `utf8`, `utf16le`, `utf16be`, `gb18030`.

Before generating a candidate, create a unique subdirectory under `%LOCALAPPDATA%\DiffEditor\inbox` (or `DIFFEDITOR_DATA_DIR\inbox`). Write the successful baseline JSON there using exclusive creation (`open(path, "xb")` in Python; `FileMode.CreateNew` in .NET). Do not overwrite an earlier receipt or refresh that baseline during the round. If the target already has an unresolved review, inspect or wait on its existing review IDs instead of opening another round.

Create an independent temporary text file in that workflow directory and initialize it from the original baseline when needed. Direct all model and script edits to that file, never the formal target. Edit, inspect, test, and correct it repeatedly within the authorized scope without opening a comparison or calling `submit` / `wait` for each intermediate write. Once the authorized work and self-checks are complete, or the next step needs a human decision, read back the complete accumulated draft, preserving its newlines.

At that approval point, serialize candidate data to UTF-8 in the same directory using a JSON library. Candidates contain complete replacement text for each original baseline, not a patch:

```json
{
  "requestId": "a-unique-uuid-retained-for-exact-retries",
  "title": "Revise introduction",
  "source": { "agent": "Codex", "threadId": "actual-codex-thread-id", "threadTitle": "Actual conversation title, when known" },
  "files": [{ "baselineId": "baseline-id", "text": "complete candidate text\n" }]
}
```

Submit using `submit --file <absolute-json-path>` or `submit --stdin`. Accepted fields are `requestId`, optional `title` and `source`, and `files`; each file has `baselineId` and `text`. `source` has `agent` (up to 80 characters), optional `threadId` (200) and `threadTitle` (300). Use actual origin values: `threadTitle` is the conversation name, not an invented task summary. Omit unknown values. The CLI defaults to Codex and fills a missing thread ID from `CODEX_THREAD_ID`; it does not look up titles or reconstruct legacy origins. Origin is retained with the first accepted submission and cannot be changed by an idempotent retry. For stdin, use a subprocess argument array and `input=json.dumps(payload, ensure_ascii=False).encode("utf-8")`; do not construct a shell command containing the text. A successful result has `reviewIds` and `duplicate`, for example `{"reviewIds":["review-id"],"duplicate":false}`.

Pair the temporary file's contents with the **original** file's `baselineId`, not a baseline of the temporary file. This presents the original and accumulated draft together while keeping the original as the eventual UI save target. The CLI does not accept two file paths as a comparison command. Never replace the original with the temporary file yourself.

Submit once for the round, then freeze the AI's submitted draft and payload. Keep the request ID and exact payload for idempotent retries only. While the review is unresolved, do not change the text, allocate another request ID, acquire another baseline, create another comparison, or use a path alias to bypass it. Human edits in the app remain under the human's control.

Round guards return errors with `reviewIds` for the relevant prior reviews:

- `REVIEW_IN_PROGRESS`: a review already blocks the target. Use the returned IDs with `status` / `wait`; do not create a replacement submission.
- `BASELINE_EXPIRED`: a prior round consumed the old baseline snapshot. Inspect the returned IDs, confirm the previous round has ended and that the user authorized a new revision, then capture the actual disk state for that new round. Do not automatically refresh the baseline and replay the old draft.

Neither code grants new editing or submission authority. Keep the original workflow artifacts when reporting either error.

## Read status accurately

`status [reviewId]` returns `{"reviews":[...]}`. Each review exposes `id`, `title`, `targets`, `leftRevision`, `rightRevision`, `lifecycle`, and optional `source`. Origin persists through closure, deletion and restart; missing legacy origin does not prove a conversation identity. Lifecycle is independent of saving:

- `open`: comparison is open in the workspace.
- `closed`: comparison is retained in the closed list. Fully saved or withdrawn AI proposals close automatically and appear first, newest completion first; manual comparisons and incomplete/failed saves keep their existing workflow. Manual closure alone does not end a pending round. Read target status/receipts to distinguish completion from closure. If the human wants to inspect history or continue a pending review, they can reopen it in the UI; do not resubmit it merely to make it visible. Explicitly reopened history remains open across retries and restart.
- `deleted`: the human closed and then deleted the comparison; its round has ended without saving any incomplete targets. An open comparison cannot be deleted. The status record is a tombstone, not an editable draft or permission to recreate it. A new round requires a new user request or authorized scope and a fresh baseline from the actual disk state. Do not replay the old draft automatically. An exact duplicate submission may still return its old review ID.

If an older version omits lifecycle, say it was not reported; do not infer open, closed, or deleted. Each target separately exposes its path, encoding, baseline hash, and status:

- `pending`: draft awaiting review/save.
- `saving`: save is in progress; no final receipt yet.
- `saved`: confirm `receipt` is also present before reporting a save. The receipt contains `operationId`, `targetPath`, `beforeHash`, `afterHash`, `savedAt`, `side`, and `backupPath` for an existing target. New targets have `beforeHash: null` and no old-file backup.
- `conflict`: the formal target changed since the baseline; preserve the draft. The round remains unresolved.
- `error`: save did not succeed; report the returned error. The round remains unresolved.
- `rejected`: the human actively rejected/returned the proposal in the UI, ending the round without saving that target. Preserve any remaining draft and do not resubmit automatically.
- `withdrawn`: the AI retracted its own unsaved, human-unedited proposal. This ends the round without modifying the original. Drafts, revisions, origin and history remain preserved; the review also exposes `withdrawnAt`. The app automatically closes it into the completed group at the top of the closed list; the human may reopen it for viewing/copying or delete the closed history. It cannot be saved or returned as though still pending. Existing historical withdrawal receipts remain valid; the current policy never withdraws a newly human-edited proposal.

One submitted target can have a different state from another. Report partial completion per path: for example, one saved with its receipt and another still pending. A closed or deleted comparison can retain a legitimately saved target and receipt; lifecycle alone neither proves nor cancels a save. An empty `reviews` result does not prove saving, deletion, rejection, or withdrawal. A save with its receipt, human UI return/deletion, or successful explicit withdrawal ends a round. Window/comparison closure, timeout, conflict, error, connection loss, and app restart do not. Preserve drafts on errors. The CLI never automatically replays requests.

For an uncertain submission, inspect known review IDs, or inspect `status` if no IDs were returned. Retain the original baseline receipt, request ID, and payload. If retry is needed, send exactly that request, then inspect every returned review ID. Never change IDs, text, baseline, comparison, or path spelling to bypass an unresolved review. Stop after a bounded recovery attempt if the outcome is still unknown.

Human return/deletion does not authorize automatic resubmission. After AI withdrawal, any remaining work must stay within the authorized scope; finish it in a temporary draft, acquire a fresh actual-disk baseline, and submit once at the next approval point. Never queue old baselines/candidates or repeatedly withdraw/resubmit intermediate edits. The AI cannot perform the human UI actions that end or dismiss reviews.

## Withdraw an AI proposal

```text
withdraw <reviewId> --request-id <original-submit-requestId>
```

The wire command is `withdraw`, with payload `{"reviewId":"review-id","requestId":"original-submit-request-id","requireUnedited":true}`. The CLI adds `requireUnedited: true` automatically and the current server requires it. An older running server rejects the extra field, preventing a silent downgrade to its permissive policy. Do not remove the field, downgrade the CLI, or invent a force option. Keep the original `candidate.json` to retain its request ID. The app checks that this accepted submission owns the given review; unrelated IDs, manual comparisons, saved/receipted reviews, human-returned reviews and nonwithdrawn deleted records cannot be withdrawn. Use only your own submission credentials. This ownership check is part of the local workflow; it does not change filesystem permissions.

A successful result has `reviewId`, `status: "withdrawn"`, `withdrawnAt`, `duplicate`, and `review` (the per-review status snapshot). A new successful withdrawal closes the comparison in the same persisted operation. Repeat withdrawal is idempotent: it cannot restore deleted comparisons or re-close a history item the human reopened. Drafts/history survive restart. The operation writes only app state: it never writes or rolls back the target or creates a backup. Saving in progress or with an uncertain disk outcome cannot be canceled this way; a prepared, uncommitted save preview is invalidated by withdrawal.

Any human edit on either side blocks withdrawal with `WITHDRAW_HAS_HUMAN_EDITS`, even after undo. The desktop briefly freezes input and flushes both pending buffers before the core checks revisions, including net-zero type/undo changes; it does not rely on an earlier `status` query. A renderer failure, unavailable window, failed flush, or timed-out check also refuses withdrawal. A refused review and its edits remain pending and continue blocking a new round. Preserve the proposal, report the actual error and wait for the user's UI decision; never imitate withdrawal by clicking return/delete, editing app state, acquiring a new baseline or overwriting the formal file. Successful withdrawal is neither approval nor an automatic resubmission instruction.

## Wait for human UI saving

After submission, send one short commentary asking the user to review and confirm saving in DiffEditor, and saying no second confirmation in chat is needed. Then invoke:

```text
wait <reviewId> [reviewId...] [--timeout <seconds>]
```

Pass all returned IDs. `--timeout` is an integer from 1 through 86400 seconds; the default is 1800. The read-only pipe command is `wait` with payload `{"reviewIds":["review-id"],"timeoutMs":1800000}`. It returns:

```json
{"reason":"saved","reviews":[{"id":"review-id","title":"Revise introduction","targets":[{"path":"D:\\paper\\main.tex","status":"saved","receipt":{"operationId":"operation-id","targetPath":"D:\\paper\\main.tex","backupPath":"backup-path","beforeHash":"original-hash","afterHash":"saved-hash","side":"right","savedAt":"timestamp"}}],"leftRevision":0,"rightRevision":1,"lifecycle":"closed"}]}
```

The `reviews` array uses the same per-review and per-target status objects as `status`. Read every target:

- `saved`: every selected review has at least one target and every target is `saved` with a receipt. Saved targets remain saved when their comparison is closed or deleted. Report the recorded receipt; saving may reflect the original side or manual edits rather than full acceptance of the AI text.
- `attention`: at least one review needs attention because of `conflict`, `error`, `rejected`, `withdrawn`, or an incomplete closed/deleted comparison. Report each file and any actual save receipt. A withdrawn review is ended but unsaved; preserve its drafts/history and follow the withdrawal workflow before any later proposal.
- `timeout`: the deadline elapsed. The returned statuses are the snapshot at that time. Report saved and remaining files accurately and finish the turn; the unresolved rounds remain in place. Do not restart another full wait or resubmit automatically.

A partial save with other targets still pending keeps waiting. A `saved` target without a receipt is insufficient. An empty review or target list does not establish a completed save. Network, pipe, malformed-response, and other command failures still exit nonzero; they are not `reason: timeout`.

Keep the current AI turn active during `wait`; do not send a final answer and leave a detached process running. A running process does not wake an ended chat. When a shell tool yields a session ID, wait on the same process using the shell continuation tool, at most 60 seconds per tool wait. Avoid high-frequency `status` polls and repeated requests for the human to act. Honor user interruption immediately. Use one overall deadline across any connection recovery; do not wait indefinitely.

If the connection fails, report it, inspect `status` for the same IDs when possible, and resume `wait` for those IDs within the remaining deadline once the connection is available. Do not resubmit or claim saving. If an old app rejects `wait`, tell the user to exit that version from its tray menu and start the updated app; do not kill or quit it automatically. Do not silently fall back to ending the task and waiting for a chat message.

## Argument-array invocation

Use Python's subprocess argument arrays to call the bundled helper. This preserves Windows spaces, Unicode, `%`, `&`, quotes, backslashes, and document newlines without a command shell. Temporary draft text and candidate JSON stay under the inbox; submit the serialized candidate through a JSON file or stdin, never through document text in command-line arguments or a shell here-string. Example inside an existing Python script, with `helper`, `workflow_dir`, and `target` set to absolute `pathlib.Path` objects:

```python
import json
import os
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

# First create a separate temporary document from the original baseline.
draft_path = workflow_dir / ("proposed" + (target.suffix or ".txt"))
with draft_path.open("xb") as draft:
    draft.write(baseline["files"][0]["text"].encode("utf-8"))

# Iterate on the authorized work and self-checks in this temporary document,
# never target. An external editing script uses draft_path as output (and
# input for in-place edits). Intermediate writes do not call submit or wait.
with draft_path.open("wb") as draft:
    draft.write(complete_candidate_text.encode("utf-8"))

# Only at the human approval point, read the final accumulated result.
# Read bytes and decode explicitly to preserve mixed CR/LF and final newlines.
proposed_text = draft_path.read_bytes().decode("utf-8", errors="strict")
source = {"agent": "Codex"}
if os.environ.get("CODEX_THREAD_ID"):
    source["threadId"] = os.environ["CODEX_THREAD_ID"]
# Add source["threadTitle"] only if the real conversation title is known.
payload = {"requestId": str(uuid4()), "source": source, "files": [
    {"baselineId": baseline["files"][0]["id"], "text": proposed_text}
]}
with (workflow_dir / "candidate.json").open("xb") as candidate:
    candidate.write(json.dumps(payload, ensure_ascii=False).encode("utf-8"))
submitted = call("submit", "--file", str(workflow_dir / "candidate.json"))
# Alternatively: submitted = call("submit", "--stdin", payload=payload)
# Freeze the submitted draft, payload, request ID, and baseline from here.
# An existing-review error means inspect/wait its IDs, not a new submission.
# Send the short UI-review commentary before starting this call.
result = call("wait", *submitted["reviewIds"], "--timeout", "1800")
# Inspect result["reason"] and every target's status/receipt, even on exit 0.
```

Create `workflow_dir` as a unique directory beneath the app inbox before using this example. Keep `payload` unchanged for exact retries. Further temporary edits shown before submission belong to this same round; edits after submission require first resolving the review and obtaining authorization for a new round. Do not put complete candidate text into a shell command when launching this Python script.

## Connection and discovery

The default connection uses a per-user local named pipe. The CLI connects to an existing app or starts a supported local installation and waits up to 20 seconds for connection. `DIFFEDITOR_TIMEOUT_MS` can set 50–120000 ms. Ordinary operations also use this response deadline; `wait` uses its separate bounded `--timeout` for observing review results. `DIFFEDITOR_PIPE` selects an isolated test pipe and disables automatic startup unless `DIFFEDITOR_EXE` is explicitly supplied. `DIFFEDITOR_EXE` names an executable path, not a shell command. These overrides are for deliberate setup/testing, not instructions to change the user's environment.
