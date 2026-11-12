#!/bin/sh
cd "$(dirname "$0")" || exit 1
project_node_version=$(cat .node-version)
project_node="${NVM_DIR:-$HOME/.nvm}/versions/node/v${project_node_version}/bin/node"
if [ -x "$project_node" ]; then
  exec "$project_node" scripts/launch.mjs
elif command -v node >/dev/null 2>&1; then
  exec node scripts/launch.mjs
else
  echo "未找到 Node.js，请安装 Node.js ${project_node_version}，再运行 npm ci。"
  exit 1
fi
