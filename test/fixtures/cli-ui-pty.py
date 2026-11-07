"""Isolated real PTY, including terminal cleanup and bounded own-process teardown."""
import base64
import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import subprocess
import sys
import termios
import time

spec = json.load(sys.stdin)
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 45, 160, 0, 0))
before = termios.tcgetattr(slave)

def setup():
    os.setsid()
    fcntl.ioctl(slave, termios.TIOCSCTTY, 0)

proc = subprocess.Popen(spec["command"], cwd=spec["cwd"], env=spec["env"],
                        stdin=slave, stdout=slave, stderr=slave, preexec_fn=setup)
os.close(slave)
raw = bytearray()
actions = []

def plain(data):
    text = data.decode("utf8", "replace")
    text = re.sub(r'\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)', '', text)
    return re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', text)

def drain(seconds, pattern=None, offset=0):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if pattern and pattern in plain(raw[offset:]):
            return True
        if select.select([master], [], [], .05)[0]:
            try:
                data = os.read(master, 65536)
                if not data:
                    break
                raw.extend(data)
            except OSError:
                break
        if proc.poll() is not None:
            break
    return not pattern or pattern in plain(raw[offset:])

try:
    ready = drain(spec.get("startupTimeout", 12), spec.get("ready"))
    for action in spec.get("actions", []):
        if proc.poll() is not None:
            break
        offset = len(raw)
        os.write(master, action["text"].encode("utf8"))
        matched = drain(action.get("seconds", 1), action.get("waitFor"), offset)
        actions.append({"text": action["text"], "matched": matched})
        if action.get("required") and not matched:
            break
    drain(spec.get("finishSeconds", 1))
finally:
    # A PTY EOF can arrive just before waitpid sees the exit. Reap first; never
    # signal a process group after its leader was reaped and its PID can be reused.
    try:
        proc.wait(timeout=.2)
    except subprocess.TimeoutExpired:
        pass
    if proc.poll() is None:
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            if proc.poll() is None:
                proc.terminate()
        drain(2)
    if proc.poll() is None:
        os.killpg(proc.pid, signal.SIGKILL)
    proc.wait(timeout=3)
    restored = before == termios.tcgetattr(master)
    os.close(master)

print(json.dumps({"exitCode": proc.returncode, "ready": ready, "actions": actions,
                  "terminalRestored": restored, "outputBase64": base64.b64encode(raw).decode(),
                  "plain": plain(raw)}))
