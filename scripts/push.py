#!/usr/bin/env python3
"""ateam push 脚本：从 .secrets/github.env 读 token 推送到 GitHub。

用法：
  python3 scripts/push.py            # push main 到 origin
  python3 scripts/push.py <refspec>  # 指定 refspec，如 python3 scripts/push.py "HEAD:main"
"""
import os
import subprocess
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load_env_file(path):
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
    # 凭据查找：仓库内 .secrets → 工作区根 .secrets（与 deploy.py 一致）
    load_env_file(os.path.join(REPO_ROOT, ".secrets", "github.env"))
    load_env_file(os.path.join(os.path.dirname(REPO_ROOT), ".secrets", "github.env"))
    token = os.environ.get("GITHUB_TOKEN", "")
    if not token:
        sys.exit("缺少 GITHUB_TOKEN：请检查 .secrets/github.env")

    refspec = sys.argv[1] if len(sys.argv) > 1 else "main"
    helper = '!f() { echo "username=bytesfloow"; echo "password=%s"; }; f' % token
    result = subprocess.run(
        ["git", "-c", f"credential.helper={helper}", "push", "origin", refspec],
        cwd=REPO_ROOT,
    )
    sys.exit(result.returncode)


if __name__ == "__main__":
    main()
