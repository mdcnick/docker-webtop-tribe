#!/usr/bin/env python3
"""
PTY Server — shared terminal for Hermes (exec API) and users (xterm.js WS).
Runs inside the webtop container as an s6 longrun service.

Endpoints:
  WS  /ws          — raw PTY I/O for xterm.js
  WS  /lock        — JSON lock-status broadcasts
  POST /exec       — Hermes injects commands (returns 423 if locked)
"""

import asyncio
import fcntl
import json
import os
import pty
import struct
import termios
import signal

import aiohttp
from aiohttp import web
import websockets

# ------------------------------------------------------------------ config
PTY_PORT = int(os.environ.get("PTY_PORT", "8081"))
PTY_CWD = os.environ.get("PTY_CWD", "/config/workspace")
PTY_SHELL = os.environ.get("PTY_SHELL", "/bin/bash")

# ------------------------------------------------------------------ globals
master_fd: int | None = None
clients: set[websockets.WebSocketServerProtocol] = set()
lock_clients: set[websockets.WebSocketServerProtocol] = set()
locked_by: str | None = None          # "hermes" | None

# ------------------------------------------------------------------ helpers

def set_window_size(rows: int = 24, cols: int = 80) -> None:
    if master_fd is None:
        return
    size = struct.pack("HHHH", rows, cols, 0, 0)
    fcntl.ioctl(master_fd, termios.TIOCSWINSZ, size)


def spawn_shell() -> int:
    global master_fd
    master_fd, slave_fd = pty.openpty()
    pid = os.fork()
    if pid == 0:
        # child
        os.setsid()
        os.dup2(slave_fd, 0)
        os.dup2(slave_fd, 1)
        os.dup2(slave_fd, 2)
        os.close(master_fd)
        if slave_fd > 2:
            os.close(slave_fd)
        os.environ["TERM"] = "xterm-256color"
        os.environ["HOME"] = "/config"
        os.chdir(PTY_CWD)
        os.execl(PTY_SHELL, PTY_SHELL, "-l")
    # parent
    os.close(slave_fd)
    fl = fcntl.fcntl(master_fd, fcntl.F_GETFL)
    fcntl.fcntl(master_fd, fcntl.F_SETFL, fl | os.O_NONBLOCK)
    set_window_size()
    return pid


async def broadcast(data: bytes) -> None:
    dead = []
    for ws in clients:
        try:
            await ws.send(data)
        except Exception:
            dead.append(ws)
    for ws in dead:
        clients.discard(ws)


async def broadcast_lock() -> None:
    msg = json.dumps({
        "type": "lock",
        "locked": locked_by is not None,
        "by": locked_by,
    })
    dead = []
    for ws in lock_clients:
        try:
            await ws.send(msg)
        except Exception:
            dead.append(ws)
    for ws in dead:
        lock_clients.discard(ws)


# crude prompt detector — unlock when we see a bash-looking prompt
PROMPT_RE = [b"$ ", b"# ", b"> ", b"% "]

def looks_like_prompt(data: bytes) -> bool:
    # only check the tail to avoid false positives in command output
    tail = data[-32:]
    for p in PROMPT_RE:
        if p in tail:
            return True
    return False


async def pty_reader() -> None:
    """Pump PTY output to WebSocket clients."""
    global locked_by
    while True:
        try:
            data = os.read(master_fd, 4096)
        except (OSError, BlockingIOError):
            await asyncio.sleep(0.01)
            continue
        if not data:
            break
        if locked_by == "hermes" and looks_like_prompt(data):
            locked_by = None
            await broadcast_lock()
        await broadcast(data)


# ------------------------------------------------------------------ websockets

async def ws_handler(websocket: websockets.WebSocketServerProtocol, path: str) -> None:
    global locked_by
    if path == "/ws":
        clients.add(websocket)
        try:
            async for message in websocket:
                if locked_by == "hermes":
                    continue
                if isinstance(message, str):
                    os.write(master_fd, message.encode("utf-8"))
                else:
                    os.write(master_fd, message)
        finally:
            clients.discard(websocket)

    elif path == "/lock":
        lock_clients.add(websocket)
        try:
            await websocket.send(json.dumps({
                "type": "lock",
                "locked": locked_by is not None,
                "by": locked_by,
            }))
            async for _ in websocket:
                pass
        finally:
            lock_clients.discard(websocket)


# ------------------------------------------------------------------ http

async def exec_handler(request: web.Request) -> web.Response:
    global locked_by
    if locked_by:
        return web.Response(status=423, text="Terminal is locked by another process")
    try:
        body = await request.json()
    except Exception:
        return web.Response(status=400, text="Invalid JSON")
    command = body.get("command", "")
    if not command:
        return web.Response(status=400, text="Missing 'command' field")
    locked_by = "hermes"
    await broadcast_lock()
    os.write(master_fd, (command + "\n").encode("utf-8"))
    return web.Response(text="ok")


async def resize_handler(request: web.Request) -> web.Response:
    try:
        body = await request.json()
        set_window_size(body.get("rows", 24), body.get("cols", 80))
    except Exception:
        pass
    return web.Response(text="ok")


# ------------------------------------------------------------------ main

async def main() -> None:
    global master_fd
    pid = spawn_shell()

    # restart shell if it dies
    asyncio.create_task(_reaper(pid))

    # start PTY reader
    asyncio.create_task(pty_reader())

    # HTTP server
    app = web.Application()
    app.router.add_post("/exec", exec_handler)
    app.router.add_post("/resize", resize_handler)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", PTY_PORT)
    await site.start()

    # WebSocket server (same port, different path — aiohttp doesn't do WS
    # as cleanly as websockets.py, so run it on PTY_PORT+1)
    ws_server = await websockets.serve(ws_handler, "0.0.0.0", PTY_PORT + 1)

    print(f"pty-server: HTTP on :{PTY_PORT}, WS on :{PTY_PORT + 1}", flush=True)
    await asyncio.Future()  # run forever


async def _reaper(pid: int) -> None:
    """Wait for shell to exit and restart it."""
    global master_fd, locked_by
    while True:
        try:
            _, status = os.waitpid(pid, 0)
        except ChildProcessError:
            break
        print(f"pty-server: shell exited ({status}), restarting…", flush=True)
        locked_by = None
        await broadcast_lock()
        if master_fd is not None:
            try:
                os.close(master_fd)
            except OSError:
                pass
        pid = spawn_shell()


if __name__ == "__main__":
    asyncio.run(main())
