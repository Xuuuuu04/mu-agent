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


def is_authorized(sender, master):
    """主人白名单:master 设了就只认它,没设则放行(旧行为)。空 sender 由调用方另判。"""
    return not master or sender == master


def extract_image_urls(attachments):
    """从 QQ 消息 attachments 里抽图片 URL(content_type 以 image 开头且有 url)。"""
    return [
        a.get("url")
        for a in (attachments or [])
        if str(a.get("content_type", "")).startswith("image") and a.get("url")
    ]


def ask_payload(text, sender, source):
    """问沐的 webhook 请求体。qq/wechat 共用,只有 source 不同。"""
    return {"text": text, "sender_name": "哥哥", "sender_id": sender, "source": source}


def is_delivered(send_result):
    """微信(iLink)投递成功的判据:返回里带新 context_token 才算真投递。
    issue#35949:缺/stale token 时返 HTTP 200 + errcode 0 但静默丢弃,errcode 不可信。"""
    return bool((send_result or {}).get("context_token"))


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
