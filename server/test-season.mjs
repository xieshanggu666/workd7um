/**
 * 新赛季衔接 功能验证（完季归档 / 分层重置 / 回放保留 / 排行榜分层 / 幂等）
 *
 * 用法：node server/test-season.mjs（需要 Node ≥22.5 的 node:sqlite）
 * 在临时目录里起一份独立 DB 与独立端口的真实服务，跑完即销毁，不污染开发库。
 */
import { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'
import { mkdtempSync, cpSync, rmSync, symlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0
const ok = (name, cond) => { assert.ok(cond, name); pass++; console.log(`  ✅ ${name}`) }
const eq = (name, a, b) => { assert.equal(a, b, `${name}（期望 ${b}，实际 ${a}）`); pass++; console.log(`  ✅ ${name}`) }

function api(port, p, opts) { return fetch(`http://127.0.0.1:${port}${p}`, opts).then(r => r.json()) }
const post = (port, p, b) => api(port, p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined })

function makeSandbox() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sky-season-'))
  cpSync(path.join(__dirname, 'db.js'), path.join(dir, 'db.js'))
  cpSync(path.join(__dirname, 'index.js'), path.join(dir, 'index.js'))
  symlinkSync(path.join(__dirname, '..', 'node_modules'), path.join(dir, 'node_modules'), 'dir')
  return dir
}
function startServer(dir, port) {
  return spawn(process.execPath, ['index.js'], { cwd: dir, env: { ...process.env, PORT: String(port) }, stdio: 'ignore' })
}
async function waitReady(port) {
  for (let i = 0; i < 100; i++) {
    try { const s = await api(port, '/api/state'); if (s?.team) return s } catch { /* wait */ }
    await sleep(80)
  }
  throw new Error('server not ready')
}
// 正常顺序打完一站：开赛 → 结算
async function playStation(port, cid) {
  const started = await post(port, `/api/races/start/${cid}`, {})
  assert.ok(started.ok, `第 ${cid} 站开赛失败：${started.msg || ''}`)
  const settled = await post(port, `/api/races/${started.race.id}/settle`, {})
  assert.ok(settled.ok, `第 ${cid} 站结算失败：${settled.msg || ''}`)
  return { started, settled }
}

