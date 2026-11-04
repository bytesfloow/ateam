#!/usr/bin/env python3
"""A-Team 部署编排器（从开发机执行，驱动远端服务器完成自动部署）

职责：
  1. 可选：把本地已提交的改动推送到 GitHub（复用 scripts/push.py）
  2. SSH 到目标服务器：首次走 bootstrap.sh，之后走 deploy_remote.sh
     （远端脚本负责 拉代码 → 装依赖 → 构建 → 重启 → 健康检查，任一步失败自动回滚）
  3. 部署完成后从本机做公网健康检查 + 只读 API 冒烟测试

用法（在仓库根目录执行）：
  # 首次部署：引导服务器（装 Node 24 / pnpm / systemd）并部署
  python3 scripts/deploy_ateam.py --bootstrap --push

  # 日常部署：推代码 → 服务器拉代码 → 构建 → 重启 → 健康检查 → 冒烟
  python3 scripts/deploy_ateam.py --push

  # 只重启不构建 / 跳过冒烟 / 指定服务器
  python3 scripts/deploy_ateam.py --no-build
  python3 scripts/deploy_ateam.py --host 1.2.3.4 --user ubuntu --key ~/.ssh/id_ed25519

连接方式（优先级：--key 明确指定 > 密钥自动发现 > 密码）：
  --key <path>    SSH 私钥；未指定时若 ~/.ssh/id_ed25519 存在会自动使用
  --password      密码登录（需要 sshpass），密码取自 SSH_PASSWORD / CN_SSH_PASS
                  环境变量或 .secrets/aliyun.env，都没有则交互输入
  非 root 用户需要免密 sudo；默认直接以 root 登录。
"""
from __future__ import annotations

import argparse
import getpass
import json
import os
import shlex
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

GREEN, RED, YELLOW, CYAN, DIM, RESET = (
    "\033[32m", "\033[31m", "\033[33m", "\033[36m", "\033[2m", "\033[0m",
)


def info(msg: str) -> None:
    print(f"{CYAN}==>{RESET} {msg}", flush=True)


def ok(msg: str) -> None:
    print(f"{GREEN}  ✓{RESET} {msg}", flush=True)


def warn(msg: str) -> None:
    print(f"{YELLOW}  !{RESET} {msg}", flush=True)


def err(msg: str) -> None:
    print(f"{RED}  ✗{RESET} {msg}", flush=True)


def run(cmd: list[str], *, cwd: Path | None = None, check: bool = True,
        env: dict | None = None, quiet: bool = False) -> subprocess.CompletedProcess:
    if not quiet:
        info(" $ " + " ".join(shlex.quote(c) for c in cmd))
    proc = subprocess.run(cmd, cwd=cwd, text=True, capture_output=True, env=env)
    if proc.stdout.strip():
        print(proc.stdout.rstrip())
    if proc.stderr.strip():
        print(proc.stderr.rstrip(), file=sys.stderr)
    if check and proc.returncode != 0:
        err(f"命令失败（退出码 {proc.returncode}）")
        raise SystemExit(1)
    return proc


def git_out(*argv: str) -> str:
    return subprocess.run(
        ["git", *argv], cwd=REPO_ROOT, text=True, capture_output=True,
    ).stdout.strip()


def load_env_file(path: Path) -> None:
    """读取 shell 风格凭据文件（export KEY=VALUE），不覆盖已有环境变量。"""
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line.startswith("export ") and "=" in line:
                    k, v = line[len("export "):].split("=", 1)
                    os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    except FileNotFoundError:
        pass


def ssh_cmd(args: argparse.Namespace, remote_cmd: str) -> list[str]:
    base = ["ssh", "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=15"]
    if args.ssh_port != 22:
        base += ["-p", str(args.ssh_port)]
    if args.key:
        base += ["-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-i", str(args.key)]
    else:
        base += ["-o", "NumberOfPasswordPrompts=1"]
    ssh = base + [f"{args.user}@{args.host}", remote_cmd]
    # 密码不进 argv：sshpass -e 从 SSHPASS 环境变量读取
    return ["sshpass", "-e", *ssh] if not args.key else ssh


