#!/usr/bin/env python3
"""沐的 QQ bridge —— 沐的【主渠道】。

QQ 官方机器人(api.sgroup.qq.com):WebSocket 网关收消息 + REST 发消息。
和微信 iLink 不同,QQ 官方 bot 的 C2C 主动私信【原生支持】(发送时不带 msg_id
即主动消息),所以沐"主动找哥哥"在 QQ 上是通的 —— 这是 QQ 当主渠道的原因。

两条链路(和 wechat_bridge 一个模式):
  被动: ws 收 C2C_MESSAGE_CREATE → POST 沐 webhook → 沐回复 → 带 msg_id 回(被动,免费)
  主动: 沐 message_send → POST 本 bridge /send → 不带 msg_id 发(主动消息)

用 hermes 的 venv 跑(自带 aiohttp),路径见 start-qq.sh(可移植,不硬编码 /home/xxx):
  /home/jump/hermes-vanilla/bin/python qq_bridge.py

凭据从环境变量读(见 config/qq.env):
  QQ_APP_ID / QQ_CLIENT_SECRET
"""
import asyncio
import builtins as _builtins
import json
import os
import sys
import time
import uuid
import urllib.request
from datetime import datetime as _dt

from bridge_pure import (
    split_reply_chunks, is_authorized, extract_image_urls, ask_payload, build_c2c_body, Dedup,
)


def print(*args, **kw):  # noqa: A001 —— 全文件日志统一带时间戳(06-10 排查回复蒸发时无时间戳吃过亏)
    _builtins.print(f"[{_dt.now():%m-%d %H:%M:%S}]", *args, **kw)

# 仓库根 = 本文件上两级(scripts/ 的父)。派生路径可移植,不硬编码 /home/xxx。
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

HERMES_SP = os.environ.get(
    "HERMES_SITE_PACKAGES",
    "/home/jump/hermes-vanilla/lib/python3.12/site-packages",  # 对齐 wechat_bridge;可用 env 覆盖
)
if HERMES_SP not in sys.path:
    sys.path.insert(0, HERMES_SP)

import aiohttp  # noqa: E402
from aiohttp import web  # noqa: E402

APP_ID = os.environ.get("QQ_APP_ID", "").strip()
CLIENT_SECRET = os.environ.get("QQ_CLIENT_SECRET", "").strip()
# 主人白名单:设了就只理这个 openid(否则任何加了 bot 的陌生人都会被当成"哥哥",
# 既泄露隐私又污染沐的记忆)。不设保持旧行为。
MASTER_OPENID = os.environ.get("QQ_MASTER_OPENID", "").strip()
ALLOW_UNSAFE = os.environ.get("ALLOW_UNAUTHENTICATED_BRIDGE", "").strip() == "1"
MU_WEBHOOK = os.environ.get("MU_WEBHOOK", "http://127.0.0.1:3210/webhook/message")
SEND_PORT = int(os.environ.get("MU_QQ_SEND_PORT", "3212"))
# 默认从仓库根派生(旧版硬编码 /home/xpark/mu/data/qq,迁到 /home/jump 后 makedirs 会崩)
HOME = os.environ.get("MU_QQ_HOME", os.path.join(_REPO_ROOT, "data", "qq"))
# mmx(视觉描述)二进制路径,可 env 覆盖;旧版硬编码 /home/xpark/.npm-global
MMX_BIN = os.environ.get("MMX_BIN", "/home/jump/.npm-global/bin/mmx")

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
_dedup = Dedup(1000)                # 收消息去重(QQ 会重推),FIFO 满 1000 淘汰最老


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


async def _send_c2c(openid: str, text: str, reply_to: "str | None" = None, seq: "int | None" = None) -> dict:
    """发私信。reply_to(收到的 msg_id)带上 = 被动回复(5 分钟内免费);不带 = 主动消息。
    seq: 同一 msg_id 被动回复多条时用 1-5 区分(QQ 上限 5 条)。"""
    # build_c2c_body 会静默截到 MAX_LEN(QQ 拒收过长)。截断本身避不开(硬上限),但必须留痕——
    # 静默丢尾正是微信那次 9 小时静默降级的失败形态(errcode=0 却丢数据)。这里让它可被日志发现。
    if len(text) > MAX_LEN:
        print(f"[qq-bridge] ⚠️ 单条超 {MAX_LEN} 字,尾部 {len(text) - MAX_LEN} 字被截断", flush=True)
    body = build_c2c_body(text, seq if seq else _msg_seq(), reply_to=reply_to, max_len=MAX_LEN)
    return await _api("POST", f"/v2/users/{openid}/messages", body)


