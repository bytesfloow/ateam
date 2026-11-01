#!/usr/bin/env python3
"""
A-Team 一键部署脚本（自包含，随仓库分发）

流程：本地构建 (vite build + tsc) → 打包 → SFTP 上传 → 服务器验证 Node(>=24)
      → 解包部署 → npm install → systemd 重启 → 健康检查 → 公网验证

用法（在仓库根目录执行）：
  python3 scripts/deploy.py               # 全流程
  python3 scripts/deploy.py --skip-build  # 跳过本地构建（仅服务器端改动时用）
  CN_SSH_PASS=xxxx python3 scripts/deploy.py   # 或手动传密码

凭据优先级：环境变量 > .secrets/aliyun.env（仓库内）> ../.secrets/aliyun.env（工作区根）
            > 交互输入。凭据文件被 .gitignore 忽略，不进 git、不写进任何文档。

依赖：python3 + paramiko（pip install paramiko）；本地构建需要 pnpm（缺失时回退 npx pnpm@8）。

默认目标：阿里云 8.159.144.112:3002（/opt/ateam，systemd 服务 ateam）。
可通过环境变量覆盖：ATEAM_DEPLOY_HOST / ATEAM_DEPLOY_USER / ATEAM_DEPLOY_DIR / ATEAM_DEPLOY_PORT。
"""
import os
import sys
import time
import getpass
import tarfile
import subprocess
import paramiko

# ============ 配置（环境变量可覆盖） ============
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HOST = os.environ.get("ATEAM_DEPLOY_HOST", "8.159.144.112")
SSH_PORT = 22
USER = os.environ.get("ATEAM_DEPLOY_USER", "root")
APP_DIR = os.environ.get("ATEAM_DEPLOY_DIR", "/opt/ateam")
APP_PORT = os.environ.get("ATEAM_DEPLOY_PORT", "3002")
NODE_VERSION = "v24.21.0"  # node:sqlite 需要 Node >= 24
NODE_MIRROR = "https://npmmirror.com/mirrors/node"
NPM_REGISTRY = "https://registry.npmmirror.com"
TARBALL_LOCAL = "/tmp/ateam-deploy.tar.gz"
TARBALL_REMOTE = "/tmp/ateam-deploy.tar.gz"

NODE_DIR = f"/usr/local/lib/nodejs/node-{NODE_VERSION}-linux-x64"
NODE_BIN = f"{NODE_DIR}/bin"


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def sh(cli, cmd, timeout=300):
    """远端执行命令，返回 (code, out)"""
    _, stdout, stderr = cli.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode("utf-8", "replace")
    err = stderr.read().decode("utf-8", "replace")
    code = stdout.channel.recv_exit_status()
    return code, out + (f"\n[stderr] {err}" if err.strip() and code != 0 else "")


def sh_check(cli, cmd, timeout=300, desc=""):
    code, out = sh(cli, cmd, timeout)
    if code != 0:
        log(f"✗ 失败: {desc or cmd}\n{out[:800]}")
        sys.exit(1)
    return out


def local_build():
    log("① 本地构建 (vite build + tsc)...")
    r = subprocess.run(
        ["pnpm", "build"], cwd=REPO_ROOT,
        capture_output=True, text=True, timeout=600,
        env={**os.environ, "PATH": f"{os.environ.get('HOME')}/.npm-global/bin:/usr/local/bin:{os.environ['PATH']}"},
    )
    if r.returncode != 0:
        # pnpm 不在 PATH 时退回 npx pnpm
        r = subprocess.run(["npx", "--yes", "pnpm@8", "build"], cwd=REPO_ROOT,
                           capture_output=True, text=True, timeout=600)
    if r.returncode != 0:
        log(f"✗ 构建失败:\n{r.stdout[-600:]}\n{r.stderr[-600:]}")
        sys.exit(1)
    log("  构建完成")


def local_pack():
    log("② 打包部署产物...")
    with tarfile.open(TARBALL_LOCAL, "w:gz") as tf:
        def add(path, arc):
            p = os.path.join(REPO_ROOT, path)
            if not os.path.exists(p):
                log(f"  ✗ 缺少 {path}（先运行 pnpm build）")
                sys.exit(1)
            tf.add(p, arcname=arc)

        add("dist", "dist")              # tsc 编译产物 (dist/server/src/index.js)
        add("web/dist", "web/dist")      # 前端静态文件
        add("package.json", "package.json")
    size = os.path.getsize(TARBALL_LOCAL) / 1024 / 1024
    log(f"  {TARBALL_LOCAL} ({size:.1f} MB)")


def upload(cli):
    log("③ 上传部署包...")
    sftp = cli.open_sftp()
    sftp.put(TARBALL_LOCAL, TARBALL_REMOTE)
    sftp.close()
    log("  上传完成")


def ensure_node(cli):
    code, out = sh(cli, "/usr/local/bin/node --version 2>/dev/null")
    if code == 0 and NODE_VERSION.lstrip("v") in out:
        log(f"④ Node {out.strip()} 已安装，跳过")
        return
    log(f"④ 安装 Node {NODE_VERSION} (npmmirror 镜像)...")
    sh_check(cli, "mkdir -p /usr/local/lib/nodejs", desc="创建 nodejs 目录")
    tgz = f"/tmp/node-{NODE_VERSION}-linux-x64.tar.xz"
    sh_check(
        cli,
        f"wget -q --tries=3 -O {tgz} {NODE_MIRROR}/{NODE_VERSION}/node-{NODE_VERSION}-linux-x64.tar.xz "
        f"&& tar -xJf {tgz} -C /usr/local/lib/nodejs/ && rm -f {tgz}",
        timeout=300, desc="下载并解压 Node",
    )
    sh_check(
        cli,
        f"ln -sf {NODE_BIN}/node /usr/local/bin/node && "
        f"ln -sf {NODE_BIN}/npm /usr/local/bin/npm && "
        f"ln -sf {NODE_BIN}/npx /usr/local/bin/npx",
        desc="创建符号链接",
    )
    out = sh_check(cli, "node --version && npm --version", desc="验证 node/npm")
    log(f"  {out.strip()}")


