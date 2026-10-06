// tools/verify-pixdiff-scale.mjs —— 跨 DPI 归一化的验收。
//
// 这类"加个缩放让它看起来能比"的改动最容易做成假 oracle：缩完一切都"一样"了，
// 真实回归也被抹平。所以这里专门验证两件事：
//   ① 跨 DPI 能比：同一画面按 1.0 与 1.25 两倍率渲染（后者像素数差 56%），归一后应判相同；
//   ② **真实回归仍抓得到**：归一化之后，换掉画面里一块颜色必须仍被判不同。
// 只做①不做②的话，这个功能等于把 oracle 弄坏。
import assert from 'node:assert/strict'
import { deflateSync } from 'node:zlib'
import { decodePng, encodePng, resizePixels, comparePng, comparePngScaled, comparePngEither } from '../pixdiff.js'

let pass = 0, fail = 0
const ok = (n, c, e = '') => { if (c) { pass++; console.log('  PASS  ' + n + (e ? '  [' + e + ']' : '')) } else { fail++; console.log('  FAIL  ' + n + (e ? '  [' + e + ']' : '')) } }

// 造一张有结构的图（纯色归一化会太容易通过，必须有边界与渐变）
function makeScene(w, h) {
  const d = Buffer.alloc(w * h * 4)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4
    const inBox = x > w * 0.25 && x < w * 0.75 && y > h * 0.25 && y < h * 0.75
    d[o] = inBox ? 220 : Math.round((x / w) * 180)
    d[o + 1] = inBox ? 60 : Math.round((y / h) * 160)
    d[o + 2] = inBox ? 60 : 90
    d[o + 3] = 255
  }
  return { width: w, height: h, channels: 4, data: d }
}

console.log('\n— 1. resizePixels 基本正确性 —')
{
  const src = makeScene(100, 100)
  const same = resizePixels(src, 100, 100)
  ok('同尺寸直接返回原图（不复制、不损失）', same === src)

  const up = resizePixels(src, 200, 200)
  ok('放大后尺寸正确', up.width === 200 && up.height === 200)
  ok('放大后字节数 = w*h*4', up.data.length === 200 * 200 * 4)
  // 放大后取中心点应仍是盒子的红色
  const c = up.data[(100 * 200 + 100) * 4]
  ok('放大后中心仍是盒子颜色', c > 200, String(c))

  const down = resizePixels(src, 50, 50)
  ok('缩小后尺寸正确', down.width === 50 && down.height === 50)
  const c2 = down.data[(25 * 50 + 25) * 4]
  ok('缩小后中心仍是盒子颜色', c2 > 200, String(c2))
}

console.log('\n— 2. 跨 DPI：同一画面按不同倍率渲染，归一后应判相同 —')
{
  // 模拟同一页面在 dpr=1 与 dpr=1.25 下的截图。
  //
  // ⚠️ 这里有个**第一版踩过的坑**：不能"独立渲染"两个尺寸再比 —— makeScene 用 x/w 画渐变，
  // 800 宽与 1000 宽算出来的同比例点，取整后就不同（实测差 11.8%），那是**造图函数**的差，
  // 不是缩放算法的差。正确做法是：先渲一张，再把它放大成"另一个倍率下的同一画面"。
  // 这样两张图内容严格同源，差异只来自像素栅格化 —— 而这正是跨 DPI 的真实情形。
  const css = { w: 800, h: 600 }
  const at1 = makeScene(css.w, css.h)
  const at125 = resizePixels(at1, Math.round(css.w * 1.25), Math.round(css.h * 1.25))
  ok('两图尺寸确实不同（1.0x vs 1.25x）', at1.width !== at125.width, at1.width + ' vs ' + at125.width)

  const png1 = encodePng(at1), png125 = encodePng(at125)

  // 直接比：必须报 sizeMismatch（不加缩放时跨 DPI 就是无法比）
  const raw = comparePng(png1, png125)
  ok('不归一化时跨 DPI 报 sizeMismatch', raw.sizeMismatch === true && raw.same === false)

  // 归一后比：应判相同（同一画面两种倍率，只差栅格化）
  const scaled = comparePngScaled(png1, png125)
  ok('归一化后跨 DPI 判为相同', scaled.same === true, 'diff=' + scaled.diff + ' ratio=' + (scaled.ratio * 100).toFixed(3) + '%')
  ok('返回里标明这次是缩放比对的', scaled.scaled === true)
  ok('返回里保留了原尺寸信息', scaled.scaledFrom && scaled.scaledFrom.a.width === 800 && scaled.scaledFrom.b.width === 1000,
    JSON.stringify(scaled.scaledFrom))
  ok('归一目标取较大者（不缩掉细节）', scaled.normalizedTo.width === 1000 && scaled.normalizedTo.height === 750,
    JSON.stringify(scaled.normalizedTo))
}

