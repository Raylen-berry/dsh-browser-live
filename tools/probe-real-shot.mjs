// 真机检验：拿浏览器真实产出的截图跑解码与比对（不是手工构造的 PNG）。
import { readFileSync } from 'node:fs'
import { decodePng, comparePng, readPngHeader, comparePixels } from '../pixdiff.js'

const shot = process.argv[2]
if (!shot) { console.error('用法: node tools/probe-real-shot.mjs <截图路径>'); process.exit(2) }

let pass = 0, fail = 0
const ok = (n, c, e = '') => { if (c) { pass++; console.log('  PASS  ' + n + (e ? '  [' + e + ']' : '')) } else { fail++; console.log('  FAIL  ' + n + (e ? '  [' + e + ']' : '')) } }

const buf = readFileSync(shot)
const h = readPngHeader(buf)
console.log('  表头: ' + h.width + '×' + h.height + ' depth=' + h.bitDepth + ' colorType=' + h.colorType + ' interlace=' + h.interlace)
ok('浏览器产出的 PNG 落在我支持的子集里（位深8 / 非隔行 / 颜色类型 0,2,4,6）',
  h.bitDepth === 8 && h.interlace === 0 && [0, 2, 4, 6].includes(h.colorType),
  'depth=' + h.bitDepth + ' interlace=' + h.interlace + ' colorType=' + h.colorType)

const d = decodePng(buf)
console.log('  解码: ' + d.width + '×' + d.height + ' channels=' + d.channels + ' 字节=' + d.data.length + ' (期望 ' + (d.width * d.height * 4) + ')')
ok('解码后的字节数 = 宽×高×4', d.data.length === d.width * d.height * 4)

// 自比必须完全一致 —— 这是"比对真的在比"的最基本证据
const self = comparePixels(d, decodePng(buf))
ok('自比 same=true 且 diff=0', self.same === true && self.diff === 0, 'diff=' + self.diff + '/' + self.total)

// 取像素看颜色。**不要假设红块在哪**：写这条探针时我假设"左上白、中间红"，实测左上就是红的
// （页面里那个盒子从视口原点开始）。所以这里改成：统计红/白占比，并与"盒子设备像素数"对账。
const px = (x, y) => { const o = (y * d.width + x) * 4; return [d.data[o], d.data[o + 1], d.data[o + 2]] }
console.log('  左上(2,2) = ' + JSON.stringify(px(2, 2)) + '   右下 = ' + JSON.stringify(px(d.width - 3, d.height - 3)))

let red = 0, white = 0
for (let i = 0; i < d.width * d.height; i++) {
  const o = i * 4
  const r = d.data[o], g = d.data[o + 1], b = d.data[o + 2]
  if (r > 200 && g < 100 && b < 100) red++
  else if (r > 200 && g > 200 && b > 200) white++
}
const tot = d.width * d.height
console.log('  红=' + (red / tot * 100).toFixed(1) + '%  白=' + (white / tot * 100).toFixed(1) + '%')
ok('画面由红块 + 白底构成（没有第三种颜色，说明解码没串通道）', red + white === tot, '红' + red + ' + 白' + white + ' =?' + tot)
ok('红块占比在合理区间（页面里确实有个盒子）', red > 0 && red < tot, (red / tot * 100).toFixed(1) + '%')

// 造一个真实差异。这一页只有两个红色值（221 与 255），所以必须挑一个**两档都不饱和**的增量：
// +40 对 221 会饱和到 255（实际只差 34），对 255 更是纹丝不动 —— 实测 touched=0。
// 增量取 +20：221→241（不饱和）、255→255（饱和，跳过）。这样被改动的像素必然精确差 20。
const DELTA = 20
const tweaked = { width: d.width, height: d.height, channels: 4, data: Buffer.from(d.data) }
let touched = 0
for (let i = 0; i < tweaked.data.length; i += 4) {
  if (tweaked.data[i] + DELTA <= 255) { tweaked.data[i] += DELTA; touched++ }
}
const td = comparePixels(d, tweaked)
ok('在未饱和像素上 +' + DELTA + ' ⇒ 被抓出（tolerance=0）', td.same === false, 'diff=' + td.diff + '/' + td.total + ' touched=' + touched)
ok('maxChannelDelta 精确等于 ' + DELTA + '（这些像素不会饱和）', td.maxChannelDelta === DELTA, String(td.maxChannelDelta))
ok('差异像素数 = 被改动的像素数', td.diff === touched, td.diff + ' vs ' + touched)

// 差异图必须能编码回 PNG 且能被自己解回来（闭合）
const { encodePng } = await import('../pixdiff.js')
const reenc = encodePng(td.diffImage)
const redecode = decodePng(reenc)
ok('差异图 encode→decode 闭合', Buffer.compare(redecode.data, td.diffImage.data) === 0)
ok('差异图尺寸与源一致', redecode.width === d.width && redecode.height === d.height)

// 性能：真机截图的体量
const t0 = Date.now()
decodePng(buf)
const ms = Date.now() - t0
ok('解码在 1 秒内', ms < 1000, ms + 'ms')

console.log('\n真机截图检验：' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail === 0 ? 0 : 1)
