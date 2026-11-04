#!/usr/bin/env python3
"""A-Team 部署后只读冒烟测试

只用标准库（urllib），可在任意 Python 3.8+ 环境直接跑。
全部为只读 GET，不会在生产环境创建智能体、流水线或任务。

覆盖：健康/状态接口、前端页面与静态资源、各资源列表接口、404 处理。

用法：
  python3 scripts/smoke_test.py --url http://1.2.3.4:3002/
  python3 scripts/smoke_test.py --url http://127.0.0.1:3002/
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.error
import urllib.request

GREEN, RED, YELLOW, CYAN, BOLD, RESET = (
    "\033[32m", "\033[31m", "\033[33m", "\033[36m", "\033[1m", "\033[0m",
)

PASSED: list[str] = []
FAILED: list[tuple[str, str]] = []


def check(name: str, cond: bool, detail: str = "") -> bool:
    if cond:
        PASSED.append(name)
        print(f"{GREEN}  ✓{RESET} {name}")
    else:
        FAILED.append((name, detail))
        print(f"{RED}  ✗{RESET} {name}  {YELLOW}{detail}{RESET}")
    return bool(cond)


def section(title: str) -> None:
    print(f"\n{BOLD}{CYAN}▸ {title}{RESET}")


class Client:
    def __init__(self, base: str) -> None:
        self.base = base.rstrip("/")

    def get(self, path: str, timeout: int = 15):
        url = path if path.startswith("http") else f"{self.base}{path}"
        req = urllib.request.Request(url, method="GET")
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.status, resp.read(), dict(resp.headers)
        except urllib.error.HTTPError as e:
            return e.code, e.read(), dict(e.headers)
        except (urllib.error.URLError, OSError) as e:
            return 0, str(e).encode(), {}

    def get_json(self, path: str):
        status, raw, headers = self.get(path)
        try:
            return status, json.loads(raw.decode("utf-8", "replace")), headers
        except (ValueError, UnicodeDecodeError):
            return status, {"_raw": raw[:200].decode("utf-8", "replace")}, headers


def main() -> int:
    ap = argparse.ArgumentParser(description="A-Team 只读冒烟测试")
    ap.add_argument("--url", default="http://127.0.0.1:3002/", help="站点根地址")
    args = ap.parse_args()

    c = Client(args.url)
    print(f"{BOLD}A-Team 冒烟测试{RESET}  目标: {args.url}")

    # ---------- 1. 系统接口 ----------
    section("系统接口")
    st, body, _ = c.get_json("/api/health")
    reachable = check("GET /api/health 返回 200 且 ok=true",
                      st == 200 and body.get("ok") is True, f"status={st} {str(body)[:120]}")
    check("健康接口返回版本号", bool(body.get("version")), str(body)[:120])
    check("健康接口返回 uptime", isinstance(body.get("uptime"), int), str(body)[:120])
    if not reachable:
        print(f"{RED}服务不可达，终止{RESET}")
        return 1

    st, body, _ = c.get_json("/api/status")
    check("GET /api/status 含 status 与 stats",
          st == 200 and "status" in body and "stats" in body, f"status={st} {str(body)[:150]}")

    st, body, _ = c.get_json("/api/stats")
    check("GET /api/stats 含 stats", st == 200 and "stats" in body, f"status={st} {str(body)[:150]}")

    # ---------- 2. 前端页面与静态资源 ----------
    section("前端页面")
    st, raw, headers = c.get("/")
    html = raw.decode("utf-8", "replace")
    page_ok = st == 200 and "<html" in html.lower() and "A-Team" in html
    check("GET / 返回前端 HTML（A-Team）", page_ok, f"status={st} {html[:120]!r}")
    check("前端已构建（不是占位页）", "前端尚未构建" not in html, html[:120])
    check("响应未暴露 X-Powered-By", "x-powered-by" not in {k.lower() for k in headers},
          str(list(headers)[:12]))

    m = re.search(r'src="(/assets/[^"]+\.js)"', html)
    if check("页面引用了构建后的 JS 主包", bool(m), html[:200]):
        st, js, js_headers = c.get(m.group(1))
        ctype = js_headers.get("Content-Type", "").lower()
        check("JS 主包可访问且非空",
              st == 200 and len(js) > 100, f"status={st} len={len(js)} type={ctype}")

    # ---------- 3. 资源列表接口（只读）----------
    section("资源列表接口")
    for path, key in [
        ("/api/agents", "agents"),
        ("/api/pipelines", "pipelines"),
        ("/api/skills", "skills"),
        ("/api/tasks", "tasks"),
    ]:
        st, body, _ = c.get_json(path)
        check(f"GET {path} 返回 {key} 列表",
              st == 200 and isinstance(body.get(key), list), f"status={st} {str(body)[:150]}")

    st, body, _ = c.get_json("/api/settings")
    check("GET /api/settings 含 settings",
          st == 200 and "settings" in body, f"status={st} {str(body)[:120]}")

    st, body, _ = c.get_json("/api/tools")
    check("GET /api/tools 可用", st == 200, f"status={st} {str(body)[:120]}")

    # ---------- 4. 错误处理 ----------
    section("错误处理")
    st, _, _ = c.get("/api/__smoke_not_found__")
    check("未知 API 返回 404", st == 404, f"status={st}")

    # ---------- 汇总 ----------
    total = len(PASSED) + len(FAILED)
    print()
    if FAILED:
        print(f"{RED}{BOLD}失败 {len(FAILED)}/{total}{RESET}")
        for name, detail in FAILED:
            print(f"  {RED}✗{RESET} {name}  {detail}")
        return 1
    print(f"{GREEN}{BOLD}全部通过 {total}/{total}{RESET}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
