#!/usr/bin/env python3
"""沐的微信 bridge。

复用 hermes 的 ilinkai 实现:
  收消息走低层模块函数(_get_updates 等);
  发消息委托 WeixinAdapter.send(分块/块间节奏/context_token 流/stale 降级/rate-limit
  重试全在它内部),不再自写发送循环。
两条链路:
  被动: long-poll ilinkai 收消息 → POST 沐的 webhook → 沐回复 → adapter.send 发回微信
  主动: 沐的 message_send → POST 本 bridge 的 /send → adapter.send 发给最近对话的哥哥

必须用 hermes 的 venv python 跑(自带 aiohttp + gateway 包)。
对标 vanilla Hermes 0.17 的发送链路(已实测 0.17 投递可靠,0.14 被 iLink 静默吞):
  /home/jump/hermes-vanilla/bin/python wechat_bridge.py [check]

凭据从环境变量读(见 config/wechat.env):
  WEIXIN_ACCOUNT_ID / WEIXIN_TOKEN / WEIXIN_BASE_URL (WEIXIN_CDN_BASE_URL 可选,发图用)
"""
import asyncio
import builtins as _builtins
import json
import os
import sys
import urllib.request
from datetime import datetime as _dt

from bridge_pure import is_authorized, ask_payload


def print(*args, **kw):  # noqa: A001 —— 全文件日志统一带时间戳(06-10 排查降级时无时间戳吃过亏)
    _builtins.print(f"[{_dt.now():%m-%d %H:%M:%S}]", *args, **kw)

HERMES_SP = os.environ.get(
    "HERMES_SITE_PACKAGES",
    "/home/jump/hermes-vanilla/lib/python3.12/site-packages",
)
if HERMES_SP not in sys.path:
    sys.path.insert(0, HERMES_SP)

import aiohttp  # noqa: E402
from aiohttp import web  # noqa: E402
from gateway.config import PlatformConfig  # noqa: E402
from gateway.platforms.weixin import (  # noqa: E402
    WeixinAdapter,
    _get_updates,
    _send_typing,
    _get_config,
    _extract_text,
    _make_ssl_connector,
    _load_sync_buf,
    _save_sync_buf,
    ContextTokenStore,
    ILINK_BASE_URL,
    LONG_POLL_TIMEOUT_MS,
    WEIXIN_CDN_BASE_URL,
    _LIVE_ADAPTERS,
)

# 每个 peer 的 typing_ticket 缓存(发"正在输入"用)
_typing_tickets: dict = {}

MU_WEBHOOK = os.environ.get("MU_WEBHOOK", "http://127.0.0.1:3210/webhook/message")
SEND_PORT = int(os.environ.get("MU_WECHAT_SEND_PORT", "3211"))
ACCOUNT_ID = os.environ.get("WEIXIN_ACCOUNT_ID", "").strip()
TOKEN = os.environ.get("WEIXIN_TOKEN", "").strip()
# 主人白名单:设了就只理这个 user_id,陌生人消息直接忽略(防隐私泄露+记忆污染)
MASTER_ID = os.environ.get("WEIXIN_MASTER_ID", "").strip()
ALLOW_UNSAFE = os.environ.get("ALLOW_UNAUTHENTICATED_BRIDGE", "").strip() == "1"
BASE_URL = os.environ.get("WEIXIN_BASE_URL", ILINK_BASE_URL).strip().rstrip("/")
HOME = os.environ.get("MU_WECHAT_HOME", "/home/jump/mu/data/wechat")

# 发送侧的分块/节奏/重试/stale 降级全部交给 WeixinAdapter.send 内部处理
# (它读 WEIXIN_SEND_CHUNK_* 等 env 自调),这里不再自写发送循环。
CDN_BASE_URL = os.environ.get("WEIXIN_CDN_BASE_URL", WEIXIN_CDN_BASE_URL).strip().rstrip("/")