async def _send_c2c_image(openid: str, image_path: str, reply_to: "str | None" = None, seq: int = 1) -> dict:
    """发图片。本地文件 → base64 直传 files 接口拿 file_info → 富媒体消息(msg_type=7)。
    沐送画/发截图给哥哥就走这条。"""
    import base64
    with open(image_path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode()
    up = await _api("POST", f"/v2/users/{openid}/files", {
        "file_type": 1,  # 1=图片
        "srv_send_msg": False,
        "file_data": b64,
    })
    file_info = up.get("file_info")
    if not file_info:
        raise RuntimeError(f"图片上传失败: {up}")
    body = {"content": " ", "msg_type": 7, "media": {"file_info": file_info}, "msg_seq": seq if reply_to else _msg_seq()}
    if reply_to:
        body["msg_id"] = reply_to
    return await _api("POST", f"/v2/users/{openid}/messages", body)


async def _send_reply_chunks(openid: str, reply: str, msg_id: str) -> None:
    """按空行把回复拆成多条发(她的风格本来就是一个想法一条),像真人连发。
    拆条规则(含 ≤1/超 5 合并)见 bridge_pure.split_reply_chunks。"""
    chunks = split_reply_chunks(reply)
    for j, ch in enumerate(chunks):
        try:
            await _send_c2c(openid, ch, reply_to=msg_id, seq=j + 1)
        except Exception as exc:  # noqa: BLE001
            # 被动窗口可能已过期(图片描述耗时可把处理时间推过 QQ 的 5 分钟免费回复窗)。
            # 降级为主动消息补发【这一条】:前面已发的 chunk 不受影响,后面的也不会因这条失败被整段丢掉。
            # 已知窄窗口:若这条其实已投递成功、只是 _api 解析响应时抛错,补发会让这条重复。
            # 取舍上"重复一条" 好过 "整条回复静默消失"(后者是这仓库最痛的已读不回),故接受。
            print(f"[qq-bridge] 被动回复第{j+1}条失败({exc}),转主动补发", flush=True)
            await _send_c2c(openid, ch, reply_to=None)
        if j < len(chunks) - 1:
            await asyncio.sleep(1.2)


def _describe_image(url: str) -> str:
    """下载图片,用 minimax 视觉描述成文字给沐(她"看"图的眼睛,和手机.sh 同款)。"""
    import subprocess, tempfile
    try:
        with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as f:
            path = f.name
        # urlretrieve 无超时:CDN 卡住会把 executor 线程占死,几张图连发能拖垮整个 bridge。
        # 换 urlopen(timeout) + 限 10MB 读:时间和内存都有界。
        with urllib.request.urlopen(url, timeout=20) as r:
            data = r.read(10 * 1024 * 1024)
        with open(path, "wb") as out_f:
            out_f.write(data)
        out = subprocess.run(
            [MMX_BIN, "vision", "describe", "--image", path,
             "--prompt", "描述这张图片。如果是食物:有什么菜、大概的量、主要营养构成。"
                         "如果是截图:界面内容和上面的文字。其他:你看到了什么。简洁中文,别用markdown。",
             "--quiet"],
            capture_output=True, text=True, timeout=60,
        )
        desc = (out.stdout or "").strip()
        return desc[:800] if desc else "(图片看不清)"
    except Exception as exc:  # noqa: BLE001
        return f"(图片没看成: {exc})"


def _ask_mu(text: str, sender: str) -> str:
    body = json.dumps(ask_payload(text, sender, "qq")).encode("utf-8")
    req = urllib.request.Request(MU_WEBHOOK, data=body, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return json.loads(resp.read().decode("utf-8")).get("response", "")
    except Exception as exc:  # noqa: BLE001
        print(f"[qq-bridge] 问沐失败: {exc}", flush=True)
        return ""


async def _handle_c2c(d: dict):
    global _last_peer
    openid = str((d.get("author") or {}).get("user_openid") or "").strip()
    content = str(d.get("content") or "").strip()
    msg_id = str(d.get("id") or "").strip()
    # 图片消息:content 可能为空但 attachments 有图,转成文字描述给沐(她的眼睛)
    img_urls = extract_image_urls(d.get("attachments"))
    if not openid or (not content and not img_urls):
        return
    if not is_authorized(openid, MASTER_OPENID, allow_unsafe=ALLOW_UNSAFE):
        print(f"[qq-bridge] 忽略陌生人 {openid[:8]} 的消息", flush=True)
        return
    _last_peer = openid
    _save_peer(openid)

    if img_urls:
        loop = asyncio.get_event_loop()
        descs = []
        for u in img_urls[:3]:
            descs.append(await loop.run_in_executor(None, _describe_image, u))
        img_text = "\n".join(f"[哥哥发来一张图片,你看到的是: {dsc}]" for dsc in descs)
        content = f"{img_text}\n{content}".strip() if content else img_text
    print(f"[qq-bridge] 收到 {openid[:8]}: {content[:40]}", flush=True)

    reply = await asyncio.get_event_loop().run_in_executor(None, _ask_mu, content, openid)
    if not reply:
        # 空回复也要留痕:10:54 一次"已读不回"事故里,这个静默 return 是三层静默的最后一层,
        # 日志全程无迹可寻。空回复有两种:mu 超时窗口已关(她稍后主动补发)或正文蒸发(mu 侧已修)
        print(f"[qq-bridge] 沐没回话(空response),不发 {openid[:8]}", flush=True)
        return
    try:
        await _send_reply_chunks(openid, reply, msg_id)  # 被动回复,按段拆多条
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
            if not _dedup.is_dup(str(d.get("id") or "")):
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


# 沐主动消息:POST /send {text?, image?} → 主动发给最近对话的哥哥(不带 msg_id)
# image 是本地图片路径(mu 和 bridge 同机),有 image 先发图再发文字
def _to_silk(audio_path: str) -> str:
    """任意音频(mp3/wav)→ QQ 认的 silk。ffmpeg 转 24k 单声道 pcm,pilk 加 tencent 头。
    同步阻塞(几百 ms 量级),调用方放 executor。"""
    import subprocess
    import pilk
    base = audio_path.rsplit(".", 1)[0]
    pcm, silk = f"{base}.pcm", f"{base}.silk"
    subprocess.run(
        ["ffmpeg", "-y", "-i", audio_path, "-f", "s16le", "-ar", "24000", "-ac", "1", pcm],
        capture_output=True, check=True,
    )
    pilk.encode(pcm, silk, pcm_rate=24000, tencent=True)
    os.unlink(pcm)
    return silk


async def _send_c2c_voice(openid: str, audio_path: str, reply_to: "str | None" = None, seq: int = 1) -> dict:
    """发语音。silk 之外的格式先转;base64 直传 files(file_type=3)再发富媒体(msg_type=7)。
    沐的声音(voice_send 工具)走这条。"""
    import base64
    converted = not audio_path.endswith(".silk")
    silk_path = audio_path if not converted else \
        await asyncio.get_event_loop().run_in_executor(None, _to_silk, audio_path)
    try:
        with open(silk_path, "rb") as f:
            b64 = base64.b64encode(f.read()).decode()
        up = await _api("POST", f"/v2/users/{openid}/files", {
            "file_type": 3,  # 3=语音
            "srv_send_msg": False,
            "file_data": b64,
        })
        file_info = up.get("file_info")
        if not file_info:
            raise RuntimeError(f"语音上传失败: {up}")
        body = {"content": " ", "msg_type": 7, "media": {"file_info": file_info}, "msg_seq": seq if reply_to else _msg_seq()}
        if reply_to:
            body["msg_id"] = reply_to
        return await _api("POST", f"/v2/users/{openid}/messages", body)
    finally:
        # 转换产生的 .silk 用完即删(源音频由调用方 voice_send 清);不删会在 /tmp 无限堆积
        if converted:
            try:
                os.unlink(silk_path)
            except OSError:
                pass


async def _http_send(request: "web.Request") -> "web.Response":
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "bad json"}, status=400)
    text = str(data.get("text") or "").strip()
    image = str(data.get("image") or "").strip()
    voice = str(data.get("voice") or "").strip()
    if not text and not image and not voice:
        return web.json_response({"error": "empty"}, status=400)
    peer = str(data.get("to") or "").strip() or _last_peer
    if not peer:
        return web.json_response({"error": "还没有人和沐说过话,不知道发给谁"}, status=409)
    try:
        if image:
            if not os.path.isfile(image):
                return web.json_response({"error": f"图片不存在: {image}"}, status=400)
            await _send_c2c_image(peer, image, reply_to=None)
            print(f"[qq-bridge] 主动发图给 {peer[:8]}: {image}", flush=True)
        if voice:
            if not os.path.isfile(voice):
                return web.json_response({"error": f"音频不存在: {voice}"}, status=400)
            await _send_c2c_voice(peer, voice, reply_to=None)
            print(f"[qq-bridge] 主动发语音给 {peer[:8]}: {voice}", flush=True)
        if text:
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
    if not MASTER_OPENID and not ALLOW_UNSAFE:
        print("[qq-bridge] 缺 QQ_MASTER_OPENID；默认拒绝无白名单启动。仅本地调试可设 ALLOW_UNAUTHENTICATED_BRIDGE=1", flush=True)
        sys.exit(1)
    asyncio.run(_run())


if __name__ == "__main__":
    main()
