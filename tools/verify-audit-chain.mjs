// dsh-browser-live · 校验真实留痕文件的哈希链
// 用法：
//   node tools/verify-audit-chain.mjs                 # 校验 $DSH_HOME/dsh-browser-live/audit 下所有文件
//   node tools/verify-audit-chain.mjs <文件或目录>     # 校验指定路径
//   DSH_HOME=... node tools/verify-audit-chain.mjs    # 换 home
// 退出码：0 = 链完整（或"还没有留痕可校验"，见下）；1 = 有断链 / 你显式给的路径不存在。
// 注意：本脚本会被 npm test 调用，所以**默认路径**下"还没有任何留痕"必须算通过
// （新机器上跑测试不该因为"还没用过浏览器"而红）；但你显式传了路径却找不到，那就是错的。
import { readdirSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { verifyChain } from '../audit.js'

const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const defDir = path.join(dshHome, 'dsh-browser-live', 'audit')
const explicit = process.argv[2]
const target = explicit || defDir

let files
try {
  files = statSync(target).isDirectory()
    ? readdirSync(target).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(target, f))
    : [target]
} catch (e) {
  const why = '读不到 ' + target + ' —— ' + String(e.message || e)
  if (!explicit) {
    console.log('（' + why + '；默认路径下还没有留痕可校验，跳过——留痕是 host 插件启动后、agent 第一次调用 browser_* 工具时才开始写）')
    process.exit(0)
  }
  console.error(why)
  process.exit(1)
}
if (!files.length) {
  if (!explicit) { console.log('（' + target + ' 里还没有 .jsonl 留痕，跳过）'); process.exit(0) }
  console.error('目录里还没有 .jsonl 留痕：' + target)
  process.exit(1)
}

let bad = 0
for (const f of files.sort()) {
  const v = verifyChain(f)
  const size = statSync(f).size
  if (v.ok) console.log(`PASS ${path.basename(f)}  ${v.records} 条 · ${size} 字节 · 链完整`)
  else { bad++; console.error(`FAIL ${path.basename(f)}  断在第 ${v.brokenAt || '?'} 行：${v.reason}`) }
}
if (bad) { console.error('\n有 ' + bad + ' 个文件的留痕链被破坏（删过行或改过内容）。'); process.exit(1) }
console.log('\n全部 ' + files.length + ' 个留痕文件链完整。')
console.log('说明：链完整只代表"没有删行/改行"；拥有完整写权限的人重算整条链是可以伪造的 —— 见 audit.js 顶部的能力边界。')
