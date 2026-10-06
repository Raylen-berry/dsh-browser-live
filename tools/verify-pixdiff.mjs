// tools/verify-pixdiff.mjs —— PNG 解码与像素比对的验收。
//
// 这类"自己写解码器"的代码，最大的风险是**自证**：用自己的 encode 出图、再用自己的 decode 解回来，
// 全绿但两个都错。所以这里刻意做两件事：
//   ① **与 Node 自己造的已知像素对账**：用 zlib 手工构造 PNG（不经本模块的 encode），
//      看 decode 出来的字节是不是就是当初放进去的；
//   ② **用四种行过滤器各造一张**：PNG 的实际输出会混用 filter，只测 None 等于没测。
import assert from 'node:assert/strict'
import { deflateSync, inflateSync } from 'node:zlib'
import { decodePng, encodePng, readPngHeader, comparePixels, comparePng } from '../pixdiff.js'

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  [' + extra + ']' : '')) }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  [' + extra + ']' : '')) }
}
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got) + (JSON.stringify(got) === JSON.stringify(want) ? '' : ' ≠ ' + JSON.stringify(want)))

// ---- 手工造 PNG（不经过本模块的 encode），可指定每行用哪个 filter ----
function crc32(buf) {
  let c, table = []
  for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); table[n] = c }
  let crc = -1
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ -1) >>> 0
}
function chunk(type, body) {
  const len = Buffer.alloc(4); len.writeUInt32BE(body.length)
  const t = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, body])))
  return Buffer.concat([len, t, body, crc])
}
/** pixels: RGBA 数组（width*height*4）。filterType 决定每行用哪种 filter。 */
function makePng(width, height, pixels, { colorType = 6, filterType = 0 } = {}) {
  const bpp = colorType === 6 ? 4 : 3
  const stride = width * bpp
  const rows = []
  const prev = Buffer.alloc(stride)
  for (let y = 0; y < height; y++) {
    const line = Buffer.alloc(stride)
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 4
      const d = x * bpp
      line[d] = pixels[s]; line[d + 1] = pixels[s + 1]; line[d + 2] = pixels[s + 2]
      if (bpp === 4) line[d + 3] = pixels[s + 3]
    }
    // 按要求的 filter 编码（编码端要做与解码相反的运算）
    const enc = Buffer.alloc(stride)
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp] : 0
      const b = prev[i]
      const c = i >= bpp ? prev[i - bpp] : 0
      switch (filterType) {
        case 0: enc[i] = line[i]; break
        case 1: enc[i] = (line[i] - a) & 0xff; break
        case 2: enc[i] = (line[i] - b) & 0xff; break
        case 3: enc[i] = (line[i] - ((a + b) >> 1)) & 0xff; break
        case 4: {
          const p = a + b - c
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
          const pr = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c)
          enc[i] = (line[i] - pr) & 0xff
          break
        }
      }
    }
    rows.push(Buffer.from([filterType]), enc)
    line.copy(prev)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = colorType; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ---- 1. 表头 ----
console.log('\n— 1. 表头读取 —')
const w = 4, h = 3
const pixels = Buffer.alloc(w * h * 4)
for (let i = 0; i < w * h; i++) {
  pixels[i * 4] = (i * 17) & 0xff
  pixels[i * 4 + 1] = (i * 31) & 0xff
  pixels[i * 4 + 2] = (i * 53) & 0xff
  pixels[i * 4 + 3] = 255
}
const png = makePng(w, h, pixels, { filterType: 0 })
const hdr = readPngHeader(png)
eq('表头宽高', [hdr.width, hdr.height], [4, 3])
eq('表头位深/颜色类型/隔行', [hdr.bitDepth, hdr.colorType, hdr.interlace], [8, 6, 0])

