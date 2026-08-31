# MindMap AI（mindmap-mvp）

AI 驱动的思维导图生成与编辑工具。粘贴文本、输入 URL、上传 PDF 或微信公众号文章，AI 在几秒内梳理出清晰的知识结构，生成结果可直接编辑、保存、导出。

单人本地闭环：输入 → 生成 → 编辑 → 导出，无需登录。

## 功能特性

### 多源输入，一键成图

| 输入源 | 说明 |
| --- | --- |
| 文本 | 直接粘贴长文本、会议记录、笔记 |
| URL | 抓取网页，基于 Readability 提取正文 |
| PDF | 有文本层直接提取；扫描件走 OCR（MinerU / 视觉大模型 / PaddleOCR / Tesseract 自动回退） |
| 微信公众号文章 | 三条通道可选：腾讯混元搜索增强 / 智谱联网搜索 / wechat-article-exporter |
| AI 模板 | SWOT、5W2H、会议纪要等预设骨架，选完直接进入编辑器微调 |

### AI 生成与编辑

- **流式生成**：SSE 边生成边在编辑器实时回放，内置首字超时看门狗
- **节点级 AI**：选中文本节点后可执行文本润色、内容拓展、内容简化、追问问题（插入为子节点）、智能生成子主题
- **全图 AI**：AI 精简、AI 重组、AI 摘要
- **多 LLM 提供商**：OpenAI（含 DeepSeek 等 OpenAI 兼容端点）、Anthropic、Gemini、智谱、Kimi、Minimax、通义千问

### 编辑器

- 基于 AntV G6 v5 Mindmap 布局，JSON Tree 作为单一数据源
- 四种布局方向：左 → 右 / 右 → 左 / 上 → 下 / 下 → 上
- 渲染器自动切换：节点数 ≤ 800 用 SVG，> 800 切 Canvas 保证性能
- 撤销 / 重做、添加子节点 / 兄弟节点、删除、节点笔记
- 大纲视图、演示模式、视图切换
- 节点 / 树结构全部经 Zod Schema 校验

### 持久化与导出

- 导图保存为本地 JSON 文件（`data/mindmaps/`），原子写入 + 按 id 写锁，避免并发丢更新
- 支持版本号与增量 patch
- 一键导出 Markdown / PNG

## 技术栈

| 类别 | 选型 |
| --- | --- |
| 框架 | Next.js 14（App Router）+ React 18 + TypeScript |
| 可视化 | AntV G6 v5（@antv/g-svg / @antv/g-canvas） |
| 状态管理 | Zustand |
| 数据校验 | Zod |
| LLM | Vercel AI SDK（@ai-sdk/openai 等） |
| 文档解析 | pdfjs-dist、@mozilla/readability、tesseract.js |
| 测试 | Vitest + Testing Library + Playwright |

## 快速开始

### 环境要求

- Node.js ≥ 20
- （可选）Python 3：仅本地 PaddleOCR 引擎需要

### 安装与启动

```bash
cd mindmap-mvp
npm install
cp .env.example .env   # 然后编辑 .env，填入 LLM API Key
npm run dev
```

打开 <http://localhost:3000>。

### 常用脚本

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 启动开发服务器 |
| `npm run build` / `npm run start` | 生产构建 / 启动 |
| `npm run test` | 运行全部 Vitest 测试 |
| `npm run test:watch` | 测试监听模式 |
| `npm run typecheck` | TypeScript 类型检查 |
| `npm run lint` | ESLint 检查 |

## 环境变量配置

完整配置项及注释见 `.env.example`，复制为 `.env` 后按需填写。

### 1. LLM 配置（必填其一）

| 变量 | 说明 |
| --- | --- |
| `LLM_PROVIDER` | openai / anthropic / gemini / zhipu / kimi / minimax / qwen |
| `LLM_MODEL` | 模型名，如 gpt-4o-mini、glm-4、qwen-plus |
| `OPENAI_API_KEY` 等 | 对应提供商的 API Key |
| `*_BASE_URL` | 可选，代理或自定义端点（OpenAI 兼容端点可接 DeepSeek 等） |
| `LLM_TIMEOUT` / `LLM_MAX_RETRIES` / `LLM_TEMPERATURE` | 超时（秒）/ 重试次数 / 温度 |

### 2. PDF OCR 配置（可选）

`PDF_OCR_ENGINE` 可选值：

| 值 | 说明 |
| --- | --- |
| `mineru` | MinerU 官方免费 API（默认，推荐） |
| `auto` | 优先视觉大模型 OCR，失败自动回退本地 OCR |
| `vlm` | 只用视觉大模型 OCR |
| `paddle` | 只用本地 PaddleOCR（需 Python 环境） |
| `tesseract` | 只用本地 Tesseract.js（中英文语言包已内置 `tessdata/`） |

常用变量：`PDF_OCR_MAX_PAGES`（默认 3）、`PDF_OCR_TIMEOUT_MS`、`PDF_OCR_CA_CERT_PATH`，以及为 OCR 单独配置的 `PDF_OCR_PROVIDER` / `PDF_OCR_MODEL` / `PDF_OCR_API_KEY` / `PDF_OCR_BASE_URL`。

> MinerU 单次任务最多 20 页，更多页会自动分批提交（每批独立等待），总超时需覆盖所有批次（建议 ≥ 360000）。MinerU 暂时不可用时，解析器会自动回退到本地 OCR 引擎。

