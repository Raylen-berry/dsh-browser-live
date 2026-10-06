// pixdiff.js —— 零依赖 PNG 解码 + 像素比对（dsh-browser-live 的视觉回归底座）
//
// 为什么自己写：本插件的铁律是**零裸依赖**（见 README「零 vendored 运行时」），
// 而像素比对只需要 PNG 的一个子集。Node 内置的 zlib 已经能解 PNG 的压缩流，
// 剩下的只是 unfilter —— 一百多行，不值得为此引一个图像库。
//
// 支持的 PNG 子集（浏览器截图的实际输出都落在这里）：
//   · 位深 8
//   · 颜色类型 2 (truecolor RGB) / 6 (truecolor+alpha RGBA) / 0 (grayscale) / 4 (gray+alpha)
//   · 非隔行（interlace 0）
// 不支持的会**明确报错**（而不是静默给出错像素）—— 视觉回归最怕的就是"比对通过了但其实没比"。

import { inflateSync } from 'node:zlib'

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** 读 PNG 的 IHDR，返回宽高与格式信息（不解像素，用于快速判断尺寸）。 */
export function readPngHeader(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 33) throw new Error('不是有效的 PNG：太短')
  if (!buf.subarray(0, 8).equals(PNG_SIG)) throw new Error('不是有效的 PNG：签名不对')
  const width = buf.readUInt32BE(16)
  const height = buf.readUInt32BE(20)
  const bitDepth = buf[24]
  const colorType = buf[25]
  const interlace = buf[28]
  return { width, height, bitDepth, colorType, interlace }
}

/**
 * 解码 PNG → { width, height, channels, data }，data 是 RGBA 8bit（每像素 4 字节）。
 * 统一输出 RGBA，比对逻辑就不用管来源格式了。
 */
export function decodePng(buf) {
  const { width, height, bitDepth, colorType, interlace } = readPngHeader(buf)
  if (bitDepth !== 8) throw new Error('只支持位深 8 的 PNG，收到 ' + bitDepth)
  if (interlace !== 0) throw new Error('不支持隔行 PNG（interlace=' + interlace + '）')
  const srcChannels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType]
  if (!srcChannels) throw new Error('不支持的颜色类型 ' + colorType + '（支持 0/2/4/6）')

  // ---- 收集 IDAT 并把它们拼起来（PNG 允许 IDAT 分片）----
  const idat = []
  let off = 8
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    const dataStart = off + 8
    const dataEnd = dataStart + len
    if (dataEnd + 4 > buf.length) throw new Error('PNG 结构损坏：块长度越界')
    if (type === 'IDAT') idat.push(buf.subarray(dataStart, dataEnd))
    else if (type === 'IEND') break
    off = dataEnd + 4 // 跳过 CRC
  }
  if (!idat.length) throw new Error('PNG 里没有 IDAT（没有像素数据）')

  const raw = inflateSync(Buffer.concat(idat))
  const bpp = srcChannels // 位深 8 ⇒ 每像素字节数 == 通道数
  const stride = width * bpp
  const expected = height * (stride + 1) // 每行前面有 1 字节 filter
  if (raw.length < expected) throw new Error('解压后的像素数据不完整：' + raw.length + ' < ' + expected)

  // ---- 逐行 unfilter（PNG 规范 9.2）----
  const out = Buffer.alloc(width * height * 4)
  const line = Buffer.alloc(stride)
  const prev = Buffer.alloc(stride)
  let p = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[p]; p += 1
    raw.copy(line, 0, p, p + stride); p += stride
    switch (filter) {
      case 0: break // None
      case 1: for (let i = bpp; i < stride; i++) line[i] = (line[i] + line[i - bpp]) & 0xff; break // Sub
      case 2: for (let i = 0; i < stride; i++) line[i] = (line[i] + prev[i]) & 0xff; break // Up
      case 3: for (let i = 0; i < stride; i++) { const a = i >= bpp ? line[i - bpp] : 0; line[i] = (line[i] + ((a + prev[i]) >> 1)) & 0xff } break // Average
      case 4: for (let i = 0; i < stride; i++) { // Paeth
        const a = i >= bpp ? line[i - bpp] : 0
        const b = prev[i]
        const c = i >= bpp ? prev[i - bpp] : 0
        const pp = a + b - c
        const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c)
        const pr = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c)
        line[i] = (line[i] + pr) & 0xff
      } break
      default: throw new Error('未知的行过滤器 ' + filter + '（第 ' + y + ' 行）')
    }
    // ---- 转成 RGBA ----
    for (let x = 0; x < width; x++) {
      const s = x * bpp, d = (y * width + x) * 4
      if (srcChannels === 1) { out[d] = out[d + 1] = out[d + 2] = line[s]; out[d + 3] = 255 }
      else if (srcChannels === 2) { out[d] = out[d + 1] = out[d + 2] = line[s]; out[d + 3] = line[s + 1] }
      else if (srcChannels === 3) { out[d] = line[s]; out[d + 1] = line[s + 1]; out[d + 2] = line[s + 2]; out[d + 3] = 255 }
      else { out[d] = line[s]; out[d + 1] = line[s + 1]; out[d + 2] = line[s + 2]; out[d + 3] = line[s + 3] }
    }
    line.copy(prev)
  }
  return { width, height, channels: 4, data: out }
}

