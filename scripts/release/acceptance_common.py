"""Shared logic for the Linux and macOS release acceptance scripts.

Both platforms register the same loopback IPP queue with CUPS, run the
extracted CLI from a nested contest directory, and verify the same receipt,
PDF, job attributes, and package contents.
"""

from __future__ import annotations

from pathlib import Path
import re
import shutil
import subprocess
import time
import zipfile

QUEUE = "XPrintCI"
DEVICE = "ipp://localhost:18633/ipp/print"
EXPECTED_PAGES = 7


def run(*args: str, check = True, **kwargs) -> subprocess.CompletedProcess:
    return subprocess.run(args, check=check, capture_output=True, text=True, **kwargs)


def tool(name: str, *locations: str) -> str:
    for candidate in (shutil.which(name), *locations):
        if candidate and Path(candidate).is_file():
            return candidate
    raise SystemExit(f"required tool not found: {name}")


def wait_for_ipp_ready(ipptool: str, timeout: float = 15) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        ready = subprocess.run(
            [ipptool, "-t", DEVICE, "get-printer-attributes.test"], capture_output=True
        )
        if ready.returncode == 0:
            return
        time.sleep(0.25)
    raise SystemExit("loopback IPP printer did not start")


def wait_for_spool_pdf(spool: Path, before: set[Path], timeout: float = 60) -> Path:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        produced = [
            path
            for path in set(spool.glob("*.pdf")) - before
            if path.stat().st_size and path.read_bytes().rstrip().endswith(b"%%EOF")
        ]
        if produced:
            return produced[0]
        time.sleep(0.25)
    raise SystemExit(f"timed out waiting for a complete PDF in {spool}")


def register_queue(lpadmin: str, lpstat: str, ipptool: str) -> None:
    """Register the loopback printer with CUPS if it is not already present."""
    state = subprocess.run([lpstat, "-v", QUEUE], capture_output=True, text=True)
    if state.returncode == 0 and DEVICE in state.stdout:
        return
    # cups-create-local-printer.test is the same path the desktop "Add Printer"
    # dialogue uses; it works for both root and an ordinary user.
    run(ipptool, "-t", "-d", f"name={QUEUE}", "-d", f"device={DEVICE}", "ipp://localhost/",
        "cups-create-local-printer.test")
    assert DEVICE in run(lpstat, "-v", QUEUE).stdout


def extract_archive(archive: Path, install: Path) -> Path:
    if install.exists():
        shutil.rmtree(install)
    install.mkdir(parents=True)
    with zipfile.ZipFile(archive) as package:
        package.extractall(install)
        # extractall drops the Unix mode; restore it from the zip entry.
        for info in package.infolist():
            mode = (info.external_attr >> 16) & 0o777
            if mode:
                (install / info.filename).chmod(mode)
    packages = list(install.glob("xprint-*"))
    assert len(packages) == 1, packages
    return packages[0]


def verify_package_documents(package: Path) -> None:
    for document in ("LICENSE", "README.md", "THIRD_PARTY_LICENSES.md"):
        assert (package / document).is_file(), document
    assert any((package / "licenses").iterdir()), "licenses/ is empty"


def read_pnm(path: Path) -> tuple[bytes, int, int, bytes]:
    data = path.read_bytes()
    fields: list[bytes] = []
    pos = 0
    while len(fields) < 4:
        while data[pos:pos + 1].isspace():
            pos += 1
        if data[pos:pos + 1] == b"#":
            while data[pos:pos + 1] != b"\n":
                pos += 1
            continue
        end = pos
        while not data[end:end + 1].isspace():
            end += 1
        fields.append(data[pos:end])
        pos = end
    magic, width, height = fields[0], int(fields[1]), int(fields[2])
    while data[pos:pos + 1].isspace():
        pos += 1
    return magic, width, height, data[pos:]


def raster_chroma(pdftoppm: str, pdf: Path, evidence: Path, label: str) -> int:
    """Return the number of non-grey pixels across every page of the PDF."""
    prefix = evidence / f"{label}-raster"
    run(pdftoppm, "-r", "24", str(pdf), str(prefix))
    total = 0
    for page in sorted(evidence.glob(f"{label}-raster-*.ppm")):
        magic, width, height, pixels = read_pnm(page)
        assert magic == b"P6" and len(pixels) == width * height * 3, page
        coloured = sum(
            1
            for index in range(0, len(pixels), 3)
            if max(pixels[index:index + 3]) - min(pixels[index:index + 3]) > 16
        )
        print(f"raster {page.name} {width}x{height} coloured_pixels={coloured}", flush=True)
        total += coloured
    return total


def verify_pdf(pdfinfo: str, pdftotext: str, pdftoppm: str, actual: Path, evidence: Path, mode: str) -> None:
    info = run(pdfinfo, str(actual)).stdout
    pages = int(re.search(r"Pages:\s+(\d+)", info).group(1))
    text = run(pdftotext, "-layout", str(actual), "-").stdout
    (evidence / f"{mode}-submitted.txt").write_text(text, encoding="utf-8")
    assert pages == EXPECTED_PAGES, info
    # The loopback IPP printer stores pages newest-first, so every check is
    # made on the whole document rather than a physical page order.
    assert text.count(f"Page 1 of {EXPECTED_PAGES}") == 1
    assert text.count(f"Page {EXPECTED_PAGES} of {EXPECTED_PAGES}") == 1
    assert text.count("[007] 校队") == EXPECTED_PAGES
    assert text.count("filename: A.cpp") == EXPECTED_PAGES
    assert text.count("line 359 赛场") == 1
    assert text.count("return 0; // 最后一行") == 1
    chroma = raster_chroma(pdftoppm, actual, evidence, mode)
    if mode == "monochrome":
        assert chroma == 0, f"monochrome printout has {chroma} coloured pixels"
    else:
        assert chroma > 0, "color printout has no coloured pixels"


def job_attributes(ipptool: str, job_id: str) -> str:
    # CUPS addresses jobs by numeric id; the receipt reports "XPrintCI-12".
    numeric = job_id.rsplit("-", 1)[-1]
    result = run(ipptool, "-tv", f"ipp://localhost/jobs/{numeric}", "get-job-attributes.test", check=False)
    return result.stdout + result.stderr


def verify_job_attributes(attributes: str, mode: str) -> None:
    assert re.search(r"copies \(integer\) = 1\b", attributes), attributes
    expected = "monochrome" if mode == "monochrome" else "color"
    assert re.search(rf"print-color-mode \(keyword\) = {expected}\b", attributes), attributes


def verify_receipt(receipt: str) -> str:
    assert "已提交到" in receipt and QUEUE in receipt, receipt
    job = re.search(r"作业号 (\S+?)。", receipt)
    assert job, receipt
    return job.group(1)
