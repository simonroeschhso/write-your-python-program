# Throwaway: generates a real trace for browser dev mode, so the ELK pipeline can be
# checked against the example programs of elk-plan.md 9.1 instead of the tiny checked-in
# placeholder. Deleted together with the rest of elk-task/spike (plan 7.9).
#
#   npm run build:web
#   python3 elk-task/spike/make-trace.py elk-task/example.py
#   (serve out/programflow-visualization/web over HTTP, open with #elk)
#
# Writes into out/, never into src/, so the checked-in placeholder stays untouched.
import json
import os
import socket
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
GENERATOR = os.path.join(ROOT, "pytrace-generator", "main.py")
TARGET = os.path.join(
    ROOT, "out", "programflow-visualization", "web", "example-trace-content.js"
)


def read_entries(data):
    entries = []
    while data:
        length = int.from_bytes(data[:4], byteorder="big", signed=False)
        data = data[4:]
        entries.append(json.loads(str(data[:length], encoding="utf-8")))
        data = data[length:]
    return entries


def collect(python_file):
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.bind(("127.0.0.1", 0))
    server.listen(1)
    port = server.getsockname()[1]
    process = subprocess.Popen(["python3", GENERATOR, python_file, str(port)])
    connection, _ = server.accept()
    data = bytearray()
    while True:
        buf = connection.recv(4096)
        if not buf:
            break
        data.extend(buf)
    connection.close()
    server.close()
    process.wait()
    return read_entries(data)


def main():
    if len(sys.argv) != 2:
        print(f"usage: {sys.argv[0]} <python-file>", file=sys.stderr)
        return 2
    entries = collect(os.path.abspath(sys.argv[1]))
    payload = json.dumps({"complete": True, "trace": entries}, indent=1)
    with open(TARGET, "w", encoding="utf-8") as f:
        f.write("/* eslint-disable */\n")
        f.write(f"// generated from {sys.argv[1]} by elk-task/spike/make-trace.py\n")
        f.write(f"window.__PROGRAMFLOW_TRACE__ = {payload};\n")
    print(f"{len(entries)} steps -> {TARGET}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