/** 把 RGBA 解码结果编回 PNG（用于产出差异图给人看）。 */
export function encodePng({ width, height, data }) {
  const stride = width * 4
  const raw = Buffer.alloc(height * (stride + 1))
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0 // filter None：简单优先，差异图不追求体积
    data.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride)
  }
  const deflated = deflateSync(raw)
  const chunk = (type, body) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(body.length)
    const t = Buffer.from(type, 'ascii')
    const crcBuf = Buffer.concat([t, body])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(crcBuf) >>> 0)
    return Buffer.concat([len, t, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  return Buffer.concat([PNG_SIG, chunk('IHDR', ihdr), chunk('IDAT', deflated), chunk('IEND', Buffer.alloc(0))])
}

import { deflateSync } from 'node:zlib'

// CRC32（PNG 规范要求的那个）
let CRC_TABLE = null
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
      CRC_TABLE[n] = c
    }
  }
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

/**
 * 比对两张解码后的图。返回统计与差异图数据（不写盘，由调用方决定）。
 *
 *   tolerance   每个通道允许的差（0 = 逐字节相同）；默认 0
 *   ignoreAlpha 忽略 alpha 通道
 *   maxDiffRatio 允许的差异像素比例上限（默认 0 = 必须完全一致）
 */
export function comparePixels(a, b, { tolerance = 0, ignoreAlpha = false, maxDiffRatio = 0 } = {}) {
  if (a.width !== b.width || a.height !== b.height) {
    return {
      same: false, sizeMismatch: true, widthA: a.width, heightA: a.height, widthB: b.width, heightB: b.height,
      total: 0, diff: 0, ratio: 1,
    }
  }
  const total = a.width * a.height
  let diff = 0
  let maxChannelDelta = 0
  let sumDelta = 0
  const diffImage = Buffer.alloc(a.data.length)
  for (let i = 0; i < total; i++) {
    const o = i * 4
    const dr = Math.abs(a.data[o] - b.data[o])
    const dg = Math.abs(a.data[o + 1] - b.data[o + 1])
    const db = Math.abs(a.data[o + 2] - b.data[o + 2])
    const da = ignoreAlpha ? 0 : Math.abs(a.data[o + 3] - b.data[o + 3])
    const worst = Math.max(dr, dg, db, da)
    if (worst > maxChannelDelta) maxChannelDelta = worst
    sumDelta += dr + dg + db + da
    const isDiff = worst > tolerance
    if (isDiff) diff++
    // 差异图：有差异的地方涂红（保持 alpha），没差异的地方用原图的暗淡版本
    if (isDiff) { diffImage[o] = 255; diffImage[o + 1] = 0; diffImage[o + 2] = 0; diffImage[o + 3] = 255 }
    else {
      diffImage[o] = a.data[o] >> 2; diffImage[o + 1] = a.data[o + 1] >> 2
      diffImage[o + 2] = a.data[o + 2] >> 2; diffImage[o + 3] = 255
    }
  }
  const ratio = total === 0 ? 0 : diff / total
  return {
    same: ratio <= maxDiffRatio,
    sizeMismatch: false,
    width: a.width, height: a.height, total, diff, ratio,
    maxChannelDelta,
    meanChannelDelta: total === 0 ? 0 : sumDelta / (total * 4),
    diffImage: { width: a.width, height: a.height, data: diffImage },
  }
}

