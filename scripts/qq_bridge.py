#!/usr/bin/env python3
"""沐的 QQ bridge —— 沐的【主渠道】。

QQ 官方机器人(api.sgroup.qq.com):WebSocket 网关收消息 + REST 发消息。
和微信 iLink 不同,QQ 官方 bot 的 C2C 主动私信【原生支持】(发送时不带 msg_id
即主动消息),所以沐"主动找哥哥"在 QQ 上是通的 —— 这是 QQ 当主渠道的原因。

两条链路(和 wechat_bridge 一个模式):
  被动: ws 收 C2C_MESSAGE_CREATE → POST 沐 webhook → 沐回复 → 带 msg_id 回(被动,免费)
  主动: 沐 message_send → POST 本 bridge /send → 不带 msg_id 发(主动消息)

用 hermes 的 venv 跑(自带 aiohttp):
  /home/xpark/ai/venvs/hermes/bin/python qq_bridge.py

凭据从环境变量读(见 config/qq.env):
  QQ_APP_ID / QQ_CLIENT_SECRET
"""
import asyncio
import json
import os
import sys
import time
import uuid
import urllib.request
from collections import deque

HERMES_SP = os.environ.get(
    "HERMES_SITE_PACKAGES",
    "/home/xpark/ai/venvs/hermes/lib/python3.12/site-packages",
)
if HERMES_SP not in sys.path:
    sys.path.insert(0, HERMES_SP)

import aiohttp  # noqa: E402
from aiohttp import web  # noqa: E402

APP_ID = os.environ.get("QQ_APP_ID", "").strip()
CLIENT_SECRET = os.environ.get("QQ_CLIENT_SECRET", "").strip()
MU_WEBHOOK = os.environ.get("MU_WEBHOOK", "http://127.0.0.1:3210/webhook/message")
SEND_PORT = int(os.environ.get("MU_QQ_SEND_PORT", "3212"))
HOME = os.environ.get("MU_QQ_HOME", "/home/xpark/mu/data/qq")

TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken"
API_BASE = "https://api.sgroup.qq.com"
INTENTS = (1 << 25)  # GROUP_AND_C2C_EVENT —— 含 C2C_MESSAGE_CREATE(私信),沐只要这个
MAX_LEN = 4000

os.makedirs(HOME, exist_ok=True)
_PEER_FILE = os.path.join(HOME, "last_peer.txt")

# access_token 缓存(QQ token 2 小时过期,提前 60s 刷新)
_token: "str | None" = None
_token_exp = 0.0
_token_lock: "asyncio.Lock | None" = None

_session: "aiohttp.ClientSession | None" = None
_ws = None
_last_seq = None
_heartbeat_interval = 30.0
_running = True
_seen_msgids: set = set()           # 收消息去重(QQ 会重推)
_seen_order: deque = deque()        # 去重集合的插入顺序，满 1000 时 FIFO 淘汰最老一条


def _load_peer() -> "str | None":
    try:
        return open(_PEER_FILE, encoding="utf-8").read().strip() or None
    except Exception:
        return None


def _save_peer(p: str) -> None:
    try:
        open(_PEER_FILE, "w", encoding="utf-8").write(p)
    except Exception:
        pass


_last_peer = _load_peer()


async def _ensure_token() -> str:
    """拿有效 access_token,过期就刷新(singleflight 防并发重复刷)。"""
    global _token, _token_exp
    if _token and time.time() < _token_exp - 60:
        return _token
    async with _token_lock:
        if _token and time.time() < _token_exp - 60:
            return _token
        assert _session is not None
        async with _session.post(TOKEN_URL, json={"appId": APP_ID, "clientSecret": CLIENT_SECRET}) as r:
            data = await r.json()
        tok = data.get("access_token")
        if not tok:
            raise RuntimeError(f"拿 QQ token 失败: {data}")
        _token = tok
        _token_exp = time.time() + int(data.get("expires_in", 7200))
        print(f"[qq-bridge] token 刷新,{int(data.get('expires_in', 7200))}s 后过期", flush=True)
        return _token


