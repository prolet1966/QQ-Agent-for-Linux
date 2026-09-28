// 诊断锚点为何不匹配：检查行尾符、并逐行定位 patch-linux.mjs 里的锚点
import fs from 'node:fs';
import path from 'node:path';

const appDir = process.argv[2];
const probes = [
  { id: 'data-dir-xdg', file: 'electron/main.js', needle: 'if (process.env.QQ_AGENT_DATA_DIR) return process.env.QQ_AGENT_DATA_DIR;' },
  { id: 'snowluma-stop-posix', file: 'src/app.js', needle: 'const queryCmd = ' },
  { id: 'snowluma-launch-posix', file: 'src/app.js', needle: "const nodeExe = path.join(dir, 'node.exe');" },
  { id: 'snowluma-launch-node-bin', file: 'src/app.js', needle: 'const child = spawn(nodeExe, [indexMjs], {' },
  { id: 'portable-qq-unsupported', file: 'src/app.js', needle: 'function qqPortableReady() {' },
];

for (const p of probes) {
  const full = path.join(appDir, p.file);
  const buf = fs.readFileSync(full);
  const src = buf.toString('utf8');
  const crlf = (src.match(/\r\n/g) || []).length;
  const lf = (src.match(/(?<!\r)\n/g) || []).length;
  console.log(`\n=== ${p.file} (${p.id}) ===`);
  console.log(`  行尾: CRLF=${crlf} 纯LF=${lf}   ← ${crlf > 0 ? '文件是 CRLF！锚点用 LF 必然不匹配' : '纯 LF'}`);

  // 找 needle 所在行，打印其原始字节
  const idx = src.indexOf(p.needle);
  if (idx < 0) {
    console.log(`  needle 未找到: ${JSON.stringify(p.needle)}`);
    continue;
  }
  const lineStart = src.lastIndexOf('\n', idx) + 1;
  const lineEnd = src.indexOf('\n', idx);
  const line = src.slice(lineStart, lineEnd);
  console.log(`  命中行(JSON): ${JSON.stringify(line)}`);
  // 该行前一行与后一行
  const prevStart = src.lastIndexOf('\n', lineStart - 2) + 1;
  console.log(`  上一行(JSON): ${JSON.stringify(src.slice(prevStart, lineStart - 1))}`);
  const nextEnd = src.indexOf('\n', lineEnd + 1);
  console.log(`  下一行(JSON): ${JSON.stringify(src.slice(lineEnd + 1, nextEnd))}`);
}
