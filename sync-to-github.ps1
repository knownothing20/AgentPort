# sync-to-github.ps1
# 从 mcp-remote-agent skill 目录同步文件到 GitHub 仓库
# 只同步指定文件，排除隐私配置

param(
    [string]$SkillDir = "C:\Users\leon\.workbuddy\skills\mcp-remote-agent",
    [string]$RepoDir = "D:\GitHub\mcp-remote-agent"
)

Write-Host "Syncing from $SkillDir to $RepoDir ..." -ForegroundColor Cyan

# 要同步的文件列表（白名单，排除敏感文件）
$files = @(
    # 根目录文件
    ".gitignore",
    "README.md",
    "README_CN.md",
    "SKILL.md",
    "CHANGELOG.md",
    "LICENSE",
    "index.js",
    "ssh-client.js",
    "package.json",
    "mcp-remote-agent.example.json",
    "sync.cjs",
    "test.cjs",
    "publish-guide.md",
    
    # local 目录（只同步样例和说明）
    "local\README.md",
    "local\connections.json.example",
    
    # server 目录
    "server\server.js",
    "server\mcp-remote-agent-manager.sh",
    "server\package.json",
    "server\dashboard.html",
    "server\setup-autostart.sh",
    "server\.env.example"
)

# 复制文件
$copied = 0
$skipped = 0

foreach ($file in $files) {
    $src = Join-Path $SkillDir $file
    $dst = Join-Path $RepoDir $file
    
    if (Test-Path $src) {
        # 确保目标目录存在
        $dstDir = Split-Path $dst -Parent
        if (!(Test-Path $dstDir)) {
            New-Item -ItemType Directory -Path $dstDir -Force | Out-Null
        }
        
        Copy-Item -Path $src -Destination $dst -Force
        Write-Host "  Copied: $file" -ForegroundColor Green
        $copied++
    } else {
        Write-Host "  Skipped: $file (not found)" -ForegroundColor Yellow
        $skipped++
    }
}

Write-Host "`nSync completed!" -ForegroundColor Cyan
Write-Host "  Copied: $copied files" -ForegroundColor Green
Write-Host "  Skipped: $skipped files" -ForegroundColor Yellow

Write-Host "`nExcluded files (privacy):" -ForegroundColor Red
Write-Host "  - local/mcp-remote-agent.json (real config)" -ForegroundColor Gray
Write-Host "  - local/connections.json (real config)" -ForegroundColor Gray
Write-Host "  - local/server/.env (generated)" -ForegroundColor Gray

Write-Host "`nNext steps:" -ForegroundColor White
Write-Host "  cd $RepoDir" -ForegroundColor Gray
Write-Host "  git status" -ForegroundColor Gray
Write-Host "  git add ." -ForegroundColor Gray
Write-Host "  git commit -m 'your message'" -ForegroundColor Gray
Write-Host "  git push" -ForegroundColor Gray
