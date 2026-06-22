# Workbook 教师语音收作业系统

Workbook 是一个面向初中教师的移动端优先 PWA，用来通过语音念姓名快速统计作业已交、未交和待确认名单。第一版包含教师自注册登录、年级班级学生库、作业任务、Excel/CSV 导入、本地 OCR 校对入口和 SQLite 数据存储。

## 技术栈

- 前端：Vite + React + TypeScript
- 后端：Node.js + Express + Prisma
- 数据库：SQLite
- 包管理：pnpm workspace

## 本地开发

```bash
pnpm install
pnpm db:migrate
pnpm dev
```

前端默认运行在 `http://localhost:5173`，API 默认运行在 `http://localhost:4100`。

## 常用命令

```bash
pnpm test
pnpm build
pnpm start
```

## 部署备注

目标服务器路径建议为 `/opt/workbook`。生产环境需要提供 `.env`，不要提交真实密钥、数据库文件或上传文件。私有 GitHub 仓库就绪后，服务器可以通过 `git pull` 更新代码，再执行：

```bash
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm build
pnpm start
```

生产服务建议使用 `pm2` 或 `systemd` 托管。