// ---- 2. 四种行过滤器都要能解回来（只测 None 等于没测）----
console.log('\n— 2. 四种行过滤器（Sub/Up/Average/Paeth）—')
for (const ft of [0, 1, 2, 3, 4]) {
  const p = makePng(w, h, pixels, { filterType: ft })
  const d = decodePng(p)
  ok('filter=' + ft + ' 解出的像素与放入的一致', Buffer.compare(d.data, pixels) === 0,
    Buffer.compare(d.data, pixels) === 0 ? '' : '首处差异 @' + (() => { for (let i = 0; i < pixels.length; i++) if (d.data[i] !== pixels[i]) return i; return -1 })())
}

// ---- 3. 颜色类型 2（RGB，无 alpha）----
console.log('\n— 3. 颜色类型 2（RGB）—')
{
  const rgbPixels = Buffer.alloc(w * h * 4)
  for (let i = 0; i < w * h; i++) { rgbPixels[i * 4] = i * 9 & 0xff; rgbPixels[i * 4 + 1] = i * 5 & 0xff; rgbPixels[i * 4 + 2] = i * 3 & 0xff; rgbPixels[i * 4 + 3] = 255 }
  const d = decodePng(makePng(w, h, rgbPixels, { colorType: 2, filterType: 3 }))
  ok('RGB 源解出后 alpha 补 255', Buffer.compare(d.data, rgbPixels) === 0)
}

// ---- 4. 不支持的要**明确报错**，而不是静默给错像素 ----
console.log('\n— 4. 不支持的格式必须报错（不能静默出错像素）—')
{
  const notPng = Buffer.from('hello world, not a png at all..........')
  let threw = false
  try { decodePng(notPng) } catch { threw = true }
  ok('非 PNG 签名被拒', threw)

  // 位深 16：改 IHDR 第 24 字节
  const p16 = Buffer.from(png); p16[24] = 16
  // 注意：改了 IHDR 之后 CRC 就不对了，但我们的实现不校验 CRC（见文件头说明），
  // 所以这里能走到位深判断 —— 正是我们想测的分支
  let t16 = false, msg16 = ''
  try { decodePng(p16) } catch (e) { t16 = true; msg16 = e.message }
  ok('位深 16 被拒且原因明确', t16 && /位深/.test(msg16), msg16)

  // 隔行：改 IHDR 第 28 字节
  const pi = Buffer.from(png); pi[28] = 1
  let ti = false, msgi = ''
  try { decodePng(pi) } catch (e) { ti = true; msgi = e.message }
  ok('隔行被拒且原因明确', ti && /隔行/.test(msgi), msgi)

  // 颜色类型 3（调色板）不支持
  const pc = Buffer.from(png); pc[25] = 3
  let tc = false, msgc = ''
  try { decodePng(pc) } catch (e) { tc = true; msgc = e.message }
  ok('调色板 PNG 被拒且原因明确', tc && /颜色类型/.test(msgc), msgc)
}

// ---- 5. encode/decode 往返 ----
console.log('\n— 5. encode → decode 往返 —')
{
  const decoded = decodePng(png)
  const re = encodePng(decoded)
  const back = decodePng(re)
  ok('往返后像素不变', Buffer.compare(back.data, pixels) === 0)
  ok('往返后尺寸不变', back.width === w && back.height === h)
  eq('往返后编码结果能再被表头读出', [readPngHeader(re).width, readPngHeader(re).height], [w, h])
}