### 3. 微信公众号文章配置（可选）

三条通道按成功率排序：

1. **腾讯混元（TokenHub）搜索增强（推荐）**：腾讯自家 AI，拥有微信生态独家资源，成功率最高。配置 `HUNYUAN_API_KEY` / `HUNYUAN_BASE_URL`（默认 `https://tokenhub.tencentmaas.com/v1`）/ `HUNYUAN_MODEL`（默认 `hy3-preview`）。
2. **智谱 AI 联网搜索**：`LLM_PROVIDER=zhipu` + `ZHIPU_API_KEY` 即可，通过 web_search 搜索并总结文章内容后直接输出导图（每次搜索约多消耗 1000 tokens）。
3. **wechat-article-exporter**：配置 `WECHAT_EXPORTER_BASE_URL`（默认公共实例 `https://down.mptext.top`）+ 网页扫码登录后获取的 `WECHAT_EXPORTER_AUTH_KEY` / `WECHAT_EXPORTER_TOKEN`。

## 页面路由

| 路径 | 页面 |
| --- | --- |
| `/` | 首页：生成入口 + 模板库 + 已保存导图列表 |
| `/g/[id]` | 思维导图编辑器 |

## API 一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/parse` | 解析 text / url / pdf / wechat 输入为标准化文档 |
| POST | `/api/generate` | SSE 流式生成思维导图 |
| POST | `/api/generate/markdown` | 生成 Markdown 大纲（调试） |
| POST | `/api/generate/mindmap-json` | 生成导图 JSON（调试） |
| GET | `/api/mindmaps` | 列出已保存导图 |
| GET | `/api/mindmaps/:id` | 读取指定导图 |
| PATCH | `/api/mindmaps/:id` | 保存导图（增量 patch） |
| DELETE | `/api/mindmaps/:id` | 删除指定导图 |
| POST | `/api/expand` | 为选中分支生成子主题 |
| POST | `/api/node-ai` | 节点级 AI（润色 / 拓展 / 简化 / 追问） |
| POST | `/api/optimize` | 全图优化（精简 / 重组） |
| POST | `/api/summary` | AI 摘要 |
| POST | `/api/wechat` | 微信文章搜索与解析（search / articleList / parseUrl / searchAndParse / check） |
| POST | `/api/export/markdown` | 导出 Markdown |
| POST | `/api/export/png` | 导出 PNG |

## 目录结构

```text
mindmap-mvp/
├── app/                  # Next.js App Router
│   ├── api/              # API 路由（parse / generate / mindmaps / export / ...）
│   └── g/[id]/           # 导图编辑器页面
├── components/           # React 组件（生成表单、编辑器、工具栏、AI 面板等）
├── lib/
│   ├── llm/              # LLM 调用、提示词、后处理
│   ├── parsers/          # 输入解析（text / url / pdf / wechat）
│   ├── storage/          # JSON 文件持久化
│   ├── streaming/        # SSE 生成会话
│   ├── types/            # Zod Schema 与共享类型（mindmap.ts）
│   ├── utils/            # tree / outline / g6 / renderer 等工具
│   └── wechat/           # wechat-article-exporter / 混元 / 智谱客户端
├── store/                # Zustand（generation-store / mindmap-store）
├── tests/                # Vitest 测试
├── scripts/              # 辅助脚本（paddle_ocr.py 等）
├── tessdata/             # Tesseract 中英文语言包
└── data/mindmaps/        # 已保存导图（运行时生成）
```

## 数据存储

导图以 JSON 文件形式保存在 `data/mindmaps/<id>.json`：

- 写入采用「临时文件 + rename」原子写，读取方不会看到半截 JSON
- 同一 id 的并发写请求通过内存写锁串行化，避免丢更新
- 记录包含 `meta.version` 与增量 patch，便于追溯修改

## 测试

测试基于 Vitest（node 环境），覆盖提示词、生成后处理、树操作、G6 布局与视口、API 路由层和组件交互。

```bash
npm run test        # 全量测试
npm run typecheck   # 类型检查
npm run lint        # Lint
```

涉及真实 OCR / 真实 PDF 的调试用例需要显式设置环境变量才会运行（如 `REAL_PDF_PATH`），默认不执行，避免拖慢测试。

## 常见问题

### LLM 请求报证书链错误

本机代理或企业根证书导致 HTTPS 校验失败时，在 `.env` 设置：

```bash
LLM_CA_CERT_PATH=/etc/ssl/cert.pem
```

该配置对所有 OpenAI 兼容 LLM 提供商生效（含 DeepSeek）。

### MinerU 暂时不可用

解析器会自动回退到本地 OCR 引擎，无需干预；也可切换 `PDF_OCR_ENGINE=auto` 使用视觉大模型 OCR。

### PaddleOCR 首次运行很慢

首次运行会从官方模型站下载模型文件，属正常现象。可在 `.env` 中关闭文档方向 / 去扭曲大模型以减少下载量：

```bash
PADDLE_OCR_USE_DOC_ORIENTATION=false
PADDLE_OCR_USE_DOC_UNWARPING=false
```

## 相关文档

- `.env.example`：全量环境变量说明
- `AGENTS.md`（仓库根目录）：Dev Server 运行守则与历史事故记录
- `docs/`：布局切换、节点连接线等设计文档与实施计划
