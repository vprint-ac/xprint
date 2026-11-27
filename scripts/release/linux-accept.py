#!/usr/bin/env python3
"""Linux release acceptance against a real loopback CUPS queue.

Usage (inside the CI container, as root):
  linux-accept.py <xprint-<version>-linux-x64.zip> <fixture.cpp> <evidence-dir>

Starts dbus, Avahi, cupsd, and a loopback IPP printer; registers a CUPS queue;
runs the extracted CLI from a nested contest directory as an unprivileged user
with no Bun or Typst on PATH; and verifies the submitted PDF and job attributes.
"""

from __future__ import annotations

import os
from pathlib import Path
import pwd
import shutil
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from acceptance_common import (  # noqa: E402
    DEVICE, QUEUE, extract_archive, job_attributes, register_queue, run, tool,
    verify_job_attributes, verify_package_documents, verify_pdf, verify_receipt,
    wait_for_ipp_ready, wait_for_spool_pdf,
)


def start_services(evidence: Path, spool: Path) -> subprocess.Popen:
    # ippeveprinter needs Avahi even with -r off on Debian; Avahi needs dbus.
    for directory in ("/run/dbus", "/run/cups", "/var/spool/cups"):
        Path(directory).mkdir(parents=True, exist_ok=True)
    run("/usr/bin/dbus-daemon", "--system", "--fork")
    run("/usr/sbin/avahi-daemon", "--no-drop-root", "--no-chroot", "-D")
    subprocess.Popen(["/usr/sbin/cupsd"], stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
    ipp = subprocess.Popen(
        ["/usr/sbin/ippeveprinter", "-n", "localhost", "-p", "18633", "-r", "off", "-s", "60,60",
         "-k", "-d", str(spool), "-f", "application/pdf", QUEUE],
        stdout=(evidence / "ipp.log").open("ab"), stderr=subprocess.STDOUT,
    )
    ipptool = tool("ipptool", "/usr/bin/ipptool")
    wait_for_ipp_ready(ipptool)
    register_queue(tool("lpadmin", "/usr/sbin/lpadmin"), tool("lpstat", "/usr/bin/lpstat"), ipptool)
    run("/usr/sbin/lpadmin", "-d", QUEUE)
    (evidence / "lpstat-before.txt").write_text(run("/usr/bin/lpstat", "-t").stdout, encoding="utf-8")
    return ipp


def main() -> None:
    archive, fixture, evidence = (Path(argument).resolve() for argument in sys.argv[1:4])
    evidence.mkdir(parents=True, exist_ok=True)
    if os.geteuid() != 0:
        raise SystemExit("linux-accept.py must run as root to start cupsd and switch to nobody")

    spool = Path("/tmp/xprint-ipp-spool")
    if spool.exists():
        shutil.rmtree(spool)
    spool.mkdir()
    ipp = start_services(evidence, spool)
    try:
        package = extract_archive(archive, Path("/tmp/xprint-release"))
        cli = package / "xprint"
        assert cli.is_file() and os.access(cli, os.X_OK), cli

        contest = Path("/tmp/xprint-contest")
        if contest.exists():
            shutil.rmtree(contest)
        problem = contest / "A"
        problem.mkdir(parents=True)
        shutil.copyfile(fixture, problem / "A.cpp")
        home = Path("/tmp/xprint-home")
        if home.exists():
            shutil.rmtree(home)
        home.mkdir()
        nobody = pwd.getpwnam("nobody")
        for directory in (contest, home, spool):
            os.chown(directory, nobody.pw_uid, nobody.pw_gid)
        shutil.chown(problem / "A.cpp", nobody.pw_uid, nobody.pw_gid)

        def run_cli(*args: str) -> subprocess.CompletedProcess:
            # Unprivileged, from the problem subdirectory so the contest config
            # is inherited, with no Bun or Typst on PATH.
            return subprocess.run(
                ["/usr/sbin/runuser", "-u", "nobody", "--", "env", "-i",
                 f"HOME={home}", "PATH=/usr/bin:/bin", "CI=1", str(cli), *args],
                cwd=problem, capture_output=True, text=True, timeout=120,
            )

        pdfinfo, pdftotext, pdftoppm, ipptool = (
            tool(name, f"/usr/bin/{name}") for name in ("pdfinfo", "pdftotext", "pdftoppm", "ipptool")
        )
        for mode in ("monochrome", "color"):
            before = set(spool.glob("*.pdf"))
            (contest / ".xprint.yaml").write_text(
                f"printer: {QUEUE}\ncolor: {mode}\nteam: 校队\ncontest: 周六训练\nlocation: \"007\"\n",
                encoding="utf-8",
            )
            result = run_cli("-y", "A.cpp")
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
        refused = run_cli("A.cpp")
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
