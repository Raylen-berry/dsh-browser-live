// 离线校验 dsh-browser-live host 里 VIEW_PAGE 的内联 <script> 是否语法正确。
// 做法：从 index.js 源文本里抠出 `const VIEW_PAGE = [ ... ].join('\n')` 数组并 eval，
// 再取 <script>…</script> 之间内容交给 new Function() 解析（只解析不执行）。
import { readFileSync, writeFileSync } from 'node:fs'

const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
const start = src.indexOf('const VIEW_PAGE = [')
if (start < 0) { console.error('VIEW_PAGE 未找到'); process.exit(1) }
const endMark = "].join('\\n')\n"
const end = src.indexOf(endMark, start)
if (end < 0) { console.error('VIEW_PAGE 结尾未找到'); process.exit(1) }
const arrSrc = src.slice(start + 'const VIEW_PAGE = '.length, end + 1)
const html = eval(arrSrc).join('\n')   // 与 index.js 里的 ].join('\n') 保持一致

const m = String(html).match(/<script>([\s\S]*?)<\/script>/)
if (!m) { console.error('页面里没有 <script> 块'); process.exit(1) }
const js = m[1]
try {
  new Function(js)
  console.log('VIEW_PAGE script 语法 OK，长度', js.length)
} catch (e) {
  console.error('VIEW_PAGE script 语法错误:', e.message)
  writeFileSync(new URL('./view-script.js', import.meta.url), js, 'utf8')
  console.error('已把页面 JS 落到 tools/view-script.js 方便定位')
  process.exit(2)
}
const opens = (String(html).match(/<div/g) || []).length
const closes = (String(html).match(/<\/div>/g) || []).length
console.log('div 开/闭:', opens, closes, opens === closes ? 'OK' : '不配对')