os.makedirs(os.path.join(HOME, "weixin-accounts"), exist_ok=True)

# adapter 和 bridge 共用同一个 token_store —— inbound 存进来的 ctx,adapter.send 才取得到
_tokens = ContextTokenStore(HOME)
_tokens.restore(ACCOUNT_ID)

# 最近和沐说话的人,沐主动发消息时发给他。持久化,重启恢复。
_PEER_FILE = os.path.join(HOME, "last_peer.txt")
_send_session: "aiohttp.ClientSession | None" = None
# 进程级单例:整个进程复用一个 adapter + 一条持久 send_session(解决"连接非持久")
_adapter: "WeixinAdapter | None" = None


def _build_adapter(session: "aiohttp.ClientSession") -> "WeixinAdapter":
    """照 send_weixin_direct(weixin.py:2260)的模式裸实例化 WeixinAdapter。

    不走 adapter.connect() 的 long-poll 生命周期(收消息我们用低层 _get_updates),
    只借它成熟的 send():内部已做智能分块 + 块间节奏 + context_token 流 + stale 降级
    + rate-limit 重试。手动设好它发送所需的内部属性。
    """
    adapter = WeixinAdapter(
        PlatformConfig(
            enabled=True,
            token=TOKEN,
            extra={
                "account_id": ACCOUNT_ID,
                "base_url": BASE_URL,
                "cdn_base_url": CDN_BASE_URL,
            },
        )
    )
    adapter._send_session = session
    adapter._session = session
    adapter._token = TOKEN
    adapter._account_id = ACCOUNT_ID
    adapter._base_url = BASE_URL
    adapter._cdn_base_url = CDN_BASE_URL
    adapter._token_store = _tokens  # 和 bridge 共用,inbound 存的 ctx 这里取得到
    return adapter


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


# bridge 侧最小 outbox:发送 retry 仍失败时落盘,回复绝不静默蒸发。
# 不复用 mu 主链路的 data/memory/outbox.json(那个由 mu 进程独占读写,跨进程并发写有损坏风险)。
_OUTBOX_FILE = os.path.join(HOME, "outbox.json")


def _outbox_append(peer: str, text: str, error: str) -> None:
    try:
        items = []
        if os.path.exists(_OUTBOX_FILE):
            with open(_OUTBOX_FILE, encoding="utf-8") as f:
                items = json.load(f) or []
        items.append({"to": peer, "text": text, "error": error, "ts": _dt.now().isoformat()})
        items = items[-50:]  # 上限 50,丢最旧
        with open(_OUTBOX_FILE, "w", encoding="utf-8") as f:
            json.dump(items, f, ensure_ascii=False, indent=2)
    except Exception as exc:  # noqa: BLE001
        print(f"[wechat-bridge] outbox 落盘失败: {exc}", flush=True)


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


async def _send_text(peer: str, text: str):
    """发文本给 peer,委托 WeixinAdapter.send。

    adapter.send 内部已处理:智能分块 + 块间节奏 + 取/更新 context_token(从共用的
    _token_store)+ stale 降级 + rate-limit 重试。我们只负责 format + 判 success。
    返回 (success_bool, error_str)。
    """
    assert _adapter is not None
    cleaned = _adapter.format_message(text)
    if not cleaned:
        return False, "empty after format"  # 清成空串 ≠ 投递成功,别打 ✓
    result = await _adapter.send(peer, cleaned)
    if result is None:  # send 内部异常路径可能返回 None,别让 result.success 抛 AttributeError
        return False, "send returned None"
    return bool(result.success), result.error


