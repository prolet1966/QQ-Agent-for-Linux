# run-fedora-rpm-test.ps1 —— 在 Fedora WSL 发行版里对 .rpm 做真实安装冒烟测试。
#
# ## 为什么是 Fedora WSL，而不是那台 Fedora 虚拟机
#
# 虚拟机侧的实测结论（详见 fetch-fedora-wsl.py 顶部注释）：guest 冻死、截图 60 秒
# 逐像素不变、vmcli 按键注入静默无效、VMware VNC 拒绝所有外部客户端认证。
# 那条路已证明走不通，继续投入没有产出。
#
# 本脚本用**官方 Fedora 44 WSL 镜像**（SHA256 已与官方 CHECKSUM 核对一致），
# 得到真实 Fedora 用户态：rpm 6.0.1、glibc 2.43、dnf5、
# 以及 Fedora 自己的依赖包名解析 —— 这正是验证 .rpm 所必需的部分。
#
# ## 能力边界（如实标注，不冒充"真机全项通过"）
#   ✅ rpm/dnf 依赖解析与事务、安装路径与权限、rpm 数据库注册、
#      %post 脚本、卸载与残留、文件校验
#   ❌ Fedora 自带内核相关行为、真实图形栈（GUI 启动已在 Ubuntu .deb 真机测试覆盖）
#
# ## ★ 踩过的坑：绝不要用 PowerShell 给 wsl.exe 传 Windows 路径
#
#   `wsl.exe -d X -- wslpath -a "F:\a\b.rpm"` 传进去会变成 `F:kmyDocumentsdpsk...`
#   —— PowerShell 调原生程序时会吃掉反斜杠，导致路径彻底失效。
#   本脚本因此改为：**在 bash 侧用 wslpath 转换**，PowerShell 只负责把路径
#   作为不带变量的字面量拼进命令字符串，天然规避转义问题。
#
# 用法:
#   pwsh -File run-fedora-rpm-test.ps1
#   pwsh -File run-fedora-rpm-test.ps1 -Rpm F:\path\to\x.rpm -Distro qqagent-fedora

param(
    [string]$Rpm    = 'F:\kmy\Documents\dpsk\harness\QQ-Agent-for-Linux\port\dist\qq-agent-v0.4.4-x86_64.rpm',
    [string]$ExpectSha = '7eab74f312d81373d9f83865c112f3e8447838d64202df256e7a3abf723e822c',
    [string]$Distro = 'qqagent-fedora',
    [string]$Script = 'F:\kmy\Documents\dpsk\harness\QQ-Agent-for-Linux\port\build-scripts\fedora-01-rpm-smoke.sh'
)

$ErrorActionPreference = 'Continue'

# ★ 所有喂给 bash 的文本都必须先去掉 CR。
#   踩过的坑：PowerShell here-string 是 CRLF，直接管道给 bash -s 时，
#   `echo "RPM_PATH=$RPM_PATH" >> /tmp/x` 里的行尾 \r 会被写进变量值，
#   导致后续 `[ -f "$RPM_PATH" ]` 判定失败、参数变成空串，
#   现象是"明明传了路径却报用法错误"，很容易误判成参数没传进去。
function To-Lf([string]$s) { return $s.Replace("`r`n", "`n").Replace("`r", "") }

if (-not (Test-Path $Rpm))    { Write-Host "❌ 找不到 rpm: $Rpm"; exit 1 }
if (-not (Test-Path $Script)) { Write-Host "❌ 找不到脚本: $Script"; exit 1 }

$localSha = (Get-FileHash $Rpm -Algorithm SHA256).Hash.ToLower()

Write-Host "########## Fedora WSL 上的 .rpm 真机冒烟测试 ##########"
Write-Host "  rpm 包  : $Rpm  ($([math]::Round((Get-Item $Rpm).Length/1MB,2)) MB)"
Write-Host "  宿主SHA256: $localSha"
Write-Host "  发行版  : $Distro"
if ($ExpectSha -and $ExpectSha -ne $localSha) {
    Write-Host "  ⚠️  与期望哈希不同：期望 $ExpectSha"
}

# ── 1. 在 Fedora 侧转换路径 + 校验包完整性 ────────────────────────────────
# 路径按字面量拼进单引号字符串，不用 PowerShell 变量插值，避免反斜杠被吞。
$setup = @'
RPM_PATH="$(wslpath -a 'WINDOWS_RPM')"
SCRIPT_PATH="$(wslpath -a 'WINDOWS_SCRIPT')"
echo "  Fedora 侧 rpm 路径 : $RPM_PATH"
echo "  Fedora 侧 脚本路径 : $SCRIPT_PATH"
[ -f "$RPM_PATH" ] || { echo "❌ rpm 在 Fedora 侧不可见"; exit 1; }
echo ""
echo "== 通过挂载层读取的 SHA256（必须与宿主机一致）=="
sha256sum "$RPM_PATH"
echo "SCRIPT_PATH=$SCRIPT_PATH" > /tmp/qa-paths.env
echo "RPM_PATH=$RPM_PATH" >> /tmp/qa-paths.env
'@
$setup = $setup.Replace('WINDOWS_RPM', $Rpm).Replace('WINDOWS_SCRIPT', $Script)
$setup = To-Lf $setup

Write-Host ""
$setupOut = $setup | & wsl.exe -d $Distro -- bash -s 2>&1 | Out-String
Write-Host $setupOut

$remoteSha = ($setupOut -split "`n" | Where-Object { $_ -match '^[0-9a-f]{64}\s' } | Select-Object -First 1)
if ($remoteSha) { $remoteSha = $remoteSha.Trim().Split(' ')[0] }
if ($localSha -ne $remoteSha) {
    Write-Host "❌ 两侧哈希不一致（宿主 $localSha / Fedora $remoteSha）—— 停止测试"
    exit 1
}
Write-Host "✅ 包完整性：两侧 SHA256 一致"

# ── 2. 执行测试脚本 ───────────────────────────────────────────────────────
# ★ 不要把「测试脚本 + 一行调用」拼成一个流喂给 `bash -s`：
#   bash 从 stdin 读脚本时，位置参数已经被 `-s` 后面的参数占用，
#   再拼一行 `bash $SCRIPT_PATH ...` 只会把整个流当成那行调用的 stdin。
#   正确做法：把脚本原样落到 Fedora 临时文件，再用真实参数执行它。
Write-Host ""
Write-Host "########## 开始测试 ##########"
Write-Host ""

$runner = @'
. /tmp/qa-paths.env
sed -e 's/\r$//' "$SCRIPT_PATH" > /tmp/qa-fedora-smoke.sh
chmod +x /tmp/qa-fedora-smoke.sh
bash /tmp/qa-fedora-smoke.sh "$RPM_PATH" "EXPECT_SHA"
'@
$runner = $runner.Replace('EXPECT_SHA', $ExpectSha)
$runner = To-Lf $runner

$outFile = 'F:\fedora-wsl\rpm-smoke-result.txt'
$runner | & wsl.exe -d $Distro -- bash -s 2>&1 | Tee-Object -FilePath $outFile
$rc = $LASTEXITCODE

Write-Host ""
Write-Host "########## 结束（退出码 $rc）##########"
Write-Host "完整输出已保存: $outFile"
exit $rc
