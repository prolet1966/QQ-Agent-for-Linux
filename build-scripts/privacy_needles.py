# -*- coding: utf-8 -*-
"""隐私标识清单加载 —— 从仓库外的私有文件读取"需要清理/检查的敏感值"。

## 为什么要有这个模块

原本 `sanitize-staging.py` / `audit-doc-leaks.py` / `stage-for-github.py`
都把真实 QQ 号与私人关键词**硬编码在脚本里**当搜索模式用。这有三个问题：

1. **清理器自己携带敏感值** —— 每次运行都要先把自己脚本里的值替换掉。
   一次实测就暴露了：替换数从 6 处涨到 14 处，多出来的正是这几个脚本自己。
   清理工具本身成了泄露源，这在逻辑上就说不通。

2. **脚本进了公开仓库** —— 敏感值随脚本一起公开，
   等于"为了清理泄露而制造泄露"。

3. **谁也改不了** —— 换个人接手，想清理自己的标识就得改脚本源码。

## 现在的做法

敏感值只存在**仓库外**的一个私有文件里，脚本运行时读取：

    ~/.qq-agent-privacy-needles.txt

文件格式（每行一条，`#` 开头为注释）：

    # 需要清理/检查的值，一行一个
    1234567890          ← QQ 号之类
    某个私人关键词
    另一个私人词

替换目标（placeholder）由调用方指定，默认用中性示例值。

## 兼容

找不到该文件时不报错，只是返回空列表 —— 脚本会照常跑完，
但会明确提示"未找到私有清单，本轮不做替换检查"，
避免用户以为清理生效了其实没有（静默失效是最坏的结果）。
"""

from __future__ import annotations

import os
from pathlib import Path

# 默认私有清单位置。可用环境变量覆盖，便于在不同机器上使用。
DEFAULT_NEEDLE_FILE = "~/.qq-agent-privacy-needles.txt"

# 中性占位值：替换后不影响功能语义，也不透漏原值特征
PLACEHOLDER_QQ = "10001"
PLACEHOLDER_WORDS = ["早安", "在吗"]


def needle_file_path() -> Path:
    env = os.environ.get("QQ_AGENT_PRIVACY_NEEDLES", "").strip()
    return Path(os.path.expanduser(env or DEFAULT_NEEDLE_FILE))


def load_needles(*, verbose: bool = True) -> list[str]:
    """读取敏感值清单。文件不存在时返回空列表并提示。"""
    path = needle_file_path()

    if not path.is_file():
        if verbose:
            print(f"  ⚠️  未找到私有清单：{path}")
            print("      本轮不做标识替换/检查。")
            print("      如需清理，请创建该文件，每行一个敏感值（# 开头为注释）。")
        return []

    values: list[str] = []
    try:
        with open(path, encoding="utf-8") as fh:
            for raw in fh:
                line = raw.strip()
                if not line or line.startswith("#"):
                    continue
                values.append(line)
    except OSError as exc:
        if verbose:
            print(f"  ⚠️  读取私有清单失败：{exc}")
        return []

    # 去重且保持顺序
    seen = set()
    uniq = []
    for v in values:
        if v not in seen:
            seen.add(v)
            uniq.append(v)

    if verbose:
        print(f"  已加载私有清单：{path}（{len(uniq)} 条）")
    return uniq


def split_identifiers(needles: list[str]) -> tuple[list[str], list[str]]:
    """按形态粗分：纯数字的视为 ID（打码/替换成数字占位），其余视为词语。

    这只是为了选择更合适的占位值，不影响"是否要清理"的判断。
    """
    ids = [n for n in needles if n.isdigit()]
    words = [n for n in needles if not n.isdigit()]
    return ids, words


def placeholder_for(value: str, index: int = 0) -> str:
    """给某个敏感值挑一个占位值。"""
    if value.isdigit():
        return PLACEHOLDER_QQ
    if index < len(PLACEHOLDER_WORDS):
        return PLACEHOLDER_WORDS[index]
    return f"示例词{index + 1}"


def ensure_template(path: Path | None = None) -> Path:
    """在清单不存在时创建一个带说明的模板文件（内容全为注释，不含真值）。"""
    p = path or needle_file_path()
    if p.is_file():
        return p
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(
        "# 隐私标识清单\n"
        "#\n"
        "# 用途：build-scripts 里的清理与检查脚本会读取本文件，\n"
        "#       把下列值从待发布内容中替换掉 / 检查是否残留。\n"
        "#\n"
        "# 为什么单独放一个文件、而不是写在脚本里：\n"
        "#   写在脚本里，清理工具自己就成了泄露源（脚本会被提交到公开仓库），\n"
        "#   而且每次运行都要先替换自己。\n"
        "#\n"
        "# 格式：每行一个值，# 开头为注释。\n"
        "#\n"
        "# 示例（取消注释并改成你自己的）：\n"
        "# 1234567890\n"
        "# 某个私人称呼\n"
        "# 某个私人关键词\n",
        encoding="utf-8",
    )
    return p