async def _api(method: str, path: str, body=None) -> dict:
    """带鉴权调 QQ REST API。"""
    assert _session is not None
    tok = await _ensure_token()
    headers = {"Authorization": f"QQBot {tok}", "Content-Type": "application/json"}
    async with _session.request(method, f"{API_BASE}{path}", headers=headers, json=body) as r:
        data = await r.json()
        if r.status >= 400:
            raise RuntimeError(f"QQ API {r.status} {path}: {data.get('message', data)}")
        return data


def _msg_seq() -> int:
    return (int(time.time()) ^ int(uuid.uuid4().hex[:4], 16)) % 65536


async def _send_c2c(openid: str, text: str, reply_to: "str | None" = None) -> dict:
    """发私信。reply_to(收到的 msg_id)带上 = 被动回复(5 分钟内免费);不带 = 主动消息。"""
    body = {"content": text[:MAX_LEN], "msg_type": 0, "msg_seq": _msg_seq()}
    if reply_to:
        body["msg_id"] = reply_to
    return await _api("POST", f"/v2/users/{openid}/messages", body)


def _ask_mu(text: str, sender: str) -> str:
    body = json.dumps(
        {"text": text, "sender_name": "哥哥", "sender_id": sender, "source": "qq"}
    ).encode("utf-8")
    req = urllib.request.Request(MU_WEBHOOK, data=body, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return json.loads(resp.read().decode("utf-8")).get("response", "")
    except Exception as exc:  # noqa: BLE001
        print(f"[qq-bridge] 问沐失败: {exc}", flush=True)
        return ""


def _is_dup(msg_id: str) -> bool:
    if not msg_id or msg_id in _seen_msgids:
        return True
    _seen_msgids.add(msg_id)
    _seen_order.append(msg_id)
    # 满 1000 时只淘汰最老一条(FIFO)；整体 clear 会让 QQ 重推的旧 msg_id 被当新消息重复处理
    if len(_seen_order) > 1000:
        _seen_msgids.discard(_seen_order.popleft())
    return False


async def _handle_c2c(d: dict):
    global _last_peer
    openid = str((d.get("author") or {}).get("user_openid") or "").strip()
    content = str(d.get("content") or "").strip()
    msg_id = str(d.get("id") or "").strip()
    if not openid or not content:
        return
    _last_peer = openid
    _save_peer(openid)
    print(f"[qq-bridge] 收到 {openid[:8]}: {content[:40]}", flush=True)

    reply = await asyncio.get_event_loop().run_in_executor(None, _ask_mu, content, openid)
    if not reply:
        return
    try:
        await _send_c2c(openid, reply, reply_to=msg_id)  # 被动回复带 msg_id
        print(f"[qq-bridge] 回复 {openid[:8]}", flush=True)
    except Exception as exc:  # noqa: BLE001
        print(f"[qq-bridge] 回复失败: {exc}", flush=True)


async def _send_identify():
    assert _ws is not None
    tok = await _ensure_token()
    await _ws.send_json({
        "op": 2,
        "d": {
            "token": f"QQBot {tok}",
            "intents": INTENTS,
            "shard": [0, 1],
            "properties": {"$os": "linux", "$browser": "mu", "$device": "mu"},
        },
    })
    print("[qq-bridge] identify 已发", flush=True)


async def _dispatch(payload: dict):
    global _last_seq, _heartbeat_interval
    op = payload.get("op")
    if payload.get("s") is not None:
        _last_seq = payload.get("s")
    if op == 10:  # Hello —— 拿到心跳间隔,回 identify
        iv = (payload.get("d") or {}).get("heartbeat_interval", 30000)
        _heartbeat_interval = iv / 1000.0 * 0.8
        await _send_identify()
    elif op == 0:  # Dispatch
        t = payload.get("t")
        d = payload.get("d") or {}
        if t == "C2C_MESSAGE_CREATE":
            if not _is_dup(str(d.get("id") or "")):
                asyncio.create_task(_handle_c2c(d))
        elif t == "READY":
            print("[qq-bridge] READY —— QQ 已连上 ✓", flush=True)
    elif op in (7, 9):  # reconnect / invalid session —— 关连接触发重连+重新 identify
        print(f"[qq-bridge] op={op}(需重连)", flush=True)
        if _ws and not _ws.closed:
            await _ws.close()


async def _heartbeat():
    while _running:
        await asyncio.sleep(_heartbeat_interval)
        try:
            if _ws and not _ws.closed:
                await _ws.send_json({"op": 1, "d": _last_seq})
        except Exception:
            pass


async def _gateway_url() -> str:
    data = await _api("GET", "/gateway")
    url = data.get("url")
    if not url:
        raise RuntimeError(f"拿 gateway 失败: {data}")
    return url


async def _ws_loop():
    global _ws
    backoff = 1
    while _running:
        try:
            url = await _gateway_url()
            print(f"[qq-bridge] 连 gateway {url}", flush=True)
            async with _session.ws_connect(url, heartbeat=None) as ws:
                _ws = ws
                hb = asyncio.create_task(_heartbeat())   # 手动发 op1 心跳
                try:
                    async for msg in ws:
                        if msg.type == aiohttp.WSMsgType.TEXT:
                            await _dispatch(json.loads(msg.data))
                        elif msg.type in (aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR):
                            break
                finally:
                    hb.cancel()
            backoff = 1
        except Exception as exc:  # noqa: BLE001
            print(f"[qq-bridge] ws 异常: {exc} —— {backoff}s 后重连", flush=True)
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30)


