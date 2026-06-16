#!/usr/bin/env python3
"""沐的微信 bridge。

复用 hermes 的 ilinkai 实现(gateway.platforms.weixin 的模块级函数),
不重写 2343 行的加密/反作弊/context_token 逻辑。两条链路:
  被动: long-poll ilinkai 收消息 → POST 沐的 webhook → 沐回复 → 发回微信
  主动: 沐的 message_send → POST 本 bridge 的 /send → 发给最近对话的哥哥

必须用 hermes 的 venv python 跑(自带 aiohttp + gateway 包):
  /home/xpark/ai/venvs/hermes/bin/python wechat_bridge.py [check]

凭据从环境变量读(见 config/wechat.env):
  WEIXIN_ACCOUNT_ID / WEIXIN_TOKEN / WEIXIN_BASE_URL
"""
import asyncio
import builtins as _builtins
import json
import os
import sys
import urllib.request
from datetime import datetime as _dt

from bridge_pure import is_authorized, ask_payload, is_delivered


def print(*args, **kw):  # noqa: A001 —— 全文件日志统一带时间戳(06-10 排查降级时无时间戳吃过亏)
    _builtins.print(f"[{_dt.now():%m-%d %H:%M:%S}]", *args, **kw)

HERMES_SP = os.environ.get(
    "HERMES_SITE_PACKAGES",
    "/home/xpark/ai/venvs/hermes/lib/python3.12/site-packages",
)
if HERMES_SP not in sys.path:
    sys.path.insert(0, HERMES_SP)

import aiohttp  # noqa: E402
from aiohttp import web  # noqa: E402
from gateway.platforms.weixin import (  # noqa: E402
    _get_updates,
    _send_message,
    _send_typing,
    _get_config,
    _extract_text,
    _make_ssl_connector,
    _load_sync_buf,
    _save_sync_buf,
    ContextTokenStore,
    ILINK_BASE_URL,
    LONG_POLL_TIMEOUT_MS,
)

# 每个 peer 的 typing_ticket 缓存(发"正在输入"用)
_typing_tickets: dict = {}

MU_WEBHOOK = os.environ.get("MU_WEBHOOK", "http://127.0.0.1:3210/webhook/message")
SEND_PORT = int(os.environ.get("MU_WECHAT_SEND_PORT", "3211"))
ACCOUNT_ID = os.environ.get("WEIXIN_ACCOUNT_ID", "").strip()
TOKEN = os.environ.get("WEIXIN_TOKEN", "").strip()
# 主人白名单:设了就只理这个 user_id,陌生人消息直接忽略(防隐私泄露+记忆污染)
MASTER_ID = os.environ.get("WEIXIN_MASTER_ID", "").strip()
BASE_URL = os.environ.get("WEIXIN_BASE_URL", ILINK_BASE_URL).strip().rstrip("/")
HOME = os.environ.get("MU_WECHAT_HOME", "/home/xpark/mu/data/wechat")

os.makedirs(os.path.join(HOME, "weixin-accounts"), exist_ok=True)

_tokens = ContextTokenStore(HOME)
_tokens.restore(ACCOUNT_ID)

# 最近和沐说话的人,沐主动发消息时发给他。持久化,重启恢复。
_PEER_FILE = os.path.join(HOME, "last_peer.txt")
_send_session: "aiohttp.ClientSession | None" = None


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