// ---- 6. 比对：相同 / 尺寸不同 / 容差 / 差异图 ----
console.log('\n— 6. 像素比对 —')
{
  const a = decodePng(png)
  const same = comparePixels(a, decodePng(png))
  ok('同一张图 ⇒ same=true, diff=0', same.same === true && same.diff === 0, 'diff=' + same.diff)

  // 尺寸不同必须判为不同，且不能被"裁到小的那张"蒙混过去
  const biggerPixels = Buffer.alloc((w + 1) * h * 4, 255)
  const b2 = decodePng(makePng(w + 1, h, biggerPixels))
  const mism = comparePixels(a, b2)
  ok('尺寸不同 ⇒ same=false 且标记 sizeMismatch', mism.same === false && mism.sizeMismatch === true, JSON.stringify({ wA: mism.widthA, wB: mism.widthB }))

  // 改一个像素的绿通道 +3：tolerance=0 应判不同，tolerance=3 应判相同，tolerance=2 应判不同
  const tweaked = Buffer.from(pixels)
  tweaked[5] = (tweaked[5] + 3) & 0xff
  const t0 = comparePng(png, makePng(w, h, tweaked))
  ok('tolerance=0：1 个像素差 3 也被抓出', t0.same === false && t0.diff === 1, 'diff=' + t0.diff)
  const t3 = comparePng(png, makePng(w, h, tweaked), { tolerance: 3 })
  ok('tolerance=3：该差异被容忍', t3.same === true, 'maxChannelDelta=' + t3.maxChannelDelta)
  const t2 = comparePng(png, makePng(w, h, tweaked), { tolerance: 2 })
  ok('tolerance=2：该差异仍被抓出', t2.same === false, 'maxChannelDelta=' + t2.maxChannelDelta)

  // maxDiffRatio：12 个像素里差 1 个 = 8.3%
  const r5 = comparePng(png, makePng(w, h, tweaked), { maxDiffRatio: 0.05 })
  ok('maxDiffRatio=5%：8.3% 差异被判不同', r5.same === false, (r5.ratio * 100).toFixed(1) + '%')
  const r20 = comparePng(png, makePng(w, h, tweaked), { maxDiffRatio: 0.2 })
  ok('maxDiffRatio=20%：8.3% 差异被判相同', r20.same === true, (r20.ratio * 100).toFixed(1) + '%')

  // 差异图：有差异处涂红，无差异处暗化
  ok('差异图尺寸与源一致', t0.diffImage.width === w && t0.diffImage.height === h)
  ok('差异图在差异像素处是红色', t0.diffImage.data[4] === 255 && t0.diffImage.data[5] === 0 && t0.diffImage.data[6] === 0)
  ok('差异图在非差异像素处不是红色', !(t0.diffImage.data[0] === 255 && t0.diffImage.data[1] === 0 && t0.diffImage.data[2] === 0))

  // ignoreAlpha：只差 alpha 时，忽略后应判相同
  const alphaOnly = Buffer.from(pixels); alphaOnly[3] = 128
  const ign = comparePng(png, makePng(w, h, alphaOnly), { ignoreAlpha: true })
  ok('ignoreAlpha：只差 alpha ⇒ 相同', ign.same === true)
  const noIgn = comparePng(png, makePng(w, h, alphaOnly), { ignoreAlpha: false })
  ok('不忽略 alpha：只差 alpha ⇒ 不同', noIgn.same === false)
}

// ---- 7. 真实体量（浏览器截图是几 MB，不能爆栈/太慢）----
console.log('\n— 7. 真实体量 —')
{
  const W = 800, H = 600
  const big = Buffer.alloc(W * H * 4)
  for (let i = 0; i < W * H; i++) {
    big[i * 4] = i & 0xff; big[i * 4 + 1] = (i >> 8) & 0xff; big[i * 4 + 2] = (i >> 16) & 0xff; big[i * 4 + 3] = 255
  }
  const bigPng = makePng(W, H, big, { filterType: 4 })
  const t0 = Date.now()
  const d = decodePng(bigPng)
  const tDecode = Date.now() - t0
  ok('800×600 解码正确', Buffer.compare(d.data, big) === 0)
  ok('800×600 解码在 3 秒内', tDecode < 3000, tDecode + 'ms')
  const t1 = Date.now()
  comparePixels(d, decodePng(bigPng))
  ok('800×600 比对在 3 秒内', Date.now() - t1 < 3000, (Date.now() - t1) + 'ms')
}

console.log('\n像素比对底座：' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail === 0 ? 0 : 1)