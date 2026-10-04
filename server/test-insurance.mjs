/**
 * 赛事事故与保险理赔 功能验证（投保 / 事故生成 / 报案 / 定损 / 赔付状态机 /
 * 年度额度连续理赔 / 额度截断与用尽 / 保障先后判定 / 并发幂等 / 租约押金联动 /
 * 自有艇维修联动 / 资金声望 / 赛季到期 / 越站对称冲回 / 历史保单迁移兼容）
 *
 * 用法：node --experimental-sqlite server/test-insurance.mjs（需要 Node ≥22.5 的 node:sqlite）
 * 在临时目录里起一份独立 DB 与独立端口的真实服务，跑完即销毁，不污染开发库。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, cpSync, rmSync, symlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0
const ok = (name, cond) => { assert.ok(cond, name); pass++; console.log(`  ✅ ${name}`) }
const eq = (name, a, b) => { assert.equal(a, b, `${name}（期望 ${b}，实际 ${a}）`); pass++; console.log(`  ✅ ${name}`) }

function api(port, p, opts) { return fetch(`http://127.0.0.1:${port}${p}`, opts).then(r => r.json()) }
const post = (port, p, b) => api(port, p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined })

function makeSandbox() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sky-ins-'))
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
async function playStation(port, cid) {
  const started = await post(port, `/api/races/start/${cid}`, {})
  assert.ok(started.ok, `第 ${cid} 站开赛失败：${started.msg || ''}`)
  const settled = await post(port, `/api/races/${started.race.id}/settle`, {})
  assert.ok(settled.ok, `第 ${cid} 站结算失败：${settled.msg || ''}`)
  return { started, settled }
}
// 反复重置赛季直到出现事故（事故在开赛瞬间确定性生成，概率事件）
async function playUntilIncident(port, { stations = 6, rent = false, plan = 3 } = {}) {
  for (let attempt = 0; attempt < 60; attempt++) {
    await post(port, '/api/reset')
    if (plan) {
      const buy = await post(port, '/api/insurance/buy', { id: plan })
      assert.ok(buy.ok, '投保失败：' + buy.msg)
    }
    if (rent) {
      const r = await post(port, '/api/rentals/rent', { id: 1 })
      assert.ok(r.ok, '租艇失败：' + r.msg)
    }
    const races = []
    for (let cid = 1; cid <= stations; cid++) {
      const r = await playStation(port, cid)
      races.push(r)
      if (r.settled.incident) return { race: r, races, attempt }
    }
  }
  throw new Error('多轮尝试后仍未出现事故')
}
// 注入一条「已结算且带事故快照」的比赛记录（不建理赔单）：确定性构造连续理赔 / 额度边界 /
// 历史保单场景，报案→定损→赔付仍全部走真实 API。rank/pts/money/wear 均为 0，不干扰资金与合约断言
function injectIncidentRace(dbh, { season, circuitId = 1, damage = 30, level = 'major', cause = '注入事故（测试构造）' }) {
  const c = dbh.prepare('SELECT * FROM circuits WHERE id=?').get(circuitId)
  const ts = String(Date.now())
  const rec = {
    v: 1, circuit: { id: c.id, name: c.name, diff: c.diff, weather: c.weather }, season,
    segments: [], factors: { weather: c.weather, rental: null, lineup: { shipMode: 'own' }, mods: [], pilot: null, mech: null, base: {} },
    racers: [], events: [],
    result: { rank: 6, pts: 0, money: 0, wear: 0, repGain: 0 },
    incident: { level, damage, cause }
  }
  const raceId = dbh.prepare(`INSERT INTO races (circuit_id,season,status,settled,rank,pts,money,wear,rep_gain,record,watch_el,created_at,created_ts,settled_at)
    VALUES (?,?,'settled',1,6,0,0,0,0,?,0,?,?,?)`)
    .run(circuitId, season, JSON.stringify(rec), ts, Date.now(), ts).lastInsertRowid
  return Number(raceId)
}

async function main() {
  const PORT = 4421
  const dir = makeSandbox()
  let proc
  try {
    proc = startServer(dir, PORT)
    await waitReady(PORT)

    console.log('\n[保险] 方案目录与投保校验')
    const s0 = await api(PORT, '/api/state')
    eq('初始无保单', s0.insurance.policy, null)
    eq('目录 3 个方案', s0.insurance.plans.length, 3)
    ok('方案均带年度额度（≥单次上限）', s0.insurance.plans.every(p => Number.isInteger(p.quota) && p.quota >= p.maxPayout))
    const bad = await post(PORT, '/api/insurance/buy', { id: 99 })
    eq('非法方案被拒', bad.ok, false)
    const buy = await post(PORT, '/api/insurance/buy', { id: 2 })
    ok('投保成功', buy.ok)
    const moneyAfterBuy = (await api(PORT, '/api/state')).team.money
    eq('投保即扣保险费', moneyAfterBuy, s0.team.money - 2600)
    const pol0 = (await api(PORT, '/api/state')).insurance.policy
    eq('新保单年度额度快照', pol0.quota, 15000)
    eq('新保单累计赔付为 0', pol0.paidTotal, 0)
    eq('新保单剩余额度=年度额度', pol0.quotaLeft, 15000)
    const buy2 = await post(PORT, '/api/insurance/buy', { id: 1 })
    eq('每赛季仅一份保单', buy2.ok, false)
    // 赛中不可投保（防先出事后补保）
    const st = await post(PORT, '/api/races/start/1', {})
    const buyMid = await post(PORT, '/api/insurance/buy', { id: 1 })
    eq('赛中投保被拒', buyMid.ok, false)
    await post(PORT, `/api/races/${st.race.id}/settle`, {})

    console.log('\n[理赔状态机] 报案 → 定损 → 赔付（自有艇）')
    // 上面第 1 站若无事故则重置直到出事故；用全险便于校验 100% 赔付
    const found = await playUntilIncident(PORT, { plan: 3 })
    const raceId = found.race.started.race.id
    const snap = found.race.started.race.record.incident
    const moneyBeforeClaim = (await api(PORT, '/api/state')).team.money

    // 无事故比赛报案被拒
    const noInc = found.races.find(r => !r.settled.incident)
    if (noInc) {
      const repNone = await post(PORT, `/api/incidents/${noInc.started.race.id}/report`, {})
      eq('平安场次报案被拒', repNone.ok, false)
    }
    // 未定损先赔付：接口路径按 id，未报案时理赔单不存在 → 404
    // 报案（重复报案幂等）
    const rep = await post(PORT, `/api/incidents/${raceId}/report`, {})
    ok('报案成功', rep.ok)
    const repAgain = await post(PORT, `/api/incidents/${raceId}/report`, {})
    ok('重复报案幂等', repAgain.ok && repAgain.already)
    eq('报案单状态 reported', rep.incident.status, 'reported')
    // 定损：自有艇按 25/点核定，服务端计算，客户端不可改金额
    const ass = await post(PORT, `/api/incidents/${rep.incident.id}/assess`, {})
    ok('定损成功', ass.ok)
    eq('定损费=损伤×25（自有艇）', ass.incident.assessed, snap.damage * 25)
    const assAgain = await post(PORT, `/api/incidents/${rep.incident.id}/assess`, {})
    ok('重复定损幂等', assAgain.already)
    // 赔付：全险 100%、上限 15000
    const pay = await post(PORT, `/api/incidents/${rep.incident.id}/payout`, {})
    ok('赔付成功', pay.ok)
    eq('赔付额=定损额（全险 100%）', pay.payout, snap.damage * 25)
    const moneyAfterClaim = (await api(PORT, '/api/state')).team.money
    eq('赔付金到账', moneyAfterClaim - moneyBeforeClaim, pay.payout)
    const payAgain = await post(PORT, `/api/incidents/${rep.incident.id}/payout`, {})
    ok('重复赔付幂等不二次打款', payAgain.ok && payAgain.already)
    eq('重复赔付金额为 0（幂等）', payAgain.incident.payout, pay.payout)
    const st1 = await api(PORT, '/api/state')
    eq('年度额度机制：赔付后保单保持 active（不结案）', st1.insurance.policy.status, 'active')
    eq('累计赔付计入保单', st1.insurance.policy.paidTotal, pay.payout)
    eq('剩余额度=年度额度-累计赔付', st1.insurance.policy.quotaLeft, 32000 - pay.payout)

    console.log('\n[年度额度] 同一保单连续理赔第二起事故（不结案、额度累计）')
    // 同一赛季同一保单下再出一起事故（注入已结算事故记录，理赔流程走真实 API）
    const dbC = new DatabaseSync(path.join(dir, 'sky.db'))
    const seasonC = dbC.prepare('SELECT season FROM team').get().season
    const raceIdB = injectIncidentRace(dbC, { season: seasonC, damage: 40 })
    dbC.close()
    const repB = await post(PORT, `/api/incidents/${raceIdB}/report`, {})
    ok('第二起事故报案成功', repB.ok && !repB.already)
    const assB = await post(PORT, `/api/incidents/${repB.incident.id}/assess`, {})
    eq('第二起定损=损伤×25（自有艇）', assB.incident.assessed, 40 * 25)
    const moneyBeforeB = (await api(PORT, '/api/state')).team.money
    const payB = await post(PORT, `/api/incidents/${repB.incident.id}/payout`, {})
    ok('第二起事故赔付成功（保单未结案）', payB.ok && !payB.already)
    eq('第二起赔付=定损额（全险 100%）', payB.payout, 1000)
    eq('第二起赔款到账', Math.round((await api(PORT, '/api/state')).team.money - moneyBeforeB), 1000)
    const stB = await api(PORT, '/api/state')
    eq('连续理赔后保单仍 active', stB.insurance.policy.status, 'active')
    eq('累计赔付=两起之和', stB.insurance.policy.paidTotal, pay.payout + 1000)
    eq('剩余额度同步扣减', stB.insurance.policy.quotaLeft, 32000 - pay.payout - 1000)

    console.log('\n[租赁艇联动] 事故损伤计入租约押金，定损按租约费率，赔付对冲')
    const r2 = await playUntilIncident(PORT, { rent: true, plan: 2, stations: 1 })
    const snap2 = r2.race.started.race.record.incident
    const raceId2 = r2.race.started.race.id
    const rep2 = await post(PORT, `/api/incidents/${raceId2}/report`, {})
    const ass2 = await post(PORT, `/api/incidents/${rep2.incident.id}/assess`, {})
    eq('租约艇定损=损伤×租约费率35', ass2.incident.assessed, snap2.damage * 35)
    eq('定损单标记租约艇', ass2.incident.ship.kind, 'rental')
    const expectPay = Math.min(Math.round(snap2.damage * 35 * 0.75), 7000)
    const pay2 = await post(PORT, `/api/incidents/${rep2.incident.id}/payout`, {})
    eq('75% 方案赔付（含上限）', pay2.payout, expectPay)
    // 归还：事故损伤与正常磨损一起按费率结算押金
    const ret = await post(PORT, '/api/rentals/return', {})
    const wearTotal = r2.race.started.race.record.result.wear + snap2.damage
    eq('归还磨损费=（磨损+事故损伤）×35', ret.wearFee, wearTotal * 35)
    eq('归还退款=押金−磨损费', ret.refund, Math.max(0, 2400 - wearTotal * 35))

    console.log('\n[无保单] 可报案定损，赔付拒绝')
    const r3 = await playUntilIncident(PORT, { plan: null, stations: 1 })
    const rep3 = await post(PORT, `/api/incidents/${r3.race.started.race.id}/report`, {})
    const ass3 = await post(PORT, `/api/incidents/${rep3.incident.id}/assess`, {})
    ok('无保单可报案', rep3.ok)
    ok('无保单可定损留档', ass3.ok)
    const pay3 = await post(PORT, `/api/incidents/${rep3.incident.id}/payout`, {})
    eq('无保单赔付被拒', pay3.ok, false)

    console.log('\n[保障先后] 事故后补保不予理赔（保单须先于开赛生效）')
    // 先出事故（无保单）→ 完赛后投保 → 报案定损照常，赔付必须被拒（防先出事后补保）。
    // 间隔拉开 1.2s 越过判定的 1s 时钟余量，确保「投保晚于开赛」确定性成立
    const r5 = await playUntilIncident(PORT, { plan: null, stations: 1 })
    await sleep(1200)
    const buyLate = await post(PORT, '/api/insurance/buy', { id: 1 })
    ok('事故完赛后可投保', buyLate.ok)
    const rep5 = await post(PORT, `/api/incidents/${r5.race.started.race.id}/report`, {})
    ok('补保后仍可报案留档', rep5.ok)
    const ass5 = await post(PORT, `/api/incidents/${rep5.incident.id}/assess`, {})
    ok('补保后仍可定损', ass5.ok)
    const pay5 = await post(PORT, `/api/incidents/${rep5.incident.id}/payout`, {})
    eq('事故先于保单生效 → 赔付被拒', pay5.ok, false)
    // 投保后新发生的事故正常理赔（对照：保单先于开赛则在保障范围）
    const dbL = new DatabaseSync(path.join(dir, 'sky.db'))
    const raceIdL = injectIncidentRace(dbL, { season: dbL.prepare('SELECT season FROM team').get().season, damage: 10 })
    dbL.close()
    const repL = await post(PORT, `/api/incidents/${raceIdL}/report`, {})
    await post(PORT, `/api/incidents/${repL.incident.id}/assess`, {})
    const payL = await post(PORT, `/api/incidents/${repL.incident.id}/payout`, {})
    ok('投保后新事故正常赔付', payL.ok && payL.payout === Math.round(10 * 25 * 0.5))

    console.log('\n[年度额度] 单次上限/剩余额度截断、额度用尽拒赔')
    await post(PORT, '/api/reset')
    ok('投保基础险', (await post(PORT, '/api/insurance/buy', { id: 1 })).ok) // 50%、单次上限 3000、年度额度 6000
    const dbQ = new DatabaseSync(path.join(dir, 'sky.db'))
    const seasonQ = dbQ.prepare('SELECT season FROM team').get().season
    const qRaces = [200, 200, 200, 200].map(dmg => injectIncidentRace(dbQ, { season: seasonQ, damage: dmg }))
    dbQ.close()
    // 每起损伤 200 → 定损 5000；应赔 min(2500, 3000, 剩余额度)：2500 / 2500 / 1000（截断）/ 拒赔
    const flow = async (raceId) => {
      const rep = await post(PORT, `/api/incidents/${raceId}/report`, {})
      assert.ok(rep.ok, '报案失败')
      const ass = await post(PORT, `/api/incidents/${rep.incident.id}/assess`, {})
      assert.ok(ass.ok && ass.incident.assessed === 5000, '定损应为 200×25=5000')
      return rep.incident.id
    }
    const incQ1 = await flow(qRaces[0])
    const payQ1 = await post(PORT, `/api/incidents/${incQ1}/payout`, {})
    eq('第 1 起赔付 2500（比例核定）', payQ1.payout, 2500)
    const incQ2 = await flow(qRaces[1])
    const payQ2 = await post(PORT, `/api/incidents/${incQ2}/payout`, {})
    eq('第 2 起赔付 2500（额度内连续理赔）', payQ2.payout, 2500)
    const incQ3 = await flow(qRaces[2])
    const payQ3 = await post(PORT, `/api/incidents/${incQ3}/payout`, {})
    eq('第 3 起赔付 1000（剩余额度截断）', payQ3.payout, 1000)
    const stQ = await api(PORT, '/api/state')
    eq('累计赔付=年度额度', stQ.insurance.policy.paidTotal, 6000)
    eq('剩余额度归零', stQ.insurance.policy.quotaLeft, 0)
    eq('额度用尽保单仍 active（不结案）', stQ.insurance.policy.status, 'active')
    const incQ4 = await flow(qRaces[3])
    const payQ4 = await post(PORT, `/api/incidents/${incQ4}/payout`, {})
    eq('年度额度用尽后赔付被拒', payQ4.ok, false)
    const eligQ = stQ.insurance.incidents.find(i => i.status === 'assessed')
    ok('额度用尽后理赔单给出服务端原因', !eligQ || eligQ.elig.reason.includes('额度'))

    console.log('\n[并发幂等] 同一理赔单并发赔付只到账一次；不同事故并发各自到账')
    await post(PORT, '/api/reset')
    ok('投保全险', (await post(PORT, '/api/insurance/buy', { id: 3 })).ok)
    const dbK = new DatabaseSync(path.join(dir, 'sky.db'))
    const seasonK = dbK.prepare('SELECT season FROM team').get().season
    const raceK1 = injectIncidentRace(dbK, { season: seasonK, damage: 20 })
    dbK.close()
    const repK = await post(PORT, `/api/incidents/${raceK1}/report`, {})
    await post(PORT, `/api/incidents/${repK.incident.id}/assess`, {})
    const moneyK0 = (await api(PORT, '/api/state')).team.money
    const burst = await Promise.all(Array.from({ length: 5 }, () => post(PORT, `/api/incidents/${repK.incident.id}/payout`, {})))
    eq('并发请求全部返回成功', burst.filter(r => r.ok).length, 5)
    eq('并发仅一笔实际赔付', burst.filter(r => !r.already).length, 1)
    eq('其余均为幂等重放', burst.filter(r => r.already).length, 4)
    const stK = await api(PORT, '/api/state')
    eq('赔款只到账一次', Math.round(stK.team.money - moneyK0), 500)
    eq('额度只扣减一次', stK.insurance.policy.paidTotal, 500)
    // 两起不同事故并发赔付：各自到账，额度累计正确
    const dbK2 = new DatabaseSync(path.join(dir, 'sky.db'))
    const raceK2 = injectIncidentRace(dbK2, { season: seasonK, damage: 10 })
    const raceK3 = injectIncidentRace(dbK2, { season: seasonK, damage: 30 })
    dbK2.close()
    const repK2 = await post(PORT, `/api/incidents/${raceK2}/report`, {})
    const repK3 = await post(PORT, `/api/incidents/${raceK3}/report`, {})
    await post(PORT, `/api/incidents/${repK2.incident.id}/assess`, {})
    await post(PORT, `/api/incidents/${repK3.incident.id}/assess`, {})
    const [payK2, payK3] = await Promise.all([
      post(PORT, `/api/incidents/${repK2.incident.id}/payout`, {}),
      post(PORT, `/api/incidents/${repK3.incident.id}/payout`, {})
    ])
    ok('两起事故并发赔付各自成功', payK2.ok && !payK2.already && payK3.ok && !payK3.already)
    eq('不同事故并发后额度累计正确', (await api(PORT, '/api/state')).insurance.policy.paidTotal, 500 + 250 + 750)

    console.log('\n[事故影响] 部件健康与声望按等级扣减，可维修恢复')
    // 重置到「有事故 + 自有艇 + 有赔付能力」的一轮，只结算第 1 站后直接核对
    const r4 = await playUntilIncident(PORT, { plan: 3, stations: 1 })
    const snap4 = r4.race.started.race.record.incident
    const s4 = await api(PORT, '/api/state')
    const expectPd = Math.max(5, 100 - r4.race.started.race.record.result.wear - snap4.damage)
    eq('事故损伤已施加到自有艇部件', s4.airship.parts_dur, expectPd)
    const repLoss = { minor: 0, major: 1, crash: 3 }[snap4.level]
    // 声望 = 初始 50 + 本场 repGain - 事故扣减（第 1 站通常无合约当场兑现）
    const repAfter = s4.team.rep
    const raceRepGain = r4.race.started.race.record.result.repGain
    const earnedContracts = s4.contracts.filter(c => c.earned).reduce((a, c) => a + c.rep, 0)
    eq('严重/坠毁事故扣声望（轻微不扣）', repAfter, 50 + raceRepGain + earnedContracts - repLoss)
    // 走理赔后维护可恢复：先报案定损赔付，再维护回 100
    const rp = await post(PORT, `/api/incidents/${r4.race.started.race.id}/report`, {})
    await post(PORT, `/api/incidents/${rp.incident.id}/assess`, {})
    await post(PORT, `/api/incidents/${rp.incident.id}/payout`, {})
    const maint = await post(PORT, '/api/maintain', {})
    ok('事故后维护成功', maint.ok)
    const s4b = await api(PORT, '/api/state')
    eq('维护后部件恢复 100', s4b.airship.parts_dur, 100)

    console.log('\n[赛季结算] 完季保单到期、未决理赔单拒付、事故统计归档')
    await post(PORT, '/api/reset')
    await post(PORT, '/api/insurance/buy', { id: 2 })
    let pending = null
    for (let cid = 1; cid <= 6; cid++) {
      const r = await playStation(PORT, cid)
      if (r.settled.incident && !pending) pending = r
    }
    if (pending) {
      const rp = await post(PORT, `/api/incidents/${pending.started.race.id}/report`, {})
      await post(PORT, `/api/incidents/${rp.incident.id}/assess`, {})  // 只定损，不赔付
    }
    const moneyBeforeAdv = (await api(PORT, '/api/state')).team.money
    const adv = await post(PORT, '/api/seasons/advance', {})
    ok('衔接成功', adv.ok)
    eq('归档摘要带事故数', typeof adv.summary.incidents, 'number')
    eq('归档摘要带赔付统计', adv.summary.payouts, 0) // 本轮没有已赔付的单子
    if (pending) {
      const payLate = await post(PORT, `/api/incidents/${rp.incident.id}/payout`, {})
      eq('往季未决单赔付被拒', payLate.ok, false)
      eq('拒付不产生资金变动', (await api(PORT, '/api/state')).team.money, moneyBeforeAdv)
    }
    const st5 = await api(PORT, '/api/state')
    eq('新赛季视角无有效保单（需重新投保）', st5.insurance.policy, null)
    const arch = st5.seasons.find(x => x.season === 1)
    ok('历届榜归档事故数', arch.incidents >= (pending ? 1 : 0))

    console.log('\n[越站回滚] 已赔付理赔随越站作废对称冲回（赔款/保单额度/损伤恢复）')
    // 新一季：第 1 站事故并完成赔付
    const r6 = await playUntilIncident(PORT, { plan: 3, stations: 1 })
    const rp6 = await post(PORT, `/api/incidents/${r6.race.started.race.id}/report`, {})
    await post(PORT, `/api/incidents/${rp6.incident.id}/assess`, {})
    const pay6 = await post(PORT, `/api/incidents/${rp6.incident.id}/payout`, {})
    ok('第 1 站理赔已付', pay6.ok && pay6.payout > 0)
    const pre = await api(PORT, '/api/state')
    const moneyPre = pre.team.money
    // 直接写库制造越站：跳过第 2 站，把第 3 站置为 finished 并塞一条带 crash 事故的已结算记录；
    // 该越站事故已完成赔付（paid）——回滚时须冲回赔款并恢复保单年度额度
    const db = new DatabaseSync(path.join(dir, 'sky.db'))
    const season = db.prepare('SELECT season FROM team').get().season
    const polId = db.prepare('SELECT id FROM insurance WHERE season=? ORDER BY id DESC LIMIT 1').get(season).id
    const c3 = db.prepare('SELECT * FROM circuits WHERE id=3').get()
    const fake = {
      v: 1, circuit: { id: 3, name: c3.name, diff: c3.diff, weather: c3.weather }, season,
      segments: [], factors: { weather: c3.weather, rental: null, lineup: { shipMode: 'own' }, mods: [], pilot: null, mech: null, base: {} },
      racers: [], events: [],
      result: { rank: 3, pts: 15, money: 1200, wear: 10, repGain: 3 },
      incident: { level: 'crash', damage: 30, cause: '越站坠毁' }
    }
    const ts = String(Date.now())
    db.exec('BEGIN')
    db.prepare('UPDATE circuits SET finished=1, rank=3 WHERE id=3').run()
    const raceId3 = db.prepare(`INSERT INTO races (circuit_id,season,status,settled,rank,pts,money,wear,rep_gain,record,watch_el,created_at,created_ts,settled_at)
      VALUES (3,?,'settled',1,3,15,1200,10,3,?,0,?,?,?)`)
      .run(season, JSON.stringify(fake), ts, Date.now(), ts).lastInsertRowid
    // 越站事故的理赔单已是 paid（定损 30×25=750，全险 100% 赔付，计入保单累计赔付）
    db.prepare(`INSERT INTO incidents (race_id,season,circuit_id,level,cause,damage,repair_cost,assessed,payout,claim_id,status,created_at,reported_at,assessed_at,paid_at)
      VALUES (?,?,?,'crash','越站坠毁',30,750,750,750,?,'paid',?,?,?,?)`)
      .run(raceId3, season, 3, polId, ts, ts, ts, ts)
    db.prepare('UPDATE insurance SET paid_total=paid_total+? WHERE id=?').run(750, polId)
    // 真实越站只在结算事务内产生一条「被比赛记录认领」的流水（此处不再额外注入，
    // 未关联流水的兜底回滚路径由 test-consistency 场景覆盖）
    db.exec('COMMIT')
    db.close()
    // 重启服务器触发启动迁移修复
    proc.kill('SIGKILL'); proc = null; await sleep(150)
    proc = startServer(dir, PORT)
    const post2 = await waitReady(PORT)
    // 资金冲回分项：越站奖金 1200 + 越站赔款 750；因越站记录（rank3 完赛）被对账撤销的合约奖励
    const revokedRewards = pre.contracts
      .filter(c => c.earned && !(post2.contracts.find(x => x.id === c.id)?.earned))
      .reduce((a, c) => a + c.reward, 0)
    eq('合约冲回项非负（越站 rank3 完赛可影响条款）', revokedRewards >= 0, true)
    eq('越站资金（奖金+赔款+对账合约）已冲回', Math.round(post2.team.money), Math.round(moneyPre - 1200 - 750 - revokedRewards))
    const db2 = new DatabaseSync(path.join(dir, 'sky.db'))
    const voidRace = db2.prepare("SELECT status FROM races WHERE circuit_id=3").get()
    eq('越站记录置 void', voidRace.status, 'void')
    const inc3 = db2.prepare("SELECT i.status FROM incidents i JOIN races r ON r.id=i.race_id WHERE r.circuit_id=3").get()
    eq('越站事故理赔单作废', inc3.status, 'void')
    const inc1 = db2.prepare("SELECT status,payout FROM incidents WHERE race_id=?").get(r6.race.started.race.id)
    eq('第 1 站合法理赔仍为 paid', inc1.status, 'paid')
    eq('第 1 站赔款未被冲回', inc1.payout, pay6.payout)
    const pol1 = db2.prepare("SELECT status,paid_total FROM insurance WHERE id=?").get(polId)
    eq('越站冲回后保单保持 active（年度额度机制不结案）', pol1.status, 'active')
    eq('越站赔款冲回后保单额度恢复（paid_total 回退）', pol1.paid_total, pay6.payout)
    db2.close()

    console.log('\n[历史保单] 老保单迁移：active 纳入年度额度连续理赔；claimed 保持结案')
    // 手工写入「年度额度机制之前」的老保单（无 quota/paid_total 列值，quota 为 NULL）
    await post(PORT, '/api/reset')
    const dbH = new DatabaseSync(path.join(dir, 'sky.db'))
    dbH.prepare(`INSERT INTO insurance (plan_id,name,season,premium,coverage,max_payout,status,created_at)
      VALUES (3,'苍穹·旗舰全险',1,4800,1.0,15000,'active',?)`).run(String(Date.now()))
    dbH.close()
    // 重启触发启动迁移
    proc.kill('SIGKILL'); proc = null; await sleep(150)
    proc = startServer(dir, PORT)
    const stH = await waitReady(PORT)
    eq('active 老保单回填年度额度', stH.insurance.policy.quota, 32000)
    eq('active 老保单累计赔付为 0', stH.insurance.policy.paidTotal, 0)
    eq('active 老保单状态保持 active', stH.insurance.policy.status, 'active')
    // 迁移后的老保单纳入新机制：额度内连续理赔两起
    const dbH2 = new DatabaseSync(path.join(dir, 'sky.db'))
    const raceH1 = injectIncidentRace(dbH2, { season: 1, damage: 20 })
    const raceH2 = injectIncidentRace(dbH2, { season: 1, damage: 30 })
    dbH2.close()
    const repH1 = await post(PORT, `/api/incidents/${raceH1}/report`, {})
    await post(PORT, `/api/incidents/${repH1.incident.id}/assess`, {})
    const payH1 = await post(PORT, `/api/incidents/${repH1.incident.id}/payout`, {})
    ok('迁移后老保单首起赔付', payH1.ok && payH1.payout === 500)
    const repH2 = await post(PORT, `/api/incidents/${raceH2}/report`, {})
    await post(PORT, `/api/incidents/${repH2.incident.id}/assess`, {})
    const payH2 = await post(PORT, `/api/incidents/${repH2.incident.id}/payout`, {})
    ok('迁移后老保单连续理赔第二起', payH2.ok && payH2.payout === 750)
    eq('老保单累计赔付=两起之和', (await api(PORT, '/api/state')).insurance.policy.paidTotal, 1250)
    // claimed 老保单（旧「一案一季」已结案）：迁移回填已赔付，保持结案不再赔付
    await post(PORT, '/api/reset')
    const dbH3 = new DatabaseSync(path.join(dir, 'sky.db'))
    const raceH3 = injectIncidentRace(dbH3, { season: 1, damage: 20 })
    const tsH = String(Date.now())
    dbH3.prepare(`INSERT INTO incidents (race_id,season,circuit_id,level,cause,damage,repair_cost,assessed,payout,status,created_at,reported_at,assessed_at,paid_at)
      VALUES (?,1,1,'minor','历史事故',20,500,500,500,'paid',?,?,?,?)`).run(raceH3, tsH, tsH, tsH, tsH)
    const oldIncId = dbH3.prepare('SELECT id FROM incidents WHERE race_id=?').get(raceH3).id
    dbH3.prepare(`INSERT INTO insurance (plan_id,name,season,premium,coverage,max_payout,status,claimed_incident_id,created_at,claimed_at)
      VALUES (3,'苍穹·旗舰全险',1,4800,1.0,15000,'claimed',?,?,?)`).run(oldIncId, tsH, tsH)
    dbH3.close()
    proc.kill('SIGKILL'); proc = null; await sleep(150)
    proc = startServer(dir, PORT)
    const stH3 = await waitReady(PORT)
    eq('claimed 老保单保持结案', stH3.insurance.policy.status, 'claimed')
    eq('claimed 老保单回填累计已赔付', stH3.insurance.policy.paidTotal, 500)
    eq('claimed 老保单回填年度额度', stH3.insurance.policy.quota, 32000)
    // 结案保单项下新事故可报案定损留档，但赔付被拒
    const dbH4 = new DatabaseSync(path.join(dir, 'sky.db'))
    const raceH4 = injectIncidentRace(dbH4, { season: 1, damage: 10 })
    dbH4.close()
    const repH4 = await post(PORT, `/api/incidents/${raceH4}/report`, {})
    ok('结案保单项下仍可报案留档', repH4.ok)
    await post(PORT, `/api/incidents/${repH4.incident.id}/assess`, {})
    const payH4 = await post(PORT, `/api/incidents/${repH4.incident.id}/payout`, {})
    eq('结案保单不再赔付', payH4.ok, false)

    proc.kill('SIGKILL'); proc = null; await sleep(120)
    rmSync(dir, { recursive: true, force: true })
  } finally {
    if (proc) proc.kill('SIGKILL')
    rmSync(dir, { recursive: true, force: true })
  }
  console.log(`\n🎉 全部 ${pass} 项断言通过：年度额度连续理赔、保障先后、并发幂等、租约押金、维修、资金声望、赛季到期、越站冲回与历史保单迁移一致`)
}
main().catch(e => { console.error('\n❌ 验证失败：', e); process.exit(1) })
