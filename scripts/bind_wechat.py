#!/usr/bin/env python3
"""沐的微信绑定。复用 hermes 的 ilinkai 二维码登录(qr_login)。

跑起来会在终端弹出 ASCII 二维码 + 一个可扫的 URL。用要绑定的微信扫,
在微信里确认,绑定成功后自动把新的 account_id / token 写进 config/wechat.env。

用法(在 xpark 上跑,终端要够大能显示二维码):
  cd /home/xpark/mu
  /home/xpark/ai/venvs/hermes/bin/python scripts/bind_wechat.py

绑定成功后重启 bridge:  pm2 restart mu-wechat
"""
import asyncio
import os
import sys

HERMES_SP = os.environ.get(
    "HERMES_SITE_PACKAGES",
    "/home/xpark/ai/venvs/hermes/lib/python3.12/site-packages",
)
if HERMES_SP not in sys.path:
    sys.path.insert(0, HERMES_SP)

from gateway.platforms.weixin import qr_login  # noqa: E402

HOME = os.environ.get("MU_WECHAT_HOME", "/home/xpark/mu/data/wechat")
ENV = os.environ.get("MU_WECHAT_ENV", "/home/xpark/mu/config/wechat.env")


async def main():
    os.makedirs(os.path.join(HOME, "weixin-accounts"), exist_ok=True)
    print("=" * 50)
    print("沐 · 微信绑定")
    print("=" * 50)
    print("马上弹二维码。用【要给沐用的那个微信】扫,扫完在微信里点确认。")
    print("(想换个干净的号就用新号扫,别用之前被限流的)\n")

    cred = await qr_login(HOME, bot_type="3", timeout_seconds=480)
    if not cred:
        print("\n❌ 绑定失败或超时,重新跑一次就行")
        sys.exit(1)

    lines = [
        f"WEIXIN_ACCOUNT_ID={cred['account_id']}",
        f"WEIXIN_TOKEN={cred['token']}",
        f"WEIXIN_BASE_URL={cred.get('base_url') or 'https://ilinkai.weixin.qq.com'}",
        f"MU_WECHAT_HOME={HOME}",
    ]
    with open(ENV, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    os.chmod(ENV, 0o600)

    print("\n" + "=" * 50)
    print(f"✅ 绑定成功! account_id={cred['account_id']}")
    print(f"   凭据已写入 {ENV}")
    print("=" * 50)
    print("\n下一步,重启 bridge 让它用新号:")
    print("  /home/xpark/.npm-global/bin/pm2 restart mu-wechat")


if __name__ == "__main__":
    asyncio.run(main())
