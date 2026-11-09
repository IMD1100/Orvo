# Orvo

Orvo 是一个面向 AI 辅助混音的轻量级桌面工作台。支持多轨播放、可编辑的效果器蓝图、音频导出，以及通过兼容的模型 API 生成处理方案。

项目处于开发阶段。

## 功能

- 多轨波形、播放、音量、声像、静音、独奏和循环选区。
- 每轨及 Master 的可编辑 FX 蓝图，支持串联和并联路由。
- 内置效果器、VST3 插件宿主、EQ 响应和实时频谱。
- 使用模型 API 与音频分析生成 FX 方案，结果可继续编辑。
- 保存可重开的工程及关联素材，导出完整混音或单轨 WAV。

音频引擎由 C++ / JUCE 实现，桌面窗口使用 Tauri / Rust，界面使用 React / TypeScript，Python 服务负责音频分析和 AI 请求。实际效果取决于音频、效果器和模型响应。

## Windows 源码运行

需要 Git、Node.js、pnpm、Python 3.10 或更高版本、Rust、CMake、Visual Studio C++ Build Tools 和 Windows SDK。

在仓库根目录执行：

```powershell
# 下载 JUCE 到被忽略的本地依赖目录
git clone --branch 8.0.12 --depth 1 https://github.com/juce-framework/JUCE.git .deps/JUCE
py -3 -m venv python/.venv
python/.venv/Scripts/python.exe -m pip install -r python/requirements.txt
cd frontend
pnpm install --frozen-lockfile
cd ..
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/dev.ps1
```

首次运行会编译音频引擎和 Rust 桌面程序。启动后在 AI 面板的设置中配置 API 地址、模型和密钥；密钥保存在系统凭据存储中，不写入工程或源码。