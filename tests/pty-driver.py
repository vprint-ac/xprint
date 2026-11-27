"""Drive the compiled CLI under a real PTY for interactive confirmation tests.

usage: pty-driver.py BINARY ARGS_JSON CWD PATH KEYS_JSON

Waits for the confirmation prompt before writing KEYS_JSON, then reports the
exit status as "XPRINT_EXIT=<code>" on stdout after the child's output.
"""
import errno
import fcntl
import json
import os
import pty
import select
import struct
import subprocess
import sys
import termios
import time

binary, args_json, cwd, path_value, keys_json = sys.argv[1:6]
before_keys = sys.argv[6] if len(sys.argv) > 6 else None
args = json.loads(args_json)
keys = json.loads(keys_json)

env = dict(os.environ)
env["PATH"] = path_value
env.pop("CI", None)

master, slave = pty.openpty()
# Clack reads the terminal width to lay out the prompt. Without a size the
# prompt still renders but keypress handling stalls on macOS.
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))

child = subprocess.Popen(
    [binary] + args,
    cwd=cwd,
    env=env,
    stdin=slave,
    stdout=slave,
    stderr=slave,
)
os.close(slave)

prompt_marker = "确认打印".encode()
output = b""
sent = False
started = time.monotonic()
timed_out = False
while time.monotonic() - started < 20:
    readable, _, _ = select.select([master], [], [], 0.05)
    if readable:
        try:
            chunk = os.read(master, 4096)
        except OSError as error:
            if error.errno != errno.EIO:
                raise
            break  # Linux reports a closed PTY slave as EIO.
        if not chunk:
            break
        output += chunk
    if not sent and prompt_marker in output:
        if before_keys:
            subprocess.run(before_keys, shell=True, cwd=cwd, check=True)
        for key in keys:
            os.write(master, key.encode("latin1"))
            time.sleep(0.05)
        sent = True
else:
    timed_out = True

if timed_out:
    child.kill()
status = child.wait()
try:
    os.close(master)
except OSError:
    pass

sys.stdout.buffer.write(output)
sys.stdout.buffer.write(b"\nXPRINT_EXIT=%d\n" % status)
