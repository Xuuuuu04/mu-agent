"""bridge_pure 的 characterization 测试。跑:python3 -m unittest scripts.test_bridge_pure"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))
from bridge_pure import (  # noqa: E402
    split_reply_chunks, is_authorized, extract_image_urls,
    ask_payload, is_delivered, build_c2c_body, Dedup,
)


class TestBuildC2CBody(unittest.TestCase):
    def test_basic(self):
        b = build_c2c_body("hi", 3)
        self.assertEqual(b, {"content": "hi", "msg_type": 0, "msg_seq": 3})

    def test_reply_to_adds_msg_id(self):
        b = build_c2c_body("hi", 1, reply_to="m1")
        self.assertEqual(b["msg_id"], "m1")

    def test_no_reply_to_no_msg_id(self):
        self.assertNotIn("msg_id", build_c2c_body("hi", 1))

    def test_truncates_to_max_len(self):
        b = build_c2c_body("x" * 5000, 1, max_len=4000)
        self.assertEqual(len(b["content"]), 4000)


class TestSplitReplyChunks(unittest.TestCase):
    def test_single_returns_original(self):
        self.assertEqual(split_reply_chunks("就一句话"), ["就一句话"])

    def test_no_blank_line_single(self):
        self.assertEqual(split_reply_chunks("第一行\n第二行"), ["第一行\n第二行"])

    def test_three_chunks(self):
        self.assertEqual(split_reply_chunks("a\n\nb\n\nc"), ["a", "b", "c"])

    def test_strips_each_chunk(self):
        self.assertEqual(split_reply_chunks("  a  \n\n  b  "), ["a", "b"])

    def test_drops_empty_chunks(self):
        self.assertEqual(split_reply_chunks("a\n\n\n\nb"), ["a", "b"])

    def test_over_max_merges_tail(self):
        out = split_reply_chunks("a\n\nb\n\nc\n\nd\n\ne\n\nf\n\ng")
        self.assertEqual(len(out), 5)
        self.assertEqual(out[:4], ["a", "b", "c", "d"])
        self.assertEqual(out[4], "e\n\nf\n\ng")  # 第 5 条合并剩余

    def test_exactly_five(self):
        out = split_reply_chunks("a\n\nb\n\nc\n\nd\n\ne")
        self.assertEqual(out, ["a", "b", "c", "d", "e"])


class TestIsAuthorized(unittest.TestCase):
    def test_no_master_allows_anyone(self):
        self.assertTrue(is_authorized("anyone", ""))

    def test_master_set_only_master(self):
        self.assertTrue(is_authorized("bro", "bro"))
        self.assertFalse(is_authorized("stranger", "bro"))


class TestExtractImageUrls(unittest.TestCase):
    def test_image_with_url(self):
        atts = [{"content_type": "image/png", "url": "u1"}, {"content_type": "image/jpeg", "url": "u2"}]
        self.assertEqual(extract_image_urls(atts), ["u1", "u2"])

    def test_skips_non_image_and_no_url(self):
        atts = [{"content_type": "audio/x", "url": "a"}, {"content_type": "image/png"}, {"content_type": "image/png", "url": "u"}]
        self.assertEqual(extract_image_urls(atts), ["u"])

    def test_empty_or_none(self):
        self.assertEqual(extract_image_urls([]), [])
        self.assertEqual(extract_image_urls(None), [])


class TestAskPayload(unittest.TestCase):
    def test_structure(self):
        self.assertEqual(
            ask_payload("在吗", "uid", "qq"),
            {"text": "在吗", "sender_name": "哥哥", "sender_id": "uid", "source": "qq"},
        )


class TestIsDelivered(unittest.TestCase):
    def test_has_token_delivered(self):
        self.assertTrue(is_delivered({"context_token": "abc", "errcode": 0}))

    def test_no_token_not_delivered(self):
        self.assertFalse(is_delivered({"errcode": 0}))      # errcode 0 也不算
        self.assertFalse(is_delivered({"context_token": ""}))
        self.assertFalse(is_delivered(None))


class TestDedup(unittest.TestCase):
    def test_first_false_second_true(self):
        d = Dedup()
        self.assertFalse(d.is_dup("m1"))
        self.assertTrue(d.is_dup("m1"))

    def test_empty_id_is_dup(self):
        self.assertTrue(Dedup().is_dup(""))

    def test_fifo_evicts_oldest(self):
        d = Dedup(cap=3)
        for m in ["a", "b", "c"]:
            d.is_dup(m)
        self.assertTrue(d.is_dup("b"))    # cap 内,b 仍在
        d.is_dup("dd")                    # 第 4 个唯一 id → 淘汰最老的 a
        self.assertNotIn("a", d.seen)
        self.assertFalse(d.is_dup("a"))   # a 被淘汰后再来当新消息(FIFO 的代价,符合设计)


if __name__ == "__main__":
    unittest.main()
