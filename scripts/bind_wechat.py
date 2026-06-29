#!/usr/bin/env python3
"""沐的微信绑定。复用 hermes 的 ilinkai 二维码登录(qr_login)。

跑起来会在终端弹出 ASCII 二维码 + 一个可扫的 URL。用要绑定的微信扫,
在微信里确认,绑定成功后自动把新的 account_id / token 写进 config/wechat.env。

用法(在 aliyun 上跑,终端要够大能显示二维码):
  cd /home/jump/mu
  /home/jump/ai/venvs/hermes/bin/python scripts/bind_wechat.py
或(env 覆盖):
  HERMES_PY=... HERMES_SITE_PACKAGES=... python3 scripts/bind_wechat.py

绑定成功后重启 bridge:  pm2 restart mu-wechat
"""
import asyncio
import os
import sys


def _default_hermes_sp() -> str:
    """从 HERMES_PY 推导 site-packages,失败回退到 aliyun 默认值。"""
    hermes_py = os.environ.get("HERMES_PY", "/home/jump/ai/venvs/hermes/bin/python")
    if os.path.exists(hermes_py):
        venv_root = os.path.dirname(os.path.dirname(hermes_py))
        py_ver = f"python{sys.version_info.major}.{sys.version_info.minor}"
        return os.path.join(venv_root, "lib", py_ver, "site-packages")
    return "/home/jump/ai/venvs/hermes/lib/python3.12/site-packages"


HERMES_SP = os.environ.get("HERMES_SITE_PACKAGES") or _default_hermes_sp()
if HERMES_SP not in sys.path:
    sys.path.insert(0, HERMES_SP)

from gateway.platforms.weixin import qr_login  # noqa: E402

HOME = os.environ.get("MU_WECHAT_HOME", "/home/jump/mu/data/wechat")
ENV = os.environ.get("MU_WECHAT_ENV", "/home/jump/mu/config/wechat.env")


def _read_existing_env(env_path: str) -> dict:
    """解析旧 env 成 dict(保留键的出现顺序)。
    re-bind 只覆盖 ACCOUNT_ID/TOKEN/BASE_URL/HOME,其余覆盖项(MASTER_ID/CDN/HERMES_PY/
    MU_WEBHOOK/MU_WECHAT_SEND_PORT...)原样回写,否则生产靠 wechat.env 注入的键会被静默清掉。"""
    env: dict = {}
    try:
        with open(env_path, encoding="utf-8") as f:
            for raw in f:
                line = raw.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, val = line.partition("=")
                env[key.strip()] = val
    except FileNotFoundError:
        pass
    return env


async def main():
    os.makedirs(os.path.join(HOME, "weixin-accounts"), exist_ok=True)
    print("=" * 50)
    print("Shion · 微信绑定")
    print("=" * 50)
    print("马上弹二维码。用【要给 Shion 用的那个微信】扫,扫完在微信里点确认。")
    print("(想换个干净的号就用新号扫,别用之前被限流的)\n")

    cred = await qr_login(HOME, bot_type="3", timeout_seconds=480)
    if not cred:
        print("\n❌ 绑定失败或超时,重新跑一次就行")
        sys.exit(1)

    # 保留旧 env 的全部键,只覆盖本次绑定产出的四项,其余(MASTER_ID/CDN/HERMES_PY...)原样回写
    env = _read_existing_env(ENV)
    env["WEIXIN_ACCOUNT_ID"] = cred["account_id"]
    env["WEIXIN_TOKEN"] = cred["token"]
    env["WEIXIN_BASE_URL"] = cred.get("base_url") or "https://ilinkai.weixin.qq.com"
    env["MU_WECHAT_HOME"] = HOME

    with open(ENV, "w", encoding="utf-8") as f:
        f.write("\n".join(f"{k}={v}" for k, v in env.items()) + "\n")
    os.chmod(ENV, 0o600)

    print("\n" + "=" * 50)
    print(f"✅ 绑定成功! account_id={cred['account_id']}")
    print(f"   凭据已写入 {ENV}")
    print("=" * 50)
    print("\n下一步,重启 bridge 让它用新号:")
    print("  /home/jump/.npm-global/bin/pm2 restart mu-wechat")


if __name__ == "__main__":
    asyncio.run(main())
