# read-vm-screen.ps1 —— 用 vmcli 抓 Fedora 虚拟机的屏幕并识图。
#
# 为什么走这条路：
#   - `vmrun captureScreen` 需要先 VixVM_LoginInGuest，匿名 guest 操作被拒绝；
#   - 手写 VNC 客户端在认证阶段被 VNC 服务端直接断开（VMware 的 VNC 实现有自有 key 派生）；
#   - `vmcli.exe MKS captureScreenshot` 是 VMware 官方 CLI，直接抓控制台画面，无需认证。
#
# vision-skill 的 dotenv 是可选依赖、本机未安装，所以这里手工把 .env 注入环境变量。

param(
    [string]$Vmx  = 'F:\rpm-vm\Fedora-rpm-test.vmx',
    [string]$Out  = 'F:\rpm-vm\screen.png',
    [string]$Prompt = '请完整转录屏幕上所有可见文字，尤其是错误提示、警告、进度信息和底部状态行，并说明当前处于哪个安装阶段。'
)

$ErrorActionPreference = 'Continue'
$vmcli = 'F:\VM\vmcli.exe'

# ── 1. 抓屏
if (Test-Path $Out) { Remove-Item $Out -Force }
& $vmcli $Vmx MKS captureScreenshot $Out 2>&1 | Out-String | Write-Host
Start-Sleep -Seconds 1
if (-not (Test-Path $Out)) { Write-Host "❌ 截图未生成"; exit 1 }
Write-Host "✅ 截图: $Out  ($([math]::Round((Get-Item $Out).Length/1KB,1)) KB)"

# ── 2. 注入 .env（替代缺失的 dotenv）
$envFile = 'F:\Agnes\vision-skill\.env'
if (Test-Path $envFile) {
    foreach ($line in (Get-Content $envFile -Encoding UTF8)) {
        if ($line -match '^\s*#' -or $line.Trim() -eq '') { continue }
        $p = $line -split '=', 2
        if ($p.Count -eq 2) {
            [Environment]::SetEnvironmentVariable($p[0].Trim(), $p[1].Trim(), 'Process')
        }
    }
    Write-Host "已注入 .env（模型: $env:VISION_MODEL）"
} else {
    Write-Host "⚠️ 未找到 $envFile"
}

# ── 3. 识图
Set-Location 'F:\Agnes\vision-skill'
& node vision.js $Out $Prompt 2>&1 | Out-String | Write-Host