async function scenario() {
  console.log('\n[新赛季衔接] 完季归档 → 分层重置 → 回放与资产保留 → 排行榜分层 → 幂等')
  const PORT = 4408
  const dir = makeSandbox()
  let proc
  try {
    proc = startServer(dir, PORT)
    const s0 = await waitReady(PORT)
    const money0 = s0.team.money
    const rep0 = s0.team.rep
    const ownPd0 = s0.airship.parts_dur

    /* ---- 1. 未打完 6 站不能衔接 ---- */
    const early = await post(PORT, '/api/seasons/advance', {})
    eq('未完季时拒绝衔接', early.ok, false)
    eq('当前赛季仍是 1', (await api(PORT, '/api/state')).team.season, 1)

    /* ---- 2. 第 1 站签一份租约艇（雨燕 2 场）；仅第 1 站租约艇出赛，其余站切自有艇 ----
     * 用以验证：租约（押金/场次/磨损归属）属于跨赛季资产，衔接时不结算、不重置 */
    const rent = await post(PORT, '/api/rentals/rent', { id: 1 })
    ok('签约租艇成功', rent.ok)
    const st1 = await playStation(PORT, 1)
    const rentalWear = st1.started.race.record.result.wear
    const ownWears = []
    await post(PORT, '/api/lineup', { shipMode: 'own' }) // 雨燕剩 1 场留着跨赛季
    for (let cid = 2; cid <= 6; cid++) {
      const r = await playStation(PORT, cid)
      ownWears.push(r.started.race.record.result.wear)
    }
    const sFull = await api(PORT, '/api/state')
    eq('6 站后 seasonComplete=true', sFull.seasonComplete, true)
    eq('6 站后赛季进度 6/6', sFull.seasonDone, 6)
    const pts1 = sFull.team.season_pts
    const log1 = sFull.log.filter(l => l.season === 1)
    eq('第 1 季流水 6 条', log1.length, 6)
    const wins1 = sFull.seasons[0].wins
    const podiums1 = sFull.seasons[0].podiums
    const bestRank1 = sFull.seasons[0].bestRank
    eq('当前赛季榜滚动行积分=顶栏积分', sFull.seasons[0].pts, pts1)
    eq('赛季榜滚动行场次=6', sFull.seasons[0].racesN, 6)
    const rtStillActive = sFull.rental
    ok('完季时租约仍在履（未被强制归还）', !!rtStillActive && rtStillActive.status === 'active')
    eq('租约仅消耗 1 场（第 1 站）', rtStillActive.races_used, 1)

    /* ---- 3. 结算卡幂等路径也带 seasonComplete（最后一站重复结算） ---- */
    const replaySettle = await post(PORT, `/api/races/${st1.settled.race.id}/settle`, {})
    // 第 1 站此时已非完季关口（全季都完了），用最后一站的 id 复测：
    const lastId = sFull.races.find(r => r.record.circuit.id === 6).id
    const lastAgain = await post(PORT, `/api/races/${lastId}/settle`, {})
    ok('最后一站重复结算幂等返回', lastAgain.ok && lastAgain.already)
    eq('幂等重放仍告知 seasonComplete', lastAgain.seasonComplete, true)
    void replaySettle

    /* ---- 4. 触发衔接：归档第 1 季并分层重置 ---- */
    const adv = await post(PORT, '/api/seasons/advance', {})
    ok('衔接成功', adv.ok && !adv.already)
    eq('进入第 2 季', adv.season, 2)
    eq('归档摘要=第 1 季积分', adv.summary.pts, pts1)
    eq('归档摘要夺冠场次', adv.summary.wins, wins1)
    eq('归档摘要登台场次', adv.summary.podiums, podiums1)
    eq('归档摘要最佳名次', adv.summary.bestRank, bestRank1)

    const s2 = await api(PORT, '/api/state')
    eq('team.season=2', s2.team.season, 2)
    eq('新赛季积分归零', s2.team.season_pts, 0)
    eq('新赛季车队名次归 1', s2.team.season_pos, 1)
    eq('新赛季 6 站全部重新开放', s2.circuits.every(c => !c.finished && c.rank == null), true)
    eq('赛站天气/难度配置不变', s2.circuits[5].name, '星界之巅')
    eq('新赛季 seasonComplete=false', s2.seasonComplete, false)
    eq('新赛季进度 0/6', s2.seasonDone, 0)

    /* ---- 5. 重复衔接幂等，不二次归档 ---- */
    const advAgain = await post(PORT, '/api/seasons/advance', {})
    ok('重复衔接返回幂等结果', advAgain.ok && advAgain.already)
    const s2b = await api(PORT, '/api/state')
    eq('幂等衔接不改变当前赛季', s2b.team.season, 2)
    eq('幂等衔接不改变积分', s2b.team.season_pts, 0)

    /* ---- 6. 跨赛季资产保留：资金/声望/飞艇磨损/租约 ---- */
    const prize1 = log1.reduce((a, l) => a + l.money, 0)
    // 6 场比赛记录中的事故快照：事故损伤与事故声望扣减（严重-1/坠毁-3）随赛季滚动
    const s1Recs = sFull.races.filter(r => r.record?.season === 1).map(r => r.record)
    const incRepLoss = s1Recs.reduce((a, rec) => a + (rec.incident ? { minor: 0, major: 1, crash: 3 }[rec.incident.level] || 0 : 0), 0)
    const incDamageOwn = s1Recs
      .filter(rec => !rec.factors?.rental)
      .reduce((a, rec) => a + (rec.incident?.damage || 0), 0)
    const incDamageRental = s1Recs
      .filter(rec => !!rec.factors?.rental)
      .reduce((a, rec) => a + (rec.incident?.damage || 0), 0)
    // 第 1 季资金 = 初始 -（押金+租金）+ 各站奖金 + 当场兑现合约奖励；衔接后数额原封不动
    const earnedInS1 = sFull.contracts.filter(c => c.earned).reduce((a, c) => a + c.reward, 0)
    const expectedMoney = money0 - (2400 + 600) + prize1 + earnedInS1
    eq('资金跨赛季保留（含第 1 季合约兑现）', Math.round(s2.team.money), Math.round(expectedMoney))
    const repGain1 = sFull.seasons.find(x => x.season === 1).rep
    const repContracts = sFull.contracts.filter(c => c.earned).reduce((a, c) => a + c.rep, 0)
    eq('声望跨赛季保留（含事故扣减）', s2.team.rep, rep0 + repGain1 + repContracts - incRepLoss)
    const ownWearTotal = ownWears.reduce((a, w) => a + w, 0)
    eq('自有艇磨损跨赛季保留（第 2-6 站累计，含事故损伤）', s2.airship.parts_dur, Math.max(5, ownPd0 - ownWearTotal - incDamageOwn))
    const rt = s2.rental
    ok('在履租约跨赛季保留', !!rt && rt.status === 'active')
    eq('租约已用场次跨赛季保留（仍为 1）', rt.races_used, 1)
    eq('租约累计磨损跨赛季（正常磨损+事故损伤）', rt.wear_total, rentalWear + incDamageRental)
    eq('租约剩余场次保留（还能再跑 1 场）', rt.max_races - rt.races_used, 1)

    /* ---- 7. 排行榜按赛季分层：第 1 季归档行 + 第 2 季滚动行 ---- */
    eq('赛季榜共 2 行（S1 归档 + S2 进行中）', s2.seasons.length, 2)
    const row1 = s2.seasons.find(x => x.season === 1)
    const row2 = s2.seasons.find(x => x.season === 2)
    ok('S1 为归档行', row1 && !row1.current && !!row1.finishedAt)
    eq('S1 归档积分保留', row1.pts, pts1)
    eq('S1 归档场次=6', row1.racesN, 6)
    ok('S2 为当前滚动行', row2 && row2.current && !row2.finishedAt)
    eq('S2 滚动积分=0', row2.pts, 0)
    eq('S2 滚动场次=0', row2.racesN, 0)

    /* ---- 8. 合约按赛季分层：第 2 季重签一套全新合约，进度归零 ---- */
    eq('第 2 季合约数量=配置数量', s2.contracts.length, 4)
    ok('第 2 季合约均未兑现', s2.contracts.every(c => !c.earned))
    ok('第 2 季条款进度全部归零',
      s2.contracts.every(c => c.terms.every(t => t.value === 0 || t.type === 'points' && t.value === 0)))
    eq('第 2 季合约归属 season=2', s2.contracts.every(c => c.season === 2), true)

    /* ---- 9. 历史战绩与回放保留：老赛季 6 场仍在、可回放、不重结算 ---- */
    eq('历史仍含全部 6 场第 1 季记录', s2.races.filter(r => r.record.season === 1).length, 6)
    ok('第 1 季记录全部可回放（status=settled）', s2.races.every(r => r.status === 'settled'))
    const oldRaceId = s2.races.find(r => r.record.circuit.id === 3).id
    const oldAgain = await post(PORT, `/api/races/${oldRaceId}/settle`, {})
    ok('老赛季比赛重复结算走幂等', oldAgain.ok && oldAgain.already)
    eq('幂等重放不产生积分（第 2 季仍为 0）', (await api(PORT, '/api/state')).team.season_pts, 0)

    /* ---- 10. 第 2 季第 1 站重新解锁，可开赛、可结算，积分重新累计 ---- */
    const n1 = await post(PORT, '/api/races/start/1', {})
    ok('第 2 季第 1 站可开赛', n1.ok)
    eq('新比赛记录归属第 2 季', n1.race.record.season, 2)
    const n1settle = await post(PORT, `/api/races/${n1.race.id}/settle`, {})
    ok('第 2 季第 1 站可结算', n1settle.ok)
    const s3 = await api(PORT, '/api/state')
    eq('第 2 季积分开始累计', s3.team.season_pts, n1.race.record.result.pts)
    eq('第 2 季赛站进度 1/6', s3.seasonDone, 1)
    eq('第 2 季第 1 站重新变为未完成（旧 finished 已重置后再完成）', s3.circuits[0].finished, 1)
    const row2b = s3.seasons.find(x => x.season === 2)
    eq('进行中赛季榜滚动更新场次=1', row2b.racesN, 1)
    eq('S1 归档积分不受新赛季比赛影响', s3.seasons.find(x => x.season === 1).pts, pts1)
    eq('历史新增第 2 季 1 场（共 7 场）', s3.races.length, 7)

    /* ---- 11. 直连 DB：归档行、老合约行、老流水都在；老 races 仍 settled ---- */
    proc.kill('SIGKILL'); proc = null; await sleep(150)
    const dbh = new DatabaseSync(path.join(dir, 'sky.db'))
    const arch = dbh.prepare('SELECT * FROM seasons WHERE season=1').get()
    ok('seasons 表存在第 1 季档案', !!arch)
    eq('档案积分正确', arch.pts, pts1)
    eq('档案完赛场次=6', arch.races_n, 6)
    ok('档案完赛时间已记录', !!arch.finished_at)
    const c1 = dbh.prepare('SELECT COUNT(*) c FROM contracts WHERE season=1').get().c
    const c2 = dbh.prepare('SELECT COUNT(*) c FROM contracts WHERE season=2').get().c
    eq('第 1 季合约行保留（历史对账口径）', c1, 4)
    eq('第 2 季合约行已建档', c2, 4)
    const r1 = dbh.prepare("SELECT COUNT(*) c FROM races WHERE season=1 AND status='settled'").get().c
    const r2 = dbh.prepare("SELECT COUNT(*) c FROM races WHERE season=2 AND status='settled'").get().c
    eq('第 1 季 races 原样保留为 settled（回放源）', r1, 6)
    eq('第 2 季 races 已新增 1 场', r2, 1)
    const l1 = dbh.prepare('SELECT COUNT(*) c FROM race_log WHERE season=1').get().c
    const l2 = dbh.prepare('SELECT COUNT(*) c FROM race_log WHERE season=2').get().c
    eq('第 1 季流水保留', l1, 6)
    eq('第 2 季流水新增', l2, 1)
    const voids = dbh.prepare("SELECT COUNT(*) c FROM races WHERE status='void'").get().c
    eq('衔接过程不无故作废比赛', voids, 0)
    const circuitsOpen = dbh.prepare('SELECT COUNT(*) c FROM circuits WHERE finished=1').get().c
    eq('第 2 季仅第 1 站完成', circuitsOpen, 1)
    dbh.close()

    /* ---- 12. 重启幂等：归档不重复、赛季不跳号、老数据可继续回放 ---- */
    proc = startServer(dir, PORT)
    const sr = await waitReady(PORT)
    eq('重启后仍处于第 2 季', sr.team.season, 2)
    eq('重启后积分不被重复重置/补发', sr.team.season_pts, n1.race.record.result.pts)
    eq('重启后赛季榜仍为 2 行', sr.seasons.length, 2)
    ok('S1 归档行重启后仍在', sr.seasons.some(x => x.season === 1 && !x.current))
    // 重启幂等的正确口径：已兑现合约集合在重启前后完全一致（第 1 站若已满足条款，
    // 该合约本就应在结算事务内兑现；重启对账只保持状态、绝不二次发奖）
    const earnedBefore = s3.contracts.filter(c => c.earned).map(c => c.id).sort()
    const earnedAfter = sr.contracts.filter(c => c.earned).map(c => c.id).sort()
    eq('重启前后已兑现合约集合一致（不重复兑现）', JSON.stringify(earnedAfter), JSON.stringify(earnedBefore))

    /* ---- 13. 存在 running 比赛时拒绝衔接（保护唯一事实来源） ---- */
    await post(PORT, '/api/races/start/2', {})
    const busy = await post(PORT, '/api/seasons/advance', {})
    eq('比赛进行中拒绝衔接', busy.ok, false)
    proc.kill('SIGKILL'); proc = null; await sleep(120)
  } finally {
    if (proc) proc.kill('SIGKILL')
    rmSync(dir, { recursive: true, force: true })
  }
}

const run = async () => {
  await scenario()
  console.log(`\n🎉 全部 ${pass} 项断言通过：完季归档、分层重置、回放保留、排行榜分层与衔接幂等一致`)
}
run().catch(e => { console.error('\n❌ 验证失败：', e); process.exit(1) })
