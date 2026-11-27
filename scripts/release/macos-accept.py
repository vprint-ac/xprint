#!/usr/bin/env python3
"""macOS release acceptance against a real loopback CUPS queue.

Usage (as a normal user with Poppler installed):
  macos-accept.py <xprint-<version>-macos-arm64.zip> <fixture.cpp> <evidence-dir>

Starts a localhost IPP printer, registers it with CUPS through the same
cups-create-local-printer path the desktop "Add Printer" dialogue uses, runs the
extracted CLI from a nested contest directory, and verifies the submitted PDF.
"""

from __future__ import annotations

import os
from pathlib import Path
import shutil
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from acceptance_common import (  # noqa: E402
    QUEUE, extract_archive, job_attributes, register_queue, run, tool,
    verify_job_attributes, verify_package_documents, verify_pdf, verify_receipt,
    wait_for_ipp_ready, wait_for_spool_pdf,
)

# Runner-level egress policy for the acceptance smoke: everything is allowed
# except outbound network to non-loopback addresses. Loopback stays open so the
# CLI can reach CUPS and the IPP queue. This proves the packaged binary needs no
# network at print time; it is not a claim about the user's own firewall.
OFFLINE_POLICY = (
    "(version 1)(allow default)"
    '(deny network-outbound (require-all (remote ip) (require-not (remote ip "localhost:*"))))'
)


def offline(command: list[str], **kwargs) -> subprocess.CompletedProcess:
    return subprocess.run(["/usr/bin/sandbox-exec", "-p", OFFLINE_POLICY, *command], **kwargs)


def main() -> None:
    archive, fixture, evidence = (Path(argument).resolve() for argument in sys.argv[1:4])
    evidence.mkdir(parents=True, exist_ok=True)
    if os.geteuid() == 0:
        raise SystemExit("run as a normal user, not root, so CUPS and the CLI behave like a user's")

    spool = evidence / "ipp-spool"
    if spool.exists():
        shutil.rmtree(spool)
    spool.mkdir()
    ipp = subprocess.Popen(
        ["/usr/bin/ippeveprinter", "-n", "localhost", "-p", "18633", "-r", "off", "-s", "60,60",
         "-k", "-d", str(spool), "-f", "application/pdf", "XPrintCI"],
        stdout=(evidence / "ipp.log").open("ab"), stderr=subprocess.STDOUT,
    )
    try:
        ipptool = tool("ipptool", "/usr/bin/ipptool")
        wait_for_ipp_ready(ipptool)
        register_queue(tool("lpadmin", "/usr/sbin/lpadmin"), tool("lpstat", "/usr/bin/lpstat"), ipptool)

        package = extract_archive(archive, evidence / "install")
        cli = package / "xprint"
        assert cli.is_file() and os.access(cli, os.X_OK), cli

        contest = evidence / "contest"
        if contest.exists():
            shutil.rmtree(contest)
        problem = contest / "A"
        problem.mkdir(parents=True)
        shutil.copyfile(fixture, problem / "A.cpp")
        home = evidence / "home"
        home.mkdir(exist_ok=True)
        env = {"HOME": str(home), "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "CI": "1", "LPDEST": QUEUE}

        pdfinfo = tool("pdfinfo", "/opt/homebrew/bin/pdfinfo", "/usr/local/bin/pdfinfo")
        pdftotext = tool("pdftotext", "/opt/homebrew/bin/pdftotext", "/usr/local/bin/pdftotext")
        pdftoppm = tool("pdftoppm", "/opt/homebrew/bin/pdftoppm", "/usr/local/bin/pdftoppm")
        for mode in ("monochrome", "color"):
            before = set(spool.glob("*.pdf"))
            (contest / ".xprint.yaml").write_text(
                f"printer: {QUEUE}\ncolor: {mode}\nteam: 校队\ncontest: 周六训练\nlocation: \"007\"\n",
                encoding="utf-8",
            )
            result = offline(
                [str(cli), "-y", "A.cpp"], cwd=problem, env=env, capture_output=True, text=True, timeout=120,
            )
            receipt = result.stdout + "\n" + result.stderr
            (evidence / f"{mode}-receipt.txt").write_text(receipt, encoding="utf-8")
            print(receipt, flush=True)
            assert result.returncode == 0, (result.returncode, receipt)
            job_id = verify_receipt(receipt)
            pdf = wait_for_spool_pdf(spool, before)
            actual = evidence / f"{mode}-submitted.pdf"
            shutil.copyfile(pdf, actual)

            attributes = job_attributes(ipptool, job_id)
            (evidence / f"{mode}-job-attributes.txt").write_text(attributes, encoding="utf-8")
            verify_job_attributes(attributes, mode)
            verify_pdf(pdfinfo, pdftotext, pdftoppm, actual, evidence, mode)

        before = set(spool.glob("*.pdf"))
        refused = offline(
            [str(cli), "A.cpp"], cwd=problem, env=env, capture_output=True, text=True, timeout=120,
        )
        (evidence / "no-yes.txt").write_text(refused.stdout + "\n" + refused.stderr, encoding="utf-8")
        assert refused.returncode != 0
        assert "-y" in refused.stdout + refused.stderr
        assert set(spool.glob("*.pdf")) == before

        verify_package_documents(package)
        print("ACCEPTANCE PASSED", flush=True)
        print(f"  queue: {QUEUE}", flush=True)
    finally:
        ipp.terminate()
        try:
            ipp.wait(timeout=5)
        except subprocess.TimeoutExpired:
            ipp.kill()


if __name__ == "__main__":
    main()
