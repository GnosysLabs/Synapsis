#!/usr/bin/env python3

import json
import os
import signal
import socketserver
import subprocess
import threading
import time
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler

SOCKET_PATH = os.environ.get("HOST_UPDATER_SOCKET", "/var/run/synapsis-updater/updater.sock")
TOKEN = os.environ.get("HOST_UPDATER_TOKEN", "")
STATUS_FILE = os.environ.get("HOST_UPDATER_STATUS_FILE", "/opt/synapsis/updater-status.json")
LOG_FILE = os.environ.get("HOST_UPDATER_LOG_FILE", "/opt/synapsis/updater.log")
UPDATE_SCRIPT = os.environ.get("HOST_UPDATER_SCRIPT", "/opt/synapsis/update-local.sh")
INSTALL_DIR = os.environ.get("INSTALL_DIR", "/opt/synapsis")

status_lock = threading.RLock()
current_process = None


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def ensure_parent_dirs():
    os.makedirs(os.path.dirname(SOCKET_PATH), exist_ok=True)
    os.makedirs(os.path.dirname(STATUS_FILE), exist_ok=True)
    os.makedirs(os.path.dirname(LOG_FILE), exist_ok=True)


def load_status():
    if not os.path.exists(STATUS_FILE):
        return {
            "available": True,
            "status": "idle",
            "message": "Ready to update.",
            "lastStartedAt": None,
            "lastFinishedAt": None,
            "lastExitCode": None,
            "lastError": None,
            "pid": None,
        }

    with open(STATUS_FILE, "r", encoding="utf-8") as handle:
        return json.load(handle)


def save_status(status):
    with open(STATUS_FILE, "w", encoding="utf-8") as handle:
        json.dump(status, handle, indent=2)


def update_status(**changes):
    with status_lock:
        status = load_status()
        status.update(changes)
        save_status(status)
        return status


def is_authorized(headers):
    expected = f"Bearer {TOKEN}"
    return bool(TOKEN) and headers.get("Authorization", "") == expected


def watch_process(process):
    global current_process
    exit_code = process.wait()
    with status_lock:
        current_process = None
        update_status(
            status="success" if exit_code == 0 else "error",
            message="Synapsis update completed." if exit_code == 0 else "Synapsis update failed.",
            lastFinishedAt=now_iso(),
            lastExitCode=exit_code,
            lastError=None if exit_code == 0 else f"Updater exited with code {exit_code}",
            pid=None,
        )


def start_update_process():
    global current_process

    # Give the app enough time to return the 202 response before the container restarts.
    time.sleep(2)

    with status_lock:
        log_handle = open(LOG_FILE, "a", encoding="utf-8")
        current_process = subprocess.Popen(
            [UPDATE_SCRIPT],
            cwd=INSTALL_DIR,
            stdout=log_handle,
            stderr=subprocess.STDOUT,
            start_new_session=True,
            env={
                **os.environ,
                "INSTALL_DIR": INSTALL_DIR,
            },
        )

        update_status(pid=current_process.pid)

    thread = threading.Thread(target=watch_process, args=(current_process,), daemon=True)
    thread.start()


class ThreadedUnixServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True


class Handler(BaseHTTPRequestHandler):
    server_version = "SynapsisHostUpdater/1.0"

    def log_message(self, format, *args):
        return

    def send_json(self, status_code, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self.send_json(HTTPStatus.OK, {"ok": True})
            return

        if self.path == "/status":
            if not is_authorized(self.headers):
                self.send_json(HTTPStatus.UNAUTHORIZED, {"error": "Unauthorized"})
                return
            self.send_json(HTTPStatus.OK, load_status())
            return

        self.send_json(HTTPStatus.NOT_FOUND, {"error": "Not found"})

    def do_POST(self):
        global current_process

        if self.path != "/update":
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "Not found"})
            return

        if not is_authorized(self.headers):
            self.send_json(HTTPStatus.UNAUTHORIZED, {"error": "Unauthorized"})
            return

        with status_lock:
            if current_process and current_process.poll() is None:
                self.send_json(
                    HTTPStatus.CONFLICT,
                    {
                        "ok": False,
                        "status": "updating",
                        "message": "An update is already running.",
                    },
                )
                return

            update_status(
                status="updating",
                message="Synapsis update scheduled.",
                lastStartedAt=now_iso(),
                lastFinishedAt=None,
                lastExitCode=None,
                lastError=None,
                pid=None,
            )

            thread = threading.Thread(target=start_update_process, daemon=True)
            thread.start()

        self.send_json(
            HTTPStatus.ACCEPTED,
            {
                "ok": True,
                "status": "updating",
                "message": "Synapsis update scheduled. The node will restart shortly.",
            },
        )


def cleanup_socket(*_args):
    try:
        if os.path.exists(SOCKET_PATH):
            os.remove(SOCKET_PATH)
    finally:
        raise SystemExit(0)


def main():
    ensure_parent_dirs()

    if os.path.exists(SOCKET_PATH):
        os.remove(SOCKET_PATH)

    signal.signal(signal.SIGTERM, cleanup_socket)
    signal.signal(signal.SIGINT, cleanup_socket)

    update_status(available=True)

    with ThreadedUnixServer(SOCKET_PATH, Handler) as server:
        os.chmod(SOCKET_PATH, 0o666)
        server.serve_forever()


if __name__ == "__main__":
    main()