def _ask_mu(text: str, sender: str) -> str:
    body = json.dumps(ask_payload(text, sender, "wechat")).encode("utf-8")
    req = urllib.request.Request(MU_WEBHOOK, data=body, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return json.loads(resp.read().decode("utf-8")).get("response", "")
    except Exception as exc:  # noqa: BLE001
        print(f"[wechat-bridge] 问沐失败: {exc}", flush=True)
        return ""


async def _send_to(peer: str, text: str, context_token: "str | None" = None) -> dict:
    """发消息给 peer。必须带该 peer 最新的 context_token。

    关键(issue #35949 + 官方文档):缺 token 或 token stale 时,iLink 返回 HTTP 200
    但【静默丢弃】——不投递给用户、也不返回新 context_token。所以:
      - 不做 tokenless 重试(去掉 token 只会发进虚空,errcode 0 也收不到)
      - 投递成功的标志是【返回里带新 context_token】,不是 errcode==0
    """
    assert _send_session is not None
    ctx = context_token or _tokens.get(ACCOUNT_ID, peer) or None
    result = (await _send_message(
        _send_session, base_url=BASE_URL, token=TOKEN, to=peer, text=text,
        context_token=ctx, client_id=ACCOUNT_ID,
    )) or {}
    new_ctx = str(result.get("context_token") or "").strip()
    if new_ctx:
        _tokens.set(ACCOUNT_ID, peer, new_ctx)
    return result


async def _typing(peer: str, context_token: "str | None", status: int):
    """发"正在输入"。status=1 开始,0 停止。typing_ticket 没缓存就先从 getConfig 拿。"""
    assert _send_session is not None
    ticket = _typing_tickets.get(peer)
    if not ticket:
        try:
            cfg = await _get_config(
                _send_session, base_url=BASE_URL, token=TOKEN,
                user_id=peer, context_token=context_token,
            )
            ticket = str((cfg or {}).get("typing_ticket") or "")
            if ticket:
                _typing_tickets[peer] = ticket
        except Exception:
            return
    if not ticket:
        return
    try:
        await _send_typing(
            _send_session, base_url=BASE_URL, token=TOKEN,
            to_user_id=peer, typing_ticket=ticket, status=status,
        )
    except Exception:
        pass


async def _handle(msg):
    global _last_peer
    sender = str(msg.get("from_user_id") or "").strip()
    if not sender or sender == ACCOUNT_ID:
        return
    if not is_authorized(sender, MASTER_ID):
        print(f"[wechat-bridge] 忽略陌生人 {sender[:8]} 的消息", flush=True)
        return
    text = _extract_text(msg.get("item_list") or [])
    if not text:
        return

    # inbound 自带 fresh context_token —— 回复必须原样带上,否则被静默丢弃。
    # inbound 也是腾讯端最强的"账号活跃"信号,能解除反作弊降级。
    ctx = str(msg.get("context_token") or "").strip()
    if ctx:
        _tokens.set(ACCOUNT_ID, sender, ctx)
    # 记住这个人,沐主动找哥哥时发给他
    _last_peer = sender
    _save_peer(sender)

    print(f"[wechat-bridge] 收到 {sender[:8]}: {text[:40]} (ctx={'有' if ctx else '无'})", flush=True)

    # 处理期间低频发"正在输入"保活:每 18 秒一次,最多 6 次(≈108s,覆盖 GLM 慢思考)。
    # 频率是上次害事版(每 5 秒)的 1/3.6,且限次封顶,不会无限 probe。
    # getConfig 拿 ticket 只第一次(有缓存),后续只是 sendTyping。
    async def _typing_keepalive():
        try:
            for _ in range(6):
                await _typing(sender, ctx or None, 1)
                await asyncio.sleep(18)
        except asyncio.CancelledError:
            pass
    ka = asyncio.create_task(_typing_keepalive())
    try:
        reply = await asyncio.get_event_loop().run_in_executor(None, _ask_mu, text, sender)
    finally:
        ka.cancel()
        await _typing(sender, ctx or None, 0)  # 停"正在输入"
    if not reply:
        return
    # 微信侧不拆条,整条发。曾按空行拆最多 3 段(像真人连发)——06-10 03:49 上线,
    # 当天 03:13 后账号即被风控降级:typing 能过、正文全部静默扣下(errcode=0 且
    # 照常返新 token,协议层完全无感),9 小时+全部回复不可见。单条是降级前
    # 最后一条送达的形态。"真人感"不值得拿整个通道的可用性去换;
    # QQ 官方 bot 无此风控,拆条保留在 qq_bridge
    result = await _send_to(sender, reply, context_token=ctx or None)
    ec = result.get("errcode", 0)
    print(f"[wechat-bridge] 回复 {sender[:8]} errcode={ec}", flush=True)


# 沐主动消息走这里:POST /send {text} → 发给最近对话的哥哥
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
        result = await _send_to(peer, text)
        ec = result.get("errcode", 0)
        delivered = is_delivered(result)  # 返新 token 才算真投递
        flag = "投递✓" if delivered else "⚠未投递(主动推送遇 stale token,issue#35949 的硬限制)"
        print(f"[wechat-bridge] 主动发给 {peer[:8]}: {text[:30]} errcode={ec} {flag}", flush=True)
        return web.json_response({"ok": delivered, "to": peer, "errcode": ec, "delivered": delivered})
    except Exception as exc:  # noqa: BLE001
        return web.json_response({"error": str(exc)}, status=500)


async def _poll_once() -> bool:
    sync_buf = _load_sync_buf(HOME, ACCOUNT_ID)
    async with aiohttp.ClientSession(trust_env=True, connector=_make_ssl_connector()) as s:
        resp = await _get_updates(s, base_url=BASE_URL, token=TOKEN, sync_buf=sync_buf, timeout_ms=3000)
        ret, ec = resp.get("ret", 0), resp.get("errcode", 0)
        print(f"[wechat-bridge] check: ret={ret} errcode={ec} 待处理={len(resp.get('msgs') or [])}", flush=True)
        return ret in (0, None) and ec in (0, None)


async def _run():
    global _send_session
    _send_session = aiohttp.ClientSession(trust_env=True, connector=_make_ssl_connector())

    # 主动发送的 HTTP server
    app = web.Application()
    app.router.add_post("/send", _http_send)
    app.router.add_get("/health", lambda r: web.json_response({"ok": True, "last_peer": _last_peer}))
    runner = web.AppRunner(app)
    await runner.setup()
    await web.TCPSite(runner, "127.0.0.1", SEND_PORT).start()
    print(f"[wechat-bridge] 主动发送接口: http://127.0.0.1:{SEND_PORT}/send", flush=True)

    sync_buf = _load_sync_buf(HOME, ACCOUNT_ID)
    print(f"[wechat-bridge] 启动 long-poll, account={ACCOUNT_ID[:8]} last_peer={(_last_peer or '无')[:8]}", flush=True)
    async with aiohttp.ClientSession(trust_env=True, connector=_make_ssl_connector()) as poll_s:
        fails = 0
        while True:
            try:
                resp = await _get_updates(poll_s, base_url=BASE_URL, token=TOKEN, sync_buf=sync_buf, timeout_ms=LONG_POLL_TIMEOUT_MS)
                ret, ec = resp.get("ret", 0), resp.get("errcode", 0)
                if ret not in (0, None) or ec not in (0, None):
                    fails += 1
                    print(f"[wechat-bridge] poll err ret={ret} errcode={ec} ({fails})", flush=True)
                    await asyncio.sleep(10 if fails >= 3 else 3)
                    continue
                fails = 0
                nb = str(resp.get("get_updates_buf") or "")
                if nb:
                    sync_buf = nb
                    _save_sync_buf(HOME, ACCOUNT_ID, sync_buf)
                for m in resp.get("msgs") or []:
                    asyncio.create_task(_handle(m))
            except asyncio.CancelledError:
                break
            except Exception as exc:  # noqa: BLE001
                fails += 1
                print(f"[wechat-bridge] 循环异常 ({fails}): {exc}", flush=True)
                await asyncio.sleep(10 if fails >= 3 else 3)


def main():
    if not ACCOUNT_ID or not TOKEN:
        print("[wechat-bridge] 缺 WEIXIN_ACCOUNT_ID / WEIXIN_TOKEN", flush=True)
        sys.exit(1)
    if len(sys.argv) > 1 and sys.argv[1] == "check":
        ok = asyncio.run(_poll_once())
        print("[wechat-bridge] 连通性:", "OK" if ok else "失败", flush=True)
        sys.exit(0 if ok else 2)
    asyncio.run(_run())


if __name__ == "__main__":
    main()
