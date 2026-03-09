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
CONFIG_FILE = os.environ.get("HOST_UPDATER_CONFIG_FILE", "/opt/synapsis/updater-config.json")
LOG_FILE = os.environ.get("HOST_UPDATER_LOG_FILE", "/opt/synapsis/updater.log")
UPDATE_SCRIPT = os.environ.get("HOST_UPDATER_SCRIPT", "/opt/synapsis/update-local.sh")
INSTALL_DIR = os.environ.get("INSTALL_DIR", "/opt/synapsis")
AUTO_UPDATE_INTERVAL_MINUTES = max(5, int(os.environ.get("HOST_UPDATER_INTERVAL_MINUTES", "30")))

status_lock = threading.RLock()
current_process = None
last_auto_trigger_at = 0.0


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def ensure_parent_dirs():
    os.makedirs(os.path.dirname(SOCKET_PATH), exist_ok=True)
    os.makedirs(os.path.dirname(STATUS_FILE), exist_ok=True)
    os.makedirs(os.path.dirname(CONFIG_FILE), exist_ok=True)
    os.makedirs(os.path.dirname(LOG_FILE), exist_ok=True)


def default_config():
    return {
        "autoUpdateEnabled": True,
        "intervalMinutes": AUTO_UPDATE_INTERVAL_MINUTES,
    }


def load_config():
    if not os.path.exists(CONFIG_FILE):
        config = default_config()
        save_config(config)
        return config

    with open(CONFIG_FILE, "r", encoding="utf-8") as handle:
        stored = json.load(handle)

    config = default_config()
    config.update({
        "autoUpdateEnabled": bool(stored.get("autoUpdateEnabled", True)),
        "intervalMinutes": max(5, int(stored.get("intervalMinutes", AUTO_UPDATE_INTERVAL_MINUTES))),
    })
    return config


def save_config(config):
    with open(CONFIG_FILE, "w", encoding="utf-8") as handle:
        json.dump(config, handle, indent=2)


def update_config(**changes):
    config = load_config()
    config.update(changes)
    config["autoUpdateEnabled"] = bool(config.get("autoUpdateEnabled", True))
    config["intervalMinutes"] = max(5, int(config.get("intervalMinutes", AUTO_UPDATE_INTERVAL_MINUTES)))
    save_config(config)
    return config


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


def normalize_status_on_startup():
    status = load_status()

    if status.get("status") == "error" and status.get("lastExitCode") == -15:
        status.update({
            "status": "success",
            "message": "Synapsis update completed.",
            "lastExitCode": 0,
            "lastError": None,
            "pid": None,
        })
        save_status(status)

    if status.get("status") == "updating":
        status.update({
            "status": "idle",
            "message": "Ready to update.",
            "lastError": None,
            "pid": None,
        })
        save_status(status)


def save_status(status):
    with open(STATUS_FILE, "w", encoding="utf-8") as handle:
        json.dump(status, handle, indent=2)


def update_status(**changes):
    with status_lock:
        status = load_status()
        status.update(changes)
        save_status(status)
        return status


def get_status_payload():
    status = load_status()
    status["config"] = load_config()
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


def start_update_process(trigger="manual"):
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

        update_status(pid=current_process.pid, trigger=trigger)

    thread = threading.Thread(target=watch_process, args=(current_process,), daemon=True)
    thread.start()


def schedule_update(trigger="manual"):
    with status_lock:
        if current_process and current_process.poll() is None:
            return False

        update_status(
            status="updating",
            message="Synapsis update scheduled." if trigger == "manual" else "Automatic Synapsis update scheduled.",
            lastStartedAt=now_iso(),
            lastFinishedAt=None,
            lastExitCode=None,
            lastError=None,
            pid=None,
            trigger=trigger,
        )

        thread = threading.Thread(target=start_update_process, args=(trigger,), daemon=True)
        thread.start()
        return True


def auto_update_loop():
    global last_auto_trigger_at
    while True:
        time.sleep(60)
        try:
            config = load_config()
            if not config.get("autoUpdateEnabled", True):
                continue

            interval_seconds = max(300, int(config.get("intervalMinutes", AUTO_UPDATE_INTERVAL_MINUTES)) * 60)
            now = time.time()

            with status_lock:
                if current_process and current_process.poll() is None:
                    continue

                last_reference = last_auto_trigger_at
                status = load_status()
                if not last_reference:
                    last_started = status.get("lastStartedAt")
                    if last_started:
                        try:
                            last_reference = datetime.fromisoformat(last_started).timestamp()
                        except Exception:
                            last_reference = 0.0

                if last_reference and (now - last_reference) < interval_seconds:
                    continue

                last_auto_trigger_at = now

            schedule_update(trigger="auto")
        except Exception as error:
            update_status(lastError=f"Auto-update scheduler error: {error}")


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
            self.send_json(HTTPStatus.OK, get_status_payload())
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

        if not schedule_update(trigger="manual"):
            self.send_json(
                HTTPStatus.CONFLICT,
                {
                    "ok": False,
                    "status": "updating",
                    "message": "An update is already running.",
                },
            )
            return

        self.send_json(
            HTTPStatus.ACCEPTED,
            {
                "ok": True,
                "status": "updating",
                "message": "Synapsis update scheduled. The node will restart shortly.",
            },
        )

    def do_PATCH(self):
        if self.path != "/config":
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "Not found"})
            return

        if not is_authorized(self.headers):
            self.send_json(HTTPStatus.UNAUTHORIZED, {"error": "Unauthorized"})
            return

        content_length = int(self.headers.get("Content-Length", "0") or "0")
        raw_body = self.rfile.read(content_length) if content_length > 0 else b"{}"

        try:
            payload = json.loads(raw_body.decode("utf-8") or "{}")
        except json.JSONDecodeError:
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": "Invalid JSON"})
            return

        if "autoUpdateEnabled" not in payload:
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": "autoUpdateEnabled is required"})
            return

        config = update_config(autoUpdateEnabled=payload.get("autoUpdateEnabled"))
        self.send_json(HTTPStatus.OK, {"ok": True, "config": config})


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

    normalize_status_on_startup()
    load_config()

    signal.signal(signal.SIGTERM, cleanup_socket)
    signal.signal(signal.SIGINT, cleanup_socket)

    update_status(available=True)
    threading.Thread(target=auto_update_loop, daemon=True).start()

    with ThreadedUnixServer(SOCKET_PATH, Handler) as server:
        os.chmod(SOCKET_PATH, 0o666)
        server.serve_forever()


if __name__ == "__main__":
    main()