# 沐主动消息:POST /send {text} → 主动发给最近对话的哥哥(不带 msg_id)
async def _http_send(request: "web.Request") -> "web.Response":
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "bad json"}, status=400)
    text = str(data.get("text") or "").strip()
    if not text:
        return web.json_response({"error": "empty"}, status=400)
    peer = str(data.get("to") or "").strip() or _last_peer
    if not peer:
        return web.json_response({"error": "还没有人和沐说过话,不知道发给谁"}, status=409)
    try:
        await _send_c2c(peer, text, reply_to=None)  # 主动消息,不带 msg_id
        print(f"[qq-bridge] 主动发给 {peer[:8]}: {text[:30]}", flush=True)
        return web.json_response({"ok": True, "to": peer})
    except Exception as exc:  # noqa: BLE001
        print(f"[qq-bridge] 主动发送失败: {exc}", flush=True)
        return web.json_response({"error": str(exc)}, status=500)


async def _run():
    global _session, _token_lock
    _token_lock = asyncio.Lock()
    _session = aiohttp.ClientSession(trust_env=True)

    app = web.Application()
    app.router.add_post("/send", _http_send)
    app.router.add_get("/health", lambda r: web.json_response(
        {"ok": True, "last_peer": _last_peer, "connected": bool(_ws and not _ws.closed)}))
    runner = web.AppRunner(app)
    await runner.setup()
    await web.TCPSite(runner, "127.0.0.1", SEND_PORT).start()
    print(f"[qq-bridge] 主动发送接口 http://127.0.0.1:{SEND_PORT}/send", flush=True)
    print(f"[qq-bridge] 启动,app_id={APP_ID} last_peer={(_last_peer or '无')[:8]}", flush=True)

    await _ws_loop()


def main():
    if not APP_ID or not CLIENT_SECRET:
        print("[qq-bridge] 缺 QQ_APP_ID / QQ_CLIENT_SECRET", flush=True)
        sys.exit(1)
    asyncio.run(_run())


if __name__ == "__main__":
    main()
