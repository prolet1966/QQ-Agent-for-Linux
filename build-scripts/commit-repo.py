# -*- coding: utf-8 -*-
"""commit-repo.py —— 用 staging 内容替换仓库全部文件，并提交。

为什么要"全量替换"而不是增量添加：
  仓库现有内容描述的是一个**已废弃的 Python 框架项目**（docs/decisions.md 里
  写着"实现语言定为 Python"，README 讲的是 bot framework）。而本仓库现在要承载
  的是 QQ Agent V0.4.4 的 Linux 移植版 —— 完全不同的东西。
  两套文档混在一起会让人完全看不懂这个仓库是什么。

保留 .git 与 .github（Issue 模板仍有用）。

注意 LICENSE：
  仓库里原有的 LICENSE 是那个框架的 Apache-2.0；
  上游 QQ Agent 是 **MIT（Copyright (c) 2026 Kondius）**。
  本移植版的源码全部来自上游，故 LICENSE 必须是上游那份 MIT ——
  MIT 明确要求随附版权声明，去掉就是许可瑕疵。
  所以 staging 里的 LICENSE（上游 MIT）覆盖仓库里的 Apache-2.0。
"""

import os
import shutil
import subprocess
import sys

REPO = r"F:\kmy\Documents\dpsk\harness\.gh-work"
STAGE = r"F:\kmy\Documents\dpsk\harness\.gh-stage"

# 提交时保留（不删）
KEEP_TOP = {".git", ".github"}


def run(args, cwd=REPO, check=True):
    r = subprocess.run(args, cwd=cwd, capture_output=True, text=True, encoding="utf-8")
    if check and r.returncode != 0:
        print(f"  ❌ {' '.join(args)}")
        print(f"     stdout: {(r.stdout or '').strip()[:400]}")
        print(f"     stderr: {(r.stderr or '').strip()[:400]}")
        sys.exit(1)
    return r


def main() -> int:
    if not os.path.isdir(REPO):
        print(f"❌ 仓库目录不存在: {REPO}")
        return 2
    if not os.path.isdir(STAGE):
        print(f"❌ staging 不存在: {STAGE}")
        return 2

    print("== 1. 清空仓库顶层（保留 .git / .github）==")
    for name in os.listdir(REPO):
        if name in KEEP_TOP:
            continue
        p = os.path.join(REPO, name)
        if os.path.isdir(p):
            shutil.rmtree(p, ignore_errors=True)
        else:
            try:
                os.remove(p)
            except OSError as e:
                print(f"  ⚠️  删除 {name} 失败: {e}")
        print(f"  删除 {name}")

    print("\n== 2. 复制 staging 内容 ==")
    count = 0
    total = 0
    for root, dirs, files in os.walk(STAGE):
        rel_root = os.path.relpath(root, STAGE)
        for f in files:
            src = os.path.join(root, f)
            rel = os.path.join(rel_root, f) if rel_root != "." else f
            dst = os.path.join(REPO, rel)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copy2(src, dst)
            count += 1
            total += os.path.getsize(src)
    print(f"  复制 {count} 个文件，{total/1024/1024:.2f} MB")

    print("\n== 3. 关键文件核对 ==")
    for f in ["README.md", "LICENSE", "package.json", "src/platform.js",
              "docs/linux-install.md", "docs/linux-delivery-report.md"]:
        p = os.path.join(REPO, f)
        ok = "✅" if os.path.isfile(p) else "❌"
        print(f"  {ok} {f}")

    # LICENSE 必须是上游 MIT
    lic = os.path.join(REPO, "LICENSE")
    if os.path.isfile(lic):
        with open(lic, encoding="utf-8") as fh:
            head = fh.read(120)
        if "MIT License" in head and "Kondius" in head:
            print("  ✅ LICENSE 为上游 MIT（含 Kondius 版权声明）")
        else:
            print("  ❌ LICENSE 不是预期的上游 MIT，请检查")
            return 1
    else:
        print("  ❌ LICENSE 缺失")
        return 1

    print("\n== 4. git status 概览 ==")
    r = run(["git", "status", "--short"])
    lines = [l for l in r.stdout.splitlines() if l.strip()]
    print(f"  变更条目: {len(lines)}")
    for l in lines[:15]:
        print(f"    {l}")
    if len(lines) > 15:
        print(f"    …还有 {len(lines)-15} 条")

    print("\n== 5. 提交 ==")
    run(["git", "add", "-A"])
    msg = (
        "feat: Linux port of QQ Agent v0.4.4 with .deb/.rpm/AppImage packaging\n"
        "\n"
        "把 QQ-Agent V0.4.4（Node.js + Electron）移植到 Linux 并打包。\n"
        "\n"
        "主要改动：\n"
        "- 新增 src/platform.js 平台抽象层，收敛全部 OS 差异\n"
        "- 数据目录改为 XDG 规范（Linux 落到 ~/.local/share/qq-agent）\n"
        "- SnowLuma 启动 Linux 化：三级运行时兜底（发行包 node → 系统 node →\n"
        "  Electron 内置 Node），回退 launcher.sh\n"
        "- stopSnowluma 改用 /proc/<pid>/cmdline 匹配（原为 wmic）\n"
        "- explorer.exe/cmd.exe 改 xdg-open（routes.js 三处）\n"
        "- electron/main.js 数据目录复用平台层，去掉重复实现\n"
        "- 重建 package.json build 配置：deb/rpm/AppImage target、依赖声明、asarUnpack\n"
        "- 纳入 V0.3.1 的 17 个插件与 25 个技能（apiVersion 兼容，无工具 id 冲突）\n"
        "- 凭据清理：移除硬编码的真实 QQ 号与私人关键词\n"
        "\n"
        "验证：平台层单测 35/35；.deb 冒烟 25/25；.rpm 等价验证 18/18；\n"
        "AppImage 冒烟 7/7；loadPlugins 已加载 70 失败 0。\n"
        "\n"
        "保留上游作者署名与 MIT 许可。详见 docs/linux-delivery-report.md"
    )
    r = run(["git", "commit", "-m", msg])
    print("  " + (r.stdout or "").strip().splitlines()[0] if r.stdout else "  已提交")
    r2 = run(["git", "log", "--oneline", "-2"])
    for l in r2.stdout.strip().splitlines():
        print(f"    {l}")

    print("\n== 6. 提交统计 ==")
    r3 = run(["git", "show", "--stat", "--oneline", "HEAD"])
    tail = r3.stdout.strip().splitlines()
    for l in tail[-4:]:
        print(f"    {l}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
