---
name: diffeditor
description: Draft or edit local academic .tex, .md, and .bib text through DiffEditor, preserving formal files until human review and final desktop save. Also use when the user explicitly requests DiffEditor for another text review. Exclude read-only discussion, PDF, Word, images, and automatic routing of unrelated code or configuration edits.
---

# DiffEditor

Deliver a reviewable text proposal through DiffEditor's local AI interface. Use it automatically for authorized local academic text editing, or for other text when the user explicitly requests DiffEditor. Before writing, establish which files and claims the user authorized changing. Propose out-of-scope issues in chat without changing them. Preserve existing todo items and their states.

## Workflow

1. **Capture immutable baselines before generating candidate text.** Run `baseline` for every intended formal target (including a new file's intended absolute path). Read the returned text, encoding, existence flag, hash, and baseline ID. Preserve the JSON receipt using exclusive creation in a unique workflow directory under the app inbox. Never replace a baseline with a fresh one to bypass a conflict or manufacture a clean comparison.
2. **Write the candidate only in the app draft area.** The inbox is `%LOCALAPPDATA%\DiffEditor\inbox`; when `DIFFEDITOR_DATA_DIR` is set, use that directory's `inbox`. Create a unique workflow subdirectory there. Preserve the baseline receipt and write a UTF-8 `candidate.json` containing the exact original baseline IDs and the complete proposed texts. Do not create or overwrite a formal target, including a new target, while drafting. Do not place temporary candidate files in the target directory. DiffEditor stores the submitted editable draft in its own data directory.
3. **Submit the structured JSON.** Run `submit --file <absolute-candidate.json>` or feed the JSON bytes through `submit --stdin`. Never interpolate document text into a shell command, command-line flag, or here-string. Generate JSON with a real serializer, preserving quotes, backslashes, Unicode, and newlines. Assign one unique `requestId` to this proposal and retain it for an exact retry.
4. **Report both lifecycle and file status.** Keep returned `reviewIds`; query `status <reviewId>` for each. Inspect `lifecycle` separately from each target's `status`. `open` means the comparison is open; `closed` means it is retained and a human must reopen it in the UI if further review is needed; `deleted` means the comparison was deleted. Never recreate a deleted comparison or submit it under a new request ID without a new user request. A successful submit or duplicate response is not approval or proof of saving. Finish the turn when awaiting human review; do not poll indefinitely.
5. **Respect final UI control.** Only the user's real UI confirmation may write formal targets. Never automate final clicks, call private IPC, write the target directly, or invent approve/save/force/close/delete commands. Chat permission such as “可以”“保存吧” is not the UI confirmation. The UI save backs up an existing target before replacing it; a new target has no old file to back up. Report a target as saved only when its `status` is `saved` and its `receipt` is present, even if the comparison is now closed or deleted. For several files, report saved, pending, and failed targets individually.

## Invocation and schemas

Read [references/cli.md](references/cli.md) for exact commands, JSON examples, and status handling. For deterministic invocation without shell content interpolation, use [scripts/invoke_diffeditor.py](scripts/invoke_diffeditor.py):

```text
python <skill-dir>/scripts/invoke_diffeditor.py baseline <absolute-target.tex>
python <skill-dir>/scripts/invoke_diffeditor.py submit --file <absolute-inbox-candidate.json>
python <skill-dir>/scripts/invoke_diffeditor.py status <reviewId>
```

The helper discovers a bundled installation, `DIFFEDITOR_HOME`, or `D:\Project\diffEditor`. `DIFFEDITOR_HOME` is the directory containing `diffeditor.cmd`. It invokes Node/Electron using an argument array and forwards stdin, UTF-8 JSON output, and the exit code. It keeps the caller's working directory. Packaged installations run without a separate system Node installation. Use the argument-array examples in the reference when calling it from an AI workflow; no GUI automation is needed for baseline, submit, or status.

## Retries and conflicts

- A duplicate submission returns the existing review IDs, including closed or deleted comparisons. Query their status; do not regenerate a different candidate with the same request ID, replace a deleted comparison with a new ID, or overwrite a user's in-app edits.
- After a timeout or truncated response, the operation may have reached the app. Query known review IDs (or inspect `status` when IDs were not returned) before deciding whether an exact retry is necessary. Retry only the identical payload with the same request ID. Stop when the outcome remains uncertain; never claim success from application launch.
- On conflict, preserve the pending draft and both versions. Explain the conflict; do not update the baseline, force-save, or overwrite the target. Let the user resolve it in the UI or explicitly request a new proposal from a new baseline.
- Preserve inbox artifacts and remaining in-app drafts on rejection, conflict, or error; those states are not authorization to delete or resubmit. A deleted comparison's draft may no longer exist; report its tombstone status without restoring it. A follow-up revision needs the user's requested scope and must preserve existing draft content until a new proposal is deliberately created.
- If DiffEditor is missing or fails to start, report the problem and leave formal files untouched. Do not substitute a direct write. Do not change hooks, configuration, or install globally as a side effect.
