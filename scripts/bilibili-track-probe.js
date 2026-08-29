// MomentQ 独立验证脚本 —— B 站登录态「无字幕轨视频」是否返回毒轨
// 用法：登录 B 站后，打开任意 bilibili.com 页面 → F12 控制台 → 粘贴整段 → 回车。
// 不依赖任何扩展代码，只调用 B 站公开 web 接口（带你的登录 Cookie）。
// 判定标准：字幕轨的 max(end) 超过视频时长 → 物理不可能属于该视频 → 毒轨。

const TEST_CASES = [
  // 已知「无字幕轨」的 CSAPP 课程视频（此前观察过串台）
  'BV1cD4y1D7uR', // 1-1 计算机系统漫游
  'BV115411h72j', // 1-2 计算机系统漫游
  'BV1mi4y137g8', // 1-3 计算机系统漫游
  'BV1DK4y1Y7Yi', // 2-1 信息的存储(下)
  // 对照组：有真实字幕轨、从未出错的视频
  'BV1vW8y68E7C', // 彩礼越高，文明程度越低
]
// 想加别的视频，往上面数组里塞 BV 号即可；也可以直接 PROBE_ONLY = ['BVxxxx'] 只测指定的。

const PROBE_ONLY = [] // 例: ['BV1xx411c7mD']

const api = async (path) => {
  const r = await fetch(`https://api.bilibili.com${path}`, { credentials: 'include' })
  if (!r.ok) throw new Error(`HTTP ${r.status} ${path}`)
  return r.json()
}

const verdict = (rows, duration) => {
  if (rows.length === 0) return '—（无轨）'
  const maxEnd = Math.max(...rows.map(x => Number(x.to) || 0))
  const ratio = (maxEnd / duration).toFixed(3)
  // 容差 max(5s, 2%)，与"字幕时间轴不可能超过媒体时长"的物理约束一致
  const poisoned = maxEnd > duration + Math.max(5, duration * 0.02)
  return poisoned
    ? `☠ 毒轨（max=${maxEnd}s > 视频时长=${duration}s，比值 ${ratio}）`
    : `✓ 正常（max=${maxEnd}s ≤ 时长 ${duration}s，比值 ${ratio}）`
}

const trackBody = async (url) => {
  try {
    // 字幕 CDN 不需要 Cookie；带 credentials 反而被 CORS 拦下
    const r = await fetch(url.startsWith('//') ? `https:${url}` : url, { credentials: 'omit' })
    if (!r.ok) return null
    const j = await r.json()
    return Array.isArray(j?.body) ? j.body : []
  } catch { return null } // 拉不下内容（403/404）也如实标注
}

const run = async () => {
  const list = (PROBE_ONLY.length > 0 ? PROBE_ONLY : TEST_CASES)
  for (const bvid of list) {
    const view = await api(`/x/web-interface/view?bvid=${bvid}`)
    if (view.code !== 0) { console.log(`\n■ ${bvid} view 失败: ${view.code} ${view.message}`); continue }
    const d = view.data
    console.log(`\n■ ${bvid} 《${d.title}》 时长=${d.duration}s 分P=${d.pages.length}`)
    for (const page of d.pages) {
      const cid = page.cid
      for (const endpoint of ['/x/player/wbi/v2', '/x/player/v2']) {
        const res = await api(`${endpoint}?bvid=${bvid}&cid=${cid}`)
        if (res.code !== 0) { console.log(`  P${page.page} ${endpoint} → code=${res.code}`); continue }
        const payload = res.data
        // 确认响应身份回显（若不匹配本身就是重要发现）
        const echo = `回显 bvid=${payload.bvid} cid=${payload.cid}${payload.bvid === bvid && String(payload.cid) === String(cid) ? '' : '  ⚠ 与请求不一致!'}`;
        const subs = payload?.subtitle?.subtitles ?? []
        if (subs.length === 0) {
          console.log(`  P${page.page}(${cid}) ${endpoint} → 无轨；need_login=${payload.subtitle?.need_login_subtitle ?? '?'}；${echo}`)
          continue
        }
        console.log(`  P${page.page}(${cid}) ${endpoint} → ${subs.length} 条轨；${echo}`)
        for (const t of subs) {
          const body = await trackBody(t.subtitle_url)
          const v = body === null ? '？内容拉取失败' : verdict(body, d.duration)
          console.log(`     · [${t.lan}] ${t.lan_doc} ai_type=${t.ai_type} → ${v}`)
          if (body !== null && body.length > 0) {
            console.log(`       首行: ${String(body[0].content).slice(0, 40)}`)
          }
        }
        console.log(`       原始列表: ${JSON.stringify(subs.map(t => ({ lan: t.lan, ai_type: t.ai_type })))}`)
        break // wbi 端点有结果就不再重复查 legacy 端点
      }
    }
  }
  console.log('\n（判定: ☔ 毒轨=时间轴超过视频时长；✓ 正常=在时长内。把整段输出发回即可。）')
}

run().catch(e => console.error('脚本异常:', e))
