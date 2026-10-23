"""Invoke DiffEditor without placing candidate text in shell command strings."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in ("baseline", "submit", "status"):
        raise ValueError("Only baseline, submit, and status are supported; no CLI save or approval exists.")
    explicit = os.environ.get("DIFFEDITOR_HOME")
    roots = [Path(explicit)] if explicit else [Path(__file__).resolve().parents[3], Path(r"D:\Project\diffEditor")]
    for root in roots:
        if not (root / "diffeditor.cmd").is_file():
            continue
        env = os.environ.copy()
        portable_cli = root / "cli.cjs"
        if portable_cli.is_file() and (root / "DiffEditor.exe").is_file():
            command = [str(root / "DiffEditor.exe"), str(portable_cli)]
            env["ELECTRON_RUN_AS_NODE"] = "1"
        elif (root / "dist-electron" / "cli.cjs").is_file():
            node = shutil.which("node")
            electron = root / "node_modules" / "electron" / "dist" / "electron.exe"
            if node:
                command = [node, str(root / "dist-electron" / "cli.cjs")]
                env.pop("ELECTRON_RUN_AS_NODE", None)
            elif electron.is_file():
                command = [str(electron), str(root / "dist-electron" / "cli.cjs")]
                env["ELECTRON_RUN_AS_NODE"] = "1"
            else:
                continue
        else:
            continue
        # Inherit cwd so relative target/input paths retain the caller's meaning.
        return subprocess.run(command + sys.argv[1:], env=env, shell=False).returncode
    raise FileNotFoundError("DiffEditor CLI not found or not built. Set DIFFEDITOR_HOME to the installation directory.")


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError) as error:
        sys.stdout.buffer.write((json.dumps({"ok": False, "code": "CLI_HELPER_ERROR", "error": str(error)}, ensure_ascii=False) + "\n").encode("utf-8"))
        sys.exit(1)
