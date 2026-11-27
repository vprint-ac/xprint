"""Packaging contract tests. Run with ``python3 -m unittest tests/package_test.py``."""

import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
import zipfile

REPO = Path(__file__).resolve().parent.parent
HELPER = REPO / "scripts" / "package.py"
PINNED_SUMATRA = {
    "version": "3.6.1",
    "url": "https://www.sumatrapdfreader.org/dl/rel/3.6.1/SumatraPDF-3.6.1-64.zip",
    "sha256": "98b33a518d42986856d225064b0cd2d3643ecf78cbf84ab873d26cc51877a544",
    "exe": "SumatraPDF-3.6.1-64.exe",
    "exeSha256": "719f689b34f47be8ca105ce8484948474dafde0e106bab599e4a89326070c3d0",
    "signer": "Krzysztof Kowalczyk",
    "license": "GPL-3.0",
    "source": "https://github.com/sumatrapdfreader/sumatrapdf/releases/tag/3.6.1rel",
}


def run_helper(*args, cwd=None):
    return subprocess.run(
        [sys.executable, str(HELPER), *map(str, args)],
        cwd=cwd or REPO,
        capture_output=True,
        text=True,
    )


class PackageTests(unittest.TestCase):
    def setUp(self):
        self.work = Path(tempfile.mkdtemp(prefix="xprint-package-"))
        self.addCleanup(lambda: subprocess.run(["rm", "-rf", str(self.work)]))
        self.manifest = self.work / "sumatra.json"
        self.manifest.write_text(json.dumps(PINNED_SUMATRA))
        # A minimal self-contained checkout so the test does not depend on which
        # sibling issue has merged its documents into this worktree.
        self.root = self.work / "repo"
        self.write("package.json", json.dumps({"name": "xprint", "version": "0.1.0"}))
        self.write("README.md", "# xprint\n")
        self.write("LICENSE", "AGPL-3.0\n")
        self.write("DESIGN.md", "# design\n")
        self.write("GLOSSARY.md", "# glossary\n")
        self.write("THIRD_PARTY_LICENSES.md", "# third party\n")
        self.write("licenses/typst.ts-APACHE-2.0.txt", "Apache-2.0\n")
        self.write("licenses/sumatrapdf-GPL-3.0.txt", "GPL-3.0\n")
        self.write("windows/README.md", "# windows\n")
        self.write("windows/sumatra.json", json.dumps(PINNED_SUMATRA))
        self.write("windows/fetch-sumatra.ps1", "param()\n")

    def write(self, relative, content):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)

    def package(self, target, binary, *extra, out=None):
        out = out or self.work / "release"
        return run_helper(
            "--root", self.root,
            "--target", target,
            "--binary", binary,
            "--sumatra-manifest", self.manifest,
            "--out", out,
            *extra,
        )

    def test_precompiled_binary_is_packaged_with_documents_and_checksums(self):
        binary_dir = self.work / "input"
        binary_dir.mkdir()
        binary = binary_dir / "xprint"
        binary.write_text("#!/bin/sh\necho precompiled\n")
        binary.chmod(0o755)

        result = self.package("linux-x64", binary)
        self.assertEqual(result.returncode, 0, result.stderr)

        release = self.work / "release"
        archive = release / "xprint-0.1.0-linux-x64.zip"
        self.assertTrue(archive.is_file())
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        self.assertEqual(
            (release / "xprint-0.1.0-linux-x64.zip.sha256").read_text().strip(),
            f"{digest}  xprint-0.1.0-linux-x64.zip",
        )
        sums = (release / "SHA256SUMS").read_text()
        self.assertIn(f"{digest}  xprint-0.1.0-linux-x64.zip", sums)
        with zipfile.ZipFile(archive) as package:
            names = package.namelist()
            prefix = "xprint-0.1.0-linux-x64/"
            for expected in (
                "xprint",
                "README.md",
                "LICENSE",
                "DESIGN.md",
                "GLOSSARY.md",
                "THIRD_PARTY_LICENSES.md",
                "licenses/typst.ts-APACHE-2.0.txt",
                "licenses/sumatrapdf-GPL-3.0.txt",
            ):
                self.assertIn(prefix + expected, names)
            self.assertFalse([name for name in names if "/windows/" in name])
            self.assertIn(b"precompiled", package.read(prefix + "xprint"))
            mode = package.getinfo(prefix + "xprint").external_attr >> 16
            self.assertTrue(mode & stat.S_IXUSR, "executable bit must survive packaging")
            self.assertEqual(
                sorted(names), names, "archive entries must be deterministic and sorted"
            )
            for info in package.infolist():
                self.assertEqual(info.date_time, (2026, 11, 27, 0, 0, 0))

    def test_windows_requires_a_sumatra_executable_matching_the_manifest(self):
        binary_dir = self.work / "input"
        binary_dir.mkdir()
        binary = binary_dir / "xprint.exe"
        binary.write_bytes(b"MZ fake xprint\n")
        sumatra = self.work / PINNED_SUMATRA["exe"]
        sumatra.write_bytes(b"MZ fake sumatra\n")

        missing = self.package("windows-x64", binary)
        self.assertNotEqual(missing.returncode, 0)
        self.assertIn("--sumatra", missing.stderr)
        self.assertFalse((self.work / "release").exists())

        mismatch = self.package("windows-x64", binary, "--sumatra", sumatra)
        self.assertNotEqual(mismatch.returncode, 0)
        self.assertIn("SHA256", mismatch.stderr)
        self.assertFalse((self.work / "release").exists())

        manifest = dict(PINNED_SUMATRA, exeSha256=hashlib.sha256(sumatra.read_bytes()).hexdigest())
        self.manifest.write_text(json.dumps(manifest))
        out = self.work / "release-verified"
        verified = self.package("windows-x64", binary, "--sumatra", sumatra, out=out)
        self.assertEqual(verified.returncode, 0, verified.stderr)
        with zipfile.ZipFile(out / "xprint-0.1.0-windows-x64.zip") as package:
            names = package.namelist()
            prefix = "xprint-0.1.0-windows-x64/"
            self.assertIn(prefix + "xprint.exe", names)
            self.assertIn(prefix + PINNED_SUMATRA["exe"], names)
            self.assertIn(prefix + "windows/README.md", names)
            self.assertIn(prefix + "windows/sumatra.json", names)
            self.assertEqual(
                json.loads(package.read(prefix + "windows/sumatra.json"))["exeSha256"],
                manifest["exeSha256"],
                "the packaged manifest must be the one the executable was verified against",
            )

    def test_rerunning_the_helper_produces_identical_archives(self):
        binary = self.work / "xprint"
        binary.write_text("#!/bin/sh\necho precompiled\n")
        binary.chmod(0o755)
        first = self.package("linux-x64", binary, out=self.work / "release")
        self.assertEqual(first.returncode, 0, first.stderr)
        archive = self.work / "release" / "xprint-0.1.0-linux-x64.zip"
        before = archive.read_bytes()
        second = self.package("linux-x64", binary, out=self.work / "release")
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertEqual(before, archive.read_bytes())

    def test_unknown_target_is_rejected_before_output_is_created(self):
        out = self.work / "not-created"
        result = run_helper("--root", self.root, "--target", "freebsd-x64", "--out", out)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("linux-x64", result.stderr)
        self.assertFalse(out.exists())


if __name__ == "__main__":
    unittest.main()