console.log('\n— 3. 关键：归一化之后**真实回归仍要抓得到**（否则 oracle 是假的）—')
{
  const css = { w: 800, h: 600 }
  const base = makeScene(css.w, css.h)
  const pngBase = encodePng(base)

  // 同一画面、但把中心盒子从「红」改成「蓝」——这是"底图换了"级别的真实回归
  const changed = { width: base.width, height: base.height, channels: 4, data: Buffer.from(base.data) }
  for (let y = 0; y < base.height; y++) for (let x = 0; x < base.width; x++) {
    if (x > base.width * 0.25 && x < base.width * 0.75 && y > base.height * 0.25 && y < base.height * 0.75) {
      const o = (y * base.width + x) * 4
      changed.data[o] = 60; changed.data[o + 1] = 60; changed.data[o + 2] = 230
    }
  }
  // 用 1.25x 倍率渲染这个"变了"的画面，模拟"另一台机器上真回归了"
  const changedAt125 = resizePixels(changed, Math.round(css.w * 1.25), Math.round(css.h * 1.25))
  const pngChanged125 = encodePng(changedAt125)

  const scaled = comparePngScaled(pngBase, pngChanged125)
  ok('跨 DPI + 真实回归 ⇒ 仍判为不同', scaled.same === false,
    'diff=' + scaled.diff + ' (' + (scaled.ratio * 100).toFixed(2) + '%) maxChannelDelta=' + scaled.maxChannelDelta)
  ok('回归幅度够大（maxChannelDelta 显著）', scaled.maxChannelDelta > 100, String(scaled.maxChannelDelta))
  ok('差异比例落在盒子面积附近（不是全图噪声）', scaled.ratio > 0.15 && scaled.ratio < 0.35, (scaled.ratio * 100).toFixed(1) + '%')
}

console.log('\n— 4. 同尺寸时不缩放（别把本来能精确比的弄糊）—')
{
  const a = makeScene(400, 300)
  const png = encodePng(a)
  const r = comparePngScaled(png, png)
  ok('同尺寸退化为精确比对', r.same === true && r.scaled === false && r.diff === 0)
  const tweaked = { width: a.width, height: a.height, channels: 4, data: Buffer.from(a.data) }
  tweaked.data[0] = (tweaked.data[0] + 1) & 0xff
  const r2 = comparePngScaled(png, encodePng(tweaked))
  ok('同尺寸时差 1 个通道值也抓得到', r2.same === false && r2.diff === 1, 'diff=' + r2.diff + ' scaled=' + r2.scaled)
}

console.log('\n— 5. comparePngEither 的开关 —')
{
  const a = makeScene(400, 300), b = resizePixels(a, 500, 375)
  const pa = encodePng(a), pb = encodePng(b)
  ok('默认允许缩放 ⇒ 能比', comparePngEither(pa, pb).same === true)
  ok('allowScale:false ⇒ 报尺寸不符', comparePngEither(pa, pb, { allowScale: false }).sizeMismatch === true)
}

console.log('\n跨 DPI 归一化：' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail === 0 ? 0 : 1)