async def _send_image(peer: str, path: str):
    """发图片给 peer,委托 WeixinAdapter.send_image_file。返回 (success_bool, error_str)。"""
    assert _adapter is not None
    result = await _adapter.send_image_file(peer, path)
    return bool(result.success), result.error


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
    if not is_authorized(sender, MASTER_ID, allow_unsafe=ALLOW_UNSAFE):
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
    # 发送委托 WeixinAdapter.send(分块/块间节奏/context_token 流/stale 降级/rate-limit
    # 重试全在它内部)。inbound 的 ctx 已存进共用 _token_store,adapter 自己取最新。
    # _handle 是 detached task(create_task),poll 循环的 except 捕不到这里的 raise,
    # 所以发送必须自己兜底:retry 一次 → 仍失败落 outbox,绝不让异常逃出、回复绝不静默蒸发。
    ok, err = False, None
    for attempt in (1, 2):
        try:
            ok, err = await _send_text(sender, reply)
            if ok:
                print(f"[wechat-bridge] 回复 {sender[:8]} 投递✓ ({len(reply)}字符)", flush=True)
                break
            print(f"[wechat-bridge] 回复 {sender[:8]} ⚠未投递(第{attempt}次): {err}", flush=True)
        except Exception as exc:  # noqa: BLE001
            ok, err = False, str(exc)
            print(f"[wechat-bridge] 回复 {sender[:8]} ⚠发送抛异常(第{attempt}次): {exc}", flush=True)
    if not ok:
        _outbox_append(sender, reply, str(err))
        print(f"[wechat-bridge] 回复 {sender[:8]} ⚠两次都没出去,已落 outbox: {err}", flush=True)


# 沐主动消息走这里:POST /send {text, image_path?} → 发给最近对话的哥哥
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
    image_path = str(data.get("image_path") or "").strip()
    try:
        ok, err = await _send_text(peer, text)
        if ok and image_path:
            img_ok, img_err = await _send_image(peer, image_path)
            ok, err = (ok and img_ok), (err or img_err)
        flag = "投递✓" if ok else f"⚠未投递: {err}"
        print(f"[wechat-bridge] 主动发给 {peer[:8]}: {text[:30]} {flag}", flush=True)
        return web.json_response({"ok": ok, "to": peer, "delivered": ok, "error": err})
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
    global _send_session, _adapter
    # 进程级持久 session:发送 + long-poll + typing 全复用这一条(解决"连接非持久")。
    # timeout=None 对标 WeixinAdapter.connect(weixin.py:1292):禁用 aiohttp 内置
    # ClientTimeout,超时由 _api_post/_api_get 内部的 asyncio.wait_for 单独管;否则
    # 35s long-poll 会撞上 aiohttp 默认 5min total 之外的 sock_read 限制。
    _no_timeout = aiohttp.ClientTimeout(total=None, connect=None, sock_connect=None, sock_read=None)
    _send_session = aiohttp.ClientSession(
        trust_env=True, connector=_make_ssl_connector(), timeout=_no_timeout,
    )
    _adapter = _build_adapter(_send_session)
    # 注册到 live adapter 表(对标 connect:1296):若进程内别处走 send_weixin_direct,
    # 它会复用我们这条持久 session + 共享 token_store,而非另开临时连接。
    if TOKEN:
        _LIVE_ADAPTERS[TOKEN] = _adapter

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
    fails = 0
    while True:
        try:
            resp = await _get_updates(_send_session, base_url=BASE_URL, token=TOKEN, sync_buf=sync_buf, timeout_ms=LONG_POLL_TIMEOUT_MS)
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
    if not MASTER_ID and not ALLOW_UNSAFE:
        print("[wechat-bridge] 缺 WEIXIN_MASTER_ID；默认拒绝无白名单启动。仅本地调试可设 ALLOW_UNAUTHENTICATED_BRIDGE=1", flush=True)
        sys.exit(1)
    if len(sys.argv) > 1 and sys.argv[1] == "check":
        ok = asyncio.run(_poll_once())
        print("[wechat-bridge] 连通性:", "OK" if ok else "失败", flush=True)
        sys.exit(0 if ok else 2)
    asyncio.run(_run())


if __name__ == "__main__":
    main()
