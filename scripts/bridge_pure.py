"""沐 bridge 的纯逻辑(qq_bridge / wechat_bridge 共享)。

刻意零外部依赖(不 import aiohttp / gateway),这样能用 stdlib unittest 直接测,
不用起 venv、不碰网络。两个 bridge 把可测的判断逻辑都收到这里。
跑测试:python3 -m unittest scripts.test_bridge_pure
"""
from collections import deque


def split_reply_chunks(reply, max_chunks=5):
    """按空行把回复拆成多条(她的风格本就是一个想法一条)。
    QQ 同一 msg_id 被动回复最多 max_chunks 条:前 max_chunks-1 条独立,其余合并进最后一条。
    ≤1 段时返回 [reply](发原文),保持和旧 _send_reply_chunks 逐字一致的行为。"""
    chunks = [c.strip() for c in reply.split("\n\n") if c.strip()]
    if len(chunks) <= 1:
        return [reply]
    if len(chunks) > max_chunks:
        chunks = chunks[: max_chunks - 1] + ["\n\n".join(chunks[max_chunks - 1:])]
    return chunks


def is_authorized(sender, master, allow_unsafe=False):
    """主人白名单默认 fail-closed。仅本地调试显式 allow_unsafe 才允许未配置 master。"""
    return (bool(master) and sender == master) or (not master and allow_unsafe)


def extract_image_urls(attachments):
    """从 QQ 消息 attachments 里抽图片 URL(content_type 以 image 开头且有 url)。"""
    return [
        a.get("url")
        for a in (attachments or [])
        if str(a.get("content_type", "")).startswith("image") and a.get("url")
    ]


def ask_payload(text, sender, source):
    """请求 Shion 的 webhook。qq/wechat 共用,只有 source 不同。"""
    return {"text": text, "sender_name": "用户", "sender_id": sender, "source": source}


def build_c2c_body(text, msg_seq, reply_to=None, msg_type=0, max_len=4000):
    """QQ C2C 文本消息体。content 截到 max_len(QQ 拒收过长会整条失败);
    带 reply_to(收到的 msg_id)= 被动回复(5 分钟内免费),不带 = 主动消息。"""
    body = {"content": text[:max_len], "msg_type": msg_type, "msg_seq": msg_seq}
    if reply_to:
        body["msg_id"] = reply_to
    return body


class Dedup:
    """收消息去重:QQ 会重推。FIFO 满 cap 只淘汰最老一条——整体 clear 会让重推的旧
    msg_id 被当新消息重复处理。"""

    def __init__(self, cap=1000):
        self.seen = set()
        self.order = deque()
        self.cap = cap

    def is_dup(self, msg_id):
        if not msg_id or msg_id in self.seen:
            return True
        self.seen.add(msg_id)
        self.order.append(msg_id)
        if len(self.order) > self.cap:
            self.seen.discard(self.order.popleft())
        return False
