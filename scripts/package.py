#!/usr/bin/env python3
"""Build deterministic xprint release archives.

Examples:
  python3 scripts/package.py --target linux-x64
  python3 scripts/package.py --target macos-arm64 --binary dist/xprint-macos-arm64
  python3 scripts/package.py --target windows-x64 --sumatra dist/sumatra/SumatraPDF-3.6.1-64.exe
  python3 scripts/package.py --target all --sumatra <verified exe>

Each target produces dist/release/xprint-<version>-<target>.zip, a sibling
.sha256 file, and SHA256SUMS over every archive in the output directory.
--binary skips Bun's compile step for an executable already built elsewhere,
for example a cross-compiled binary or one built on the target runner.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import zipfile

TARGETS = ("linux-x64", "macos-arm64", "windows-x64")
BUN_TARGETS = {
    "linux-x64": "bun-linux-x64",
    "macos-arm64": "bun-darwin-arm64",
    "windows-x64": "bun-windows-x64",
}
EXECUTABLE_NAMES = {"linux-x64": "xprint", "macos-arm64": "xprint", "windows-x64": "xprint.exe"}
# LICENSE is required: every archive must carry the project's own license.
REQUIRED_DOCUMENTS = ("README.md", "LICENSE", "THIRD_PARTY_LICENSES.md")
OPTIONAL_DOCUMENTS = ("DESIGN.md", "GLOSSARY.md", "docs/acceptance.md")
WINDOWS_DOCUMENTS = ("windows/README.md", "windows/sumatra.json", "windows/fetch-sumatra.ps1")
# Fixed timestamps keep archives byte-for-byte reproducible when inputs change
# only in mtime. 2026-11-27 is the xprint 0.1.0 packaging date.
ARCHIVE_TIMESTAMP = (2026, 11, 27, 0, 0, 0)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build xprint release archives.")
    parser.add_argument("--target", choices=(*TARGETS, "all"), default="all")
    parser.add_argument("--binary", type=Path, help="package an already compiled executable and skip Bun")
    parser.add_argument("--sumatra", type=Path, help="verified SumatraPDF executable for the Windows archive")
    parser.add_argument("--sumatra-manifest", type=Path,
                        help="SumatraPDF pin manifest (defaults to <root>/windows/sumatra.json)")
    parser.add_argument("--out", type=Path)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parent.parent,
                        help="repository root (defaults to the checkout containing this script)")
    args = parser.parse_args(argv)
    args.root = args.root.resolve()
    args.out = (args.out or args.root / "dist" / "release").resolve()
    args.sumatra_manifest = (args.sumatra_manifest or args.root / "windows" / "sumatra.json").resolve()
    if args.target == "all" and args.binary:
        parser.error("--binary requires a single explicit --target")
    return args


def load_manifest(path: Path) -> dict:
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise SystemExit(f"xprint-package: cannot read SumatraPDF manifest {path}: {error}") from error
    if not isinstance(manifest.get("exe"), str) or not isinstance(manifest.get("exeSha256"), str):
        raise SystemExit(f"xprint-package: SumatraPDF manifest {path} needs exe and exeSha256")
    return manifest


def build(target: str, out: Path, root: Path) -> Path:
    binary = out / "build" / EXECUTABLE_NAMES[target]
    binary.parent.mkdir(parents=True, exist_ok=True)
    bun = shutil.which("bun") or fail("bun is required to build; pass --binary for a precompiled executable")
    command = [
        bun,
        "build",
        str(root / "src" / "index.ts"),
        "--compile",
        "--no-compile-autoload-dotenv",
        "--no-compile-autoload-bunfig",
        "--target",
        BUN_TARGETS[target],
        "--outfile",
        str(binary),
    ]
    print("build", target, subprocess.list2cmdline(command), flush=True)
    result = subprocess.run(command, cwd=root)
    if result.returncode != 0:
        raise SystemExit(result.returncode)
    return binary


def verify_sumatra(path: Path, expected: str) -> None:
    if not path.is_file():
        raise SystemExit(f"xprint-package: --sumatra must be a regular file: {path}")
    actual = sha256(path)
    if actual != expected:
        raise SystemExit(
            f"xprint-package: SumatraPDF SHA256 mismatch: expected {expected}, got {actual}"
        )


def write_archive(archive: Path, payload: Path, name: str) -> None:
    """Write a fresh deterministic zip and atomically replace any older one."""
    archive.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary = tempfile.mkstemp(prefix=f".{archive.name}.", suffix=".tmp", dir=archive.parent)
    os.close(handle)
    temporary_path = Path(temporary)
    try:
        with zipfile.ZipFile(temporary_path, "w", compression=zipfile.ZIP_DEFLATED) as package:
            for path in sorted(payload.rglob("*"), key=lambda entry: entry.relative_to(payload).as_posix()):
                if path.is_dir():
                    continue
                info = zipfile.ZipInfo(f"{name}/{path.relative_to(payload).as_posix()}", ARCHIVE_TIMESTAMP)
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = (0o100755 if os.access(path, os.X_OK) else 0o100644) << 16
                package.writestr(info, path.read_bytes())
        temporary_path.chmod(0o644)
        os.replace(temporary_path, archive)
    finally:
        temporary_path.unlink(missing_ok=True)


def package_target(target: str, args: argparse.Namespace, manifest: dict, version: str) -> None:
    name = f"xprint-{version}-{target}"
    stage = args.out / "stage" / target
    payload = stage / name
    archive = args.out / f"{name}.zip"

    binary = args.binary or build(target, args.out, args.root)
    if stage.exists():
        shutil.rmtree(stage)
    payload.mkdir(parents=True)
    shutil.copy2(binary, payload / EXECUTABLE_NAMES[target])
    documents = list(REQUIRED_DOCUMENTS)
    documents += [document for document in OPTIONAL_DOCUMENTS if (args.root / document).is_file()]
    if target == "windows-x64":
        documents += list(WINDOWS_DOCUMENTS)
    for document in documents:
        destination = payload / document
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(args.root / document, destination)
    shutil.copytree(args.root / "licenses", payload / "licenses")

    if target == "windows-x64":
        shutil.copy2(args.sumatra, payload / manifest["exe"])
        # Ship the manifest the executable was verified against.
        shutil.copy2(args.sumatra_manifest, payload / "windows" / "sumatra.json")

    write_archive(archive, payload, name)
    digest = sha256(archive)
    archive.with_name(archive.name + ".sha256").write_bytes(f"{digest}  {archive.name}\n".encode("utf-8"))
    print(f"{archive.name}  sha256={digest}", flush=True)


def write_checksums(out: Path) -> None:
    lines = [
        f"{sha256(path)}  {path.name}\n"
        for path in sorted(out.glob("xprint-*.zip"), key=lambda entry: entry.name)
    ]
    (out / "SHA256SUMS").write_bytes("".join(lines).encode("utf-8"))


def main(argv: list[str]) -> None:
    args = parse_args(argv)
    manifest = load_manifest(args.sumatra_manifest)
    targets = TARGETS if args.target == "all" else (args.target,)
    version = json.loads((args.root / "package.json").read_text(encoding="utf-8"))["version"]
    for target in targets:
        validate(target, args, manifest)
    args.out.mkdir(parents=True, exist_ok=True)
    for target in targets:
        package_target(target, args, manifest, version)
    write_checksums(args.out)


def validate(target: str, args: argparse.Namespace, manifest: dict) -> None:
    if target == "windows-x64":
        if not args.sumatra:
            raise SystemExit(
                "xprint-package: windows-x64 needs --sumatra <SumatraPDF-3.6.1-64.exe>. "
                "Fetch and verify it with pwsh ./windows/fetch-sumatra.ps1 -Destination dist/sumatra."
            )
        verify_sumatra(args.sumatra, manifest["exeSha256"])
    if args.binary and not args.binary.is_file():
        raise SystemExit(f"xprint-package: executable not found: {args.binary}")
    missing = [document for document in REQUIRED_DOCUMENTS if not (args.root / document).is_file()]
    if not (args.root / "licenses").is_dir():
        missing.append("licenses/")
    if target == "windows-x64":
        missing += [document for document in WINDOWS_DOCUMENTS if not (args.root / document).is_file()]
    if missing:
        raise SystemExit(f"xprint-package: missing package documents: {', '.join(missing)}")


if __name__ == "__main__":
    main(sys.argv[1:])