def ssh_env(password: str | None) -> dict | None:
    return {**os.environ, "SSHPASS": password} if password else None


def remote_run(args: argparse.Namespace, remote_cmd: str, password: str | None,
               *, as_root: bool = True) -> None:
    if args.user != "root" and as_root:
        remote_cmd = "sudo -n bash -lc " + shlex.quote(remote_cmd)
    info(f"SSH → {args.user}@{args.host}")
    print(f"{DIM}   {remote_cmd[:160]}{'…' if len(remote_cmd) > 160 else ''}{RESET}")
    run(ssh_cmd(args, remote_cmd), env=ssh_env(password))


def health_check(url: str, retries: int = 12, interval: float = 2.0) -> dict | None:
    for i in range(1, retries + 1):
        try:
            with urllib.request.urlopen(url, timeout=8) as resp:
                if resp.status == 200:
                    body = resp.read().decode("utf-8", "replace")
                    try:
                        return json.loads(body)
                    except json.JSONDecodeError:
                        return {"raw": body[:200]}
        except (urllib.error.URLError, OSError) as e:
            if i == retries:
                err(f"健康检查失败: {e}")
                return None
        time.sleep(interval)
    err("健康检查失败：超时")
    return None


def main() -> None:
    # 先加载凭据文件，让 .secrets/aliyun.env 也能覆盖下面的默认目标
    load_env_file(REPO_ROOT / ".secrets" / "aliyun.env")
    load_env_file(REPO_ROOT.parent / ".secrets" / "aliyun.env")

    ap = argparse.ArgumentParser(description="A-Team 部署编排器")
    ap.add_argument("--host", default=os.environ.get("ATEAM_DEPLOY_HOST", "8.159.144.112"),
                    help="目标服务器 IP/域名（默认 8.159.144.112）")
    ap.add_argument("--user", default=os.environ.get("ATEAM_DEPLOY_USER", "root"),
                    help="SSH 用户名（默认 root）")
    ap.add_argument("--ssh-port", type=int, default=22, help="SSH 端口")
    ap.add_argument("--app-port", default=os.environ.get("ATEAM_DEPLOY_PORT", "3002"),
                    help="对外服务端口（默认 3002）")
    ap.add_argument("--deploy-dir", default=os.environ.get("ATEAM_DEPLOY_DIR", "/opt/ateam"),
                    help="服务器部署目录（默认 /opt/ateam）")
    ap.add_argument("--repo-url", default="https://github.com/bytesfloow/ateam.git",
                    help="服务器拉取代码的仓库地址")
    ap.add_argument("--key", help="SSH 私钥路径（默认自动发现 ~/.ssh/id_ed25519）")
    ap.add_argument("--password", action="store_true", help="强制使用密码登录")
    ap.add_argument("--push", action="store_true", help="部署前先 push 本地提交到 GitHub")
    ap.add_argument("--bootstrap", action="store_true", help="首次部署：执行引导脚本")
    ap.add_argument("--branch", default="main", help="部署分支")
    ap.add_argument("--public-url", help="对外访问 URL（默认 http://HOST:APP_PORT/）")
    ap.add_argument("--no-build", "--skip-build", dest="no_build", action="store_true",
                    help="跳过构建，仅重启（远端 deploy_remote.sh --no-build）")
    ap.add_argument("--skip-smoke", action="store_true", help="跳过部署后的只读冒烟测试")
    args = ap.parse_args()

    # ---------- 凭据 ----------
    key = args.key
    if not key and not args.password:
        default_key = Path.home() / ".ssh" / "id_ed25519"
        if default_key.exists():
            key = str(default_key)
    args.key = key

    password: str | None = None
    if key:
        info(f"SSH 密钥: {key}")
    else:
        password = os.environ.get("SSH_PASSWORD") or os.environ.get("CN_SSH_PASS")
        if not password:
            password = getpass.getpass(f"SSH 密码 ({args.user}@{args.host}): ")
        if not shutil.which("sshpass"):
            err("密码登录需要 sshpass（apt-get install -y sshpass），或改用 --key 密钥登录")
            raise SystemExit(1)
    if not shutil.which("ssh"):
        err("本机缺少 ssh 客户端")
        raise SystemExit(1)

    public_url = args.public_url or f"http://{args.host}:{args.app_port}/"

    # ---------- 1. 本地仓库状态 ----------
    unpushed = git_out("log", f"origin/{args.branch}..HEAD", "--oneline")
    dirty = git_out("status", "--porcelain")
    if unpushed:
        warn(f"本地有未推送的提交（{len(unpushed.splitlines())} 条），远端不会包含这些改动：")
        for line in unpushed.splitlines():
            print(f"{DIM}     {line}{RESET}")
        warn("如需部署这些改动，请加 --push")
    if dirty:
        warn("工作区有未提交的改动；--push 只会推送已提交的内容")
    if args.bootstrap and not args.push and (unpushed or dirty):
        warn("首次引导会从 GitHub 拉取脚本，未推送/未提交的改动不会生效；建议加 --push")

    # ---------- 2. 可选：推送到 GitHub ----------
    if args.push:
        info("推送本地提交到 GitHub（scripts/push.py）")
        run([sys.executable, str(REPO_ROOT / "scripts" / "push.py"), args.branch], cwd=REPO_ROOT)
        ok("已推送")
        # push 后重新确认，避免误报
        unpushed = git_out("log", f"origin/{args.branch}..HEAD", "--oneline")

    # ---------- 3. 首次引导 ----------
    if args.bootstrap:
        info(f"首次引导（Node 24 / pnpm / systemd / 端口 {args.app_port}）")
        d, p = shlex.quote(args.deploy_dir), shlex.quote(str(args.app_port))
        remote = (
            "rm -rf /tmp/ateam-bootstrap && "
            f"git clone --depth 1 --branch {shlex.quote(args.branch)} "
            f"{shlex.quote(args.repo_url)} /tmp/ateam-bootstrap && "
            f"DEPLOY_DIR={d} PORT={p} bash /tmp/ateam-bootstrap/scripts/bootstrap.sh"
        )
        remote_run(args, remote, password)
        ok("引导完成")

    # ---------- 4. 部署 ----------
    info("执行远端部署（失败会自动回滚）")
    d = shlex.quote(args.deploy_dir)
    flags = " --no-build" if args.no_build else ""
    remote_run(
        args,
        f"cd {d} && DEPLOY_DIR={d} bash scripts/deploy_remote.sh{flags}",
        password,
    )

    # ---------- 5. 公网健康检查 ----------
    health_url = public_url.rstrip("/") + "/api/health"
    info(f"公网健康检查 {health_url}")
    state = health_check(health_url)
    if not state or state.get("ok") is not True:
        err(f"健康检查未通过：{state}")
        err(f"服务器本机可能已正常，请确认云安全组已放行 {args.app_port}/tcp")
        raise SystemExit(1)
    ok(f"服务状态: version={state.get('version')} uptime={state.get('uptime')}s")

    # ---------- 6. 只读冒烟测试 ----------
    if not args.skip_smoke:
        info("运行只读 API 冒烟测试")
        smoke = subprocess.run(
            [sys.executable, str(REPO_ROOT / "scripts" / "smoke_test.py"),
             "--url", public_url],
            cwd=REPO_ROOT, text=True,
        )
        if smoke.returncode != 0:
            err("冒烟测试未通过")
            raise SystemExit(1)

    print()
    ok(f"部署完成 → {public_url}")
    info("服务管理：systemctl status ateam | journalctl -u ateam -f")
    info(f"数据目录：{args.deploy_dir}/data 与 {args.deploy_dir}/workspaces（部署不会删除）")


if __name__ == "__main__":
    main()
