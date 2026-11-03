#!/usr/bin/env bash
# ISHIT 云服务器纯后端 (Backend-Only) 一键部署 / 更新脚本
# 作用：利用 Git Sparse-Checkout 让云服务器只检出 backend/ 与根目录配置文件，彻底隔离 frontend/ 与 dist/ 客户端代码

set -e

echo "[1/3] 启用 Git 稀疏检出 (仅保留 backend/ 目录)..."
git sparse-checkout init --cone
git sparse-checkout set backend

echo "[2/3] 拉取最新代码并安装后端依赖..."
git pull origin main
npm install --omit=dev

echo "[3/3] 纯后端准备就绪！当前工作区目录："
ls -la
echo "启动命令: npm start (或使用 pm2: pm2 start backend/server.js --name ishit-backend)"