def prepare(cli):
    log("⑤ 准备用户与目录...")
    sh_check(cli, "id ateam >/dev/null 2>&1 || useradd -r -m -d /home/ateam -s /usr/sbin/nologin ateam", desc="创建系统用户")
    sh_check(cli, f"mkdir -p {APP_DIR} && chown -R ateam:ateam {APP_DIR} /home/ateam", desc="创建目录")


def deploy(cli):
    """解包新产物；data/ 与 workspaces/ 不在包内，重复部署不丢数据"""
    log("⑥ 解包部署...")
    sh_check(
        cli,
        f"rm -rf {APP_DIR}/dist {APP_DIR}/web/dist && "
        f"tar -xzf {TARBALL_REMOTE} -C {APP_DIR} && rm -f {TARBALL_REMOTE} && "
        f"chown -R ateam:ateam {APP_DIR}",
        desc="解包",
    )


def install_deps(cli):
    log("⑦ 安装生产依赖 (npmmirror)...")
    out = sh_check(
        cli,
        f"cd {APP_DIR} && npm install --omit=dev --registry={NPM_REGISTRY} --no-audit --no-fund 2>&1 | tail -3",
        timeout=900, desc="npm install",
    )
    log(f"  {out.strip()}")


SYSTEMD_UNIT = f"""[Unit]
Description=A-Team agent pipeline
After=network.target

[Service]
WorkingDirectory={APP_DIR}
Environment=PORT={APP_PORT}
Environment=HOST=0.0.0.0
ExecStart=/usr/local/bin/node dist/server/src/index.js
Restart=always
RestartSec=3
User=ateam

[Install]
WantedBy=multi-user.target
"""


def setup_service(cli):
    log("⑧ 配置 systemd 服务...")
    unit = SYSTEMD_UNIT.strip()
    cmd = (
        "cat > /etc/systemd/system/ateam.service <<'UNIT_EOF'\n"
        f"{unit}\nUNIT_EOF\n"
        "systemctl daemon-reload && systemctl enable ateam >/dev/null && systemctl restart ateam && echo RESTARTED"
    )
    out = sh_check(cli, cmd, desc="写入 unit 并重启服务")
    log(f"  {out.strip()}")

    log("⑨ 健康检查 (服务器本机)...")
    for _ in range(15):
        code, out = sh(cli, f"curl -fsS -o /dev/null -w '%{{http_code}}' http://127.0.0.1:{APP_PORT}/api/status 2>/dev/null")
        if code == 0 and out.strip() == "200":
            break
        time.sleep(2)
    else:
        code, out = sh(cli, "systemctl status ateam --no-pager -l | head -20; journalctl -u ateam -n 30 --no-pager | tail -30")
        log(f"✗ 服务未就绪:\n{out}")
        sys.exit(1)
    code, out = sh(cli, f"curl -fsS http://127.0.0.1:{APP_PORT}/api/status 2>/dev/null | head -c 120")
    log(f"  API 健康: {out.strip()}")


def external_check():
    log("⑩ 外部验证 (公网)...")
    r = subprocess.run(
        ["curl", "-fsS", "-m", "10", "-o", "/dev/null", "-w", "%{http_code}",
         f"http://{HOST}:{APP_PORT}/"],
        capture_output=True, text=True, timeout=20,
    )
    if r.stdout.strip() == "200":
        log(f"  http://{HOST}:{APP_PORT}/ → 200 ✓")
    else:
        log(f"  ✗ 公网访问不通（HTTP {r.stdout}）。"
            f"服务器本机已正常，多半是云安全组未放行 {APP_PORT}/tcp——"
            f"请在控制台为实例添加入方向规则后重跑本脚本（会跳过重复步骤）。")
        sys.exit(1)


def load_env_file(path):
    """读取 shell 风格的凭据文件到环境变量（不覆盖已有值）"""
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line.startswith("export ") and "=" in line:
                    k, v = line[len("export "):].split("=", 1)
                    k, v = k.strip(), v.strip().strip('"').strip("'")
                    os.environ.setdefault(k, v)
    except FileNotFoundError:
        pass


def main():
    skip_build = "--skip-build" in sys.argv
    # 凭据查找：仓库内 .secrets → 工作区根 .secrets（不覆盖已有环境变量）
    load_env_file(os.path.join(REPO_ROOT, ".secrets", "aliyun.env"))
    load_env_file(os.path.join(os.path.dirname(REPO_ROOT), ".secrets", "aliyun.env"))
    password = os.environ.get("CN_SSH_PASS") or getpass.getpass(f"SSH 密码 ({USER}@{HOST}): ")

    if not skip_build:
        local_build()
    else:
        log("① 跳过本地构建 (--skip-build)")
    local_pack()

    log(f"目标: {USER}@{HOST}:{APP_DIR} (端口 {APP_PORT})")
    cli = paramiko.SSHClient()
    cli.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    cli.connect(HOST, port=SSH_PORT, username=USER, password=password,
                timeout=20, banner_timeout=30, auth_timeout=30,
                allow_agent=False, look_for_keys=False)
    try:
        upload(cli)
        ensure_node(cli)
        prepare(cli)
        deploy(cli)
        install_deps(cli)
        setup_service(cli)
    finally:
        cli.close()
    external_check()
    log(f"🎉 部署完成: http://{HOST}:{APP_PORT}/")


if __name__ == "__main__":
    main()