/** 便捷入口：直接吃两个 PNG Buffer。 */
export function comparePng(b1, b2, opts) {
  return comparePixels(decodePng(b1), decodePng(b2), opts)
}

// ---------------------------------------------------------------- 缩放：跨 DPI 比对

/**
 * 把图缩放到目标尺寸（双线性插值）。
 *
 * 为什么需要：截图是**设备像素**，同一页面在 devicePixelRatio=1 与 1.25 下宽高差 25%
 * （实测本机 dpr=1.1667 ⇒ 1418 CSS px 的视口截出 1654 px）。不归一化的话，跨机器/跨 DPI
 * 的基准直接判 sizeMismatch，比对无效。
 *
 * 为什么是双线性而不是最近邻：最近邻在缩放时会丢细线、产生锯齿，让"其实没变"的两张图
 * 出现成片差异。双线性对轻微缩放更宽容，但**对真实回归仍然敏感**（整块颜色变了照样抓得到）。
 * 这是视觉回归工具，不是图像处理库 —— 够用即可，不引依赖。
 */
export function resizePixels(img, targetW, targetH) {
  const { width: sw, height: sh, data: src } = img
  if (sw === targetW && sh === targetH) return img
  const out = Buffer.alloc(targetW * targetH * 4)
  const xRatio = sw / targetW
  const yRatio = sh / targetH
  for (let y = 0; y < targetH; y++) {
    // 双线性：取源图上的浮点位置，再对 4 个邻居加权
    const sy = Math.min(sh - 1, Math.max(0, (y + 0.5) * yRatio - 0.5))
    const y0 = Math.floor(sy), y1 = Math.min(sh - 1, y0 + 1)
    const fy = sy - y0
    for (let x = 0; x < targetW; x++) {
      const sx = Math.min(sw - 1, Math.max(0, (x + 0.5) * xRatio - 0.5))
      const x0 = Math.floor(sx), x1 = Math.min(sw - 1, x0 + 1)
      const fx = sx - x0
      const d = (y * targetW + x) * 4
      for (let c = 0; c < 4; c++) {
        const p00 = src[(y0 * sw + x0) * 4 + c]
        const p10 = src[(y0 * sw + x1) * 4 + c]
        const p01 = src[(y1 * sw + x0) * 4 + c]
        const p11 = src[(y1 * sw + x1) * 4 + c]
        const top = p00 + (p10 - p00) * fx
        const bot = p01 + (p11 - p01) * fx
        out[d + c] = Math.round(top + (bot - top) * fy)
      }
    }
  }
  return { width: targetW, height: targetH, channels: 4, data: out }
}

/**
 * 跨 DPI 比对：把两张图都归一到**同一个规范尺寸**再比。
 *
 * 归一目标取两图尺寸的较大者（避免把细节缩掉）。若两图尺寸本来就相同，退化为普通比对。
 * 返回里带上 scaledFrom，让调用方知道"这次比的是缩放后的图"，不会被误当成原尺寸结论。
 */
export function comparePngScaled(b1, b2, opts = {}) {
  const a = decodePng(b1), b = decodePng(b2)
  if (a.width === b.width && a.height === b.height) {
    const r = comparePixels(a, b, opts)
    return { ...r, scaled: false }
  }
  const W = Math.max(a.width, b.width)
  const H = Math.max(a.height, b.height)
  const ra = resizePixels(a, W, H)
  const rb = resizePixels(b, W, H)
  const r = comparePixels(ra, rb, opts)
  return {
    ...r,
    scaled: true,
    scaledFrom: { a: { width: a.width, height: a.height }, b: { width: b.width, height: b.height } },
    normalizedTo: { width: W, height: H },
  }
}

/** 便捷入口：吃两个 PNG 文件 Buffer，尺寸不同时自动归一（跨 DPI 场景用这个）。 */
export function comparePngEither(b1, b2, opts = {}) {
  return opts.allowScale === false ? comparePng(b1, b2, opts) : comparePngScaled(b1, b2, opts)
}