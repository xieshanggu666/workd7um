/**
 * 赛事事故与保险理赔 功能验证（年度额度制）
 * 覆盖：投保 / 事故生成 / 报案定损赔付状态机 / 同季连续理赔 / 年度额度封顶 /
 * 租约押金联动 / 自有艇维修联动 / 资金声望 / 并发幂等 / 赛季到期归档 /
 * 越站对称冲回（含年度额度恢复）/ 历史保单兼容迁移
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
// 反复重置赛季直到同一季出现 n 起事故（事故在开赛瞬间确定性生成，概率事件）
async function playUntilIncidents(port, n, { stations = 6, rent = false, plan = 3 } = {}) {
  for (let attempt = 0; attempt < 80; attempt++) {
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
    const hits = []
    for (let cid = 1; cid <= stations; cid++) {
      const r = await playStation(port, cid)
      races.push(r)
      if (r.settled.incident) hits.push(r)
      if (hits.length >= n) return { hits, races, attempt }
    }
  }
  throw new Error(`多轮尝试后仍未出现 ${n} 起事故`)
}
async function playUntilIncident(port, opts = {}) {
  const r = await playUntilIncidents(port, 1, opts)
  return { race: r.hits[0], races: r.races, attempt: r.attempt }
}
// 直接写库注入一条「已结算且带事故」的比赛记录（自有艇出赛），用于确定性地构造理赔场景；
// 赛站标记完赛，created_ts 取注入当下（晚于任何已购保单，满足「保单先于开赛」）
function injectIncidentRace(dir, { circuitId, damage = 20, level = 'major', season }) {
  const dbh = new DatabaseSync(path.join(dir, 'sky.db'))
  const c = dbh.prepare('SELECT * FROM circuits WHERE id=?').get(circuitId)
  const ts = String(Date.now())
  const rec = {
    v: 1, circuit: { id: c.id, name: c.name, diff: c.diff, weather: c.weather }, season,
    segments: [], factors: { weather: c.weather, rental: null, lineup: { shipMode: 'own' }, mods: [], pilot: null, mech: null, base: {} },
    racers: [], events: [],
    result: { rank: 2, pts: 18, money: 1000, wear: 8, repGain: 4 },
    incident: { level, damage, cause: '注入事故' }
  }
  dbh.exec('BEGIN')
  dbh.prepare('UPDATE circuits SET finished=1, rank=2 WHERE id=?').run(circuitId)
  const rid = dbh.prepare(`INSERT INTO races (circuit_id,season,status,settled,rank,pts,money,wear,rep_gain,record,watch_el,created_at,created_ts,settled_at)
    VALUES (?,?,'settled',1,2,18,1000,8,4,?,0,?,?,?)`)
    .run(circuitId, season, JSON.stringify(rec), ts, Date.now(), ts).lastInsertRowid
  dbh.exec('COMMIT')
  dbh.close()
  return Number(rid)
}

async function main() {
  const PORT = 4421
  const dir = makeSandbox()
  let proc
  try {
    proc = startServer(dir, PORT)
    await waitReady(PORT)

    console.log('\n[保险] 方案目录与投保校验（年度额度制）')
    const s0 = await api(PORT, '/api/state')
    eq('初始无保单', s0.insurance.policy, null)
    eq('目录 3 个方案', s0.insurance.plans.length, 3)
    eq('方案带年度额度', s0.insurance.plans.map(p => p.quota).join(','), '6000,15000,36000')
    const bad = await post(PORT, '/api/insurance/buy', { id: 99 })
    eq('非法方案被拒', bad.ok, false)
    const buy = await post(PORT, '/api/insurance/buy', { id: 2 })
    ok('投保成功', buy.ok)
    const moneyAfterBuy = (await api(PORT, '/api/state')).team.money
    eq('投保即扣保险费', moneyAfterBuy, s0.team.money - 2600)
    const stPol = await api(PORT, '/api/state')
    eq('新保单年度额度', stPol.insurance.policy.quota, 15000)
    eq('新保单已赔付为 0', stPol.insurance.policy.paidTotal, 0)
    eq('新保单剩余额度=年度额度', stPol.insurance.policy.remaining, 15000)
    const buy2 = await post(PORT, '/api/insurance/buy', { id: 1 })
    eq('每赛季仅一份保单', buy2.ok, false)
    // 赛中不可投保（防先出事后补保）
    const st = await post(PORT, '/api/races/start/1', {})
    const buyMid = await post(PORT, '/api/insurance/buy', { id: 1 })
    eq('赛中投保被拒', buyMid.ok, false)
    await post(PORT, `/api/races/${st.race.id}/settle`, {})

    console.log('\n[理赔状态机·连续理赔] 同一保单按事故状态连续报案/定损/赔付（自有艇）')
    // 同一季出现两起事故；用全险便于校验 100% 赔付
    const found = await playUntilIncidents(PORT, 2, { plan: 3 })
    const [h1, h2] = found.hits
    const snap1 = h1.started.race.record.incident
    const snap2 = h2.started.race.record.incident
    const moneyBeforeClaim = (await api(PORT, '/api/state')).team.money

    // 无事故比赛报案被拒
    const noInc = found.races.find(r => !r.settled.incident)
    if (noInc) {
      const repNone = await post(PORT, `/api/incidents/${noInc.started.race.id}/report`, {})
      eq('平安场次报案被拒', repNone.ok, false)
    }
    // 第 1 起：报案（重复报案幂等）→ 定损（幂等）→ 赔付（幂等）
    const rep = await post(PORT, `/api/incidents/${h1.started.race.id}/report`, {})
    ok('第 1 起报案成功', rep.ok)
    const repAgain = await post(PORT, `/api/incidents/${h1.started.race.id}/report`, {})
    ok('重复报案幂等', repAgain.ok && repAgain.already)
    eq('报案单状态 reported', rep.incident.status, 'reported')
    const ass = await post(PORT, `/api/incidents/${rep.incident.id}/assess`, {})
    ok('定损成功', ass.ok)
    eq('定损费=损伤×25（自有艇）', ass.incident.assessed, snap1.damage * 25)
    const assAgain = await post(PORT, `/api/incidents/${rep.incident.id}/assess`, {})
    ok('重复定损幂等', assAgain.already)
    const pay = await post(PORT, `/api/incidents/${rep.incident.id}/payout`, {})
    ok('第 1 起赔付成功', pay.ok)
    eq('赔付额=定损额（全险 100%）', pay.payout, snap1.damage * 25)
    const payAgain = await post(PORT, `/api/incidents/${rep.incident.id}/payout`, {})
    ok('重复赔付幂等不二次打款', payAgain.ok && payAgain.already)
    eq('重复赔付金额不变（幂等）', payAgain.incident.payout, pay.payout)
    // 年度额度制：赔付后保单不结案，额度累计
    const st1 = await api(PORT, '/api/state')
    eq('赔付后保单仍保障中（不再一案结案）', st1.insurance.policy.status, 'active')
    eq('已赔付累计到保单', st1.insurance.policy.paidTotal, pay.payout)
    eq('剩余年度额度同步扣减', st1.insurance.policy.remaining, 36000 - pay.payout)

    // 第 2 起：同一保单继续走完整理赔流程（旧制下会被「理赔一次」拦截）
    const rep2 = await post(PORT, `/api/incidents/${h2.started.race.id}/report`, {})
    ok('第 2 起事故可连续报案', rep2.ok)
    const ass2 = await post(PORT, `/api/incidents/${rep2.incident.id}/assess`, {})
    ok('第 2 起可连续定损', ass2.ok)
    const pay2 = await post(PORT, `/api/incidents/${rep2.incident.id}/payout`, {})
    ok('第 2 起可连续赔付', pay2.ok)
    eq('第 2 起赔付额=定损额', pay2.payout, snap2.damage * 25)
    const st2 = await api(PORT, '/api/state')
    eq('年度额度累计两起赔付', st2.insurance.policy.paidTotal, pay.payout + pay2.payout)
    eq('两起赔款均到账', st2.team.money - moneyBeforeClaim, pay.payout + pay2.payout)
    eq('额度未尽保单仍保障中', st2.insurance.policy.status, 'active')

    console.log('\n[租赁艇联动] 事故损伤计入租约押金，定损按租约费率，赔付对冲')
    const r2 = await playUntilIncident(PORT, { rent: true, plan: 2, stations: 1 })
    const snapR = r2.race.started.race.record.incident
    const raceId2 = r2.race.started.race.id
    const repR = await post(PORT, `/api/incidents/${raceId2}/report`, {})
    const assR = await post(PORT, `/api/incidents/${repR.incident.id}/assess`, {})
    eq('租约艇定损=损伤×租约费率35', assR.incident.assessed, snapR.damage * 35)
    eq('定损单标记租约艇', assR.incident.ship.kind, 'rental')
    const expectPay = Math.min(Math.round(snapR.damage * 35 * 0.75), 7000)
    const payR = await post(PORT, `/api/incidents/${repR.incident.id}/payout`, {})
    eq('75% 方案赔付（含单次上限）', payR.payout, expectPay)
    eq('租约赔付计入年度额度', (await api(PORT, '/api/state')).insurance.policy.paidTotal, expectPay)
    // 归还：事故损伤与正常磨损一起按费率结算押金
    const ret = await post(PORT, '/api/rentals/return', {})
    const wearTotal = r2.race.started.race.record.result.wear + snapR.damage
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
    let pending = null, pendingIncId = null
    for (let cid = 1; cid <= 6; cid++) {
      const r = await playStation(PORT, cid)
      if (r.settled.incident && !pending) pending = r
    }
    if (pending) {
      const rp5 = await post(PORT, `/api/incidents/${pending.started.race.id}/report`, {})
      pendingIncId = rp5.incident.id
      await post(PORT, `/api/incidents/${pendingIncId}/assess`, {})  // 只定损，不赔付
    }
    const moneyBeforeAdv = (await api(PORT, '/api/state')).team.money
    const adv = await post(PORT, '/api/seasons/advance', {})
    ok('衔接成功', adv.ok)
    eq('归档摘要带事故数', typeof adv.summary.incidents, 'number')
    eq('归档摘要带赔付统计', adv.summary.payouts, 0) // 本轮没有已赔付的单子
    if (pendingIncId) {
      const payLate = await post(PORT, `/api/incidents/${pendingIncId}/payout`, {})
      eq('往季未决单赔付被拒', payLate.ok, false)
      eq('拒付不产生资金变动', (await api(PORT, '/api/state')).team.money, moneyBeforeAdv)
    }
    const st5 = await api(PORT, '/api/state')
    eq('新赛季视角无有效保单（需重新投保）', st5.insurance.policy, null)
    const arch = st5.seasons.find(x => x.season === 1)
    ok('历届榜归档事故数', arch.incidents >= (pending ? 1 : 0))

    console.log('\n[越站回滚] 已赔付理赔随越站作废对称冲回（赔款/年度额度恢复）')
    // 新一季：第 1 站事故并完成赔付
    const r6 = await playUntilIncident(PORT, { plan: 3, stations: 1 })
    const rp6 = await post(PORT, `/api/incidents/${r6.race.started.race.id}/report`, {})
    await post(PORT, `/api/incidents/${rp6.incident.id}/assess`, {})
    const pay6 = await post(PORT, `/api/incidents/${rp6.incident.id}/payout`, {})
    ok('第 1 站理赔已付', pay6.ok && pay6.payout > 0)
    const pre = await api(PORT, '/api/state')
    const moneyPre = pre.team.money
    eq('赔付后年度额度累计', pre.insurance.policy.paidTotal, pay6.payout)
    // 直接写库制造越站：跳过第 2 站，把第 3 站置为 finished 并塞一条带 crash 事故的已结算记录，
    // 其理赔单为「已赔付」（挂在当前保单上，额度已计入），验证越站冲回同时恢复年度额度
    const db = new DatabaseSync(path.join(dir, 'sky.db'))
    const season = db.prepare('SELECT season FROM team').get().season
    const polId = pre.insurance.policy.id
    const c3 = db.prepare('SELECT * FROM circuits WHERE id=3').get()
    const INJECTED_PAYOUT = 500
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
    // 已赔付的越站理赔单：赔款与额度占用都应随越站对称冲回
    db.prepare(`INSERT INTO incidents (race_id,season,circuit_id,level,cause,damage,repair_cost,assessed,payout,claim_id,status,created_at,reported_at,assessed_at,paid_at)
      VALUES (?,?,?, 'crash','越站坠毁',30,750,750,?,?, 'paid', ?,?,?,?)`)
      .run(raceId3, season, 3, INJECTED_PAYOUT, polId, ts, ts, ts, ts)
    db.prepare('UPDATE insurance SET paid_total=paid_total+? WHERE id=?').run(INJECTED_PAYOUT, polId)
    // 另注入一条「已报案未赔付」的越站理赔单（第 4 站），验证未决单只作废不冲钱
    const c4 = db.prepare('SELECT * FROM circuits WHERE id=4').get()
    const fake4 = { ...fake, circuit: { id: 4, name: c4.name, diff: c4.diff, weather: c4.weather }, incident: { level: 'major', damage: 18, cause: '越站受损' } }
    db.prepare('UPDATE circuits SET finished=1, rank=4 WHERE id=4').run()
    const raceId4 = db.prepare(`INSERT INTO races (circuit_id,season,status,settled,rank,pts,money,wear,rep_gain,record,watch_el,created_at,created_ts,settled_at)
      VALUES (4,?,'settled',1,4,12,900,9,2,?,0,?,?,?)`)
      .run(season, JSON.stringify(fake4), ts, Date.now(), ts).lastInsertRowid
    db.prepare(`INSERT INTO incidents (race_id,season,circuit_id,level,cause,damage,status,created_at,reported_at)
      VALUES (?,?,?, 'major','越站受损',18,'reported',?,?)`)
      .run(raceId4, season, 4, ts, ts)
    db.exec('COMMIT')
    db.close()
    // 重启服务器触发启动迁移修复
    proc.kill('SIGKILL'); proc = null; await sleep(150)
    proc = startServer(dir, PORT)
    const post2 = await waitReady(PORT)
    // 资金冲回分项：越站奖金 1200+900、越站已赔付赔款 500；因越站记录被对账撤销的合约奖励
    const revokedRewards = pre.contracts
      .filter(c => c.earned && !(post2.contracts.find(x => x.id === c.id)?.earned))
      .reduce((a, c) => a + c.reward, 0)
    eq('合约冲回项非负（越站完赛可影响条款）', revokedRewards >= 0, true)
    eq('越站资金（奖金+赔款+对账合约）已冲回', Math.round(post2.team.money), Math.round(moneyPre - 1200 - 900 - INJECTED_PAYOUT - revokedRewards))
    const db2 = new DatabaseSync(path.join(dir, 'sky.db'))
    const voidRace = db2.prepare("SELECT status FROM races WHERE circuit_id=3").get()
    eq('越站记录置 void', voidRace.status, 'void')
    const inc3 = db2.prepare("SELECT i.status FROM incidents i JOIN races r ON r.id=i.race_id WHERE r.circuit_id=3").get()
    eq('越站已赔付理赔单作废', inc3.status, 'void')
    const inc4 = db2.prepare("SELECT i.status FROM incidents i JOIN races r ON r.id=i.race_id WHERE r.circuit_id=4").get()
    eq('越站未决理赔单作废', inc4.status, 'void')
    const inc1 = db2.prepare("SELECT status,payout FROM incidents WHERE race_id=?").get(r6.race.started.race.id)
    eq('第 1 站合法理赔仍为 paid', inc1.status, 'paid')
    eq('第 1 站赔款未被冲回', inc1.payout, pay6.payout)
    const pol1 = db2.prepare("SELECT status,paid_total,quota FROM insurance WHERE id=?").get(polId)
    eq('越站冲回后保单仍保障中', pol1.status, 'active')
    eq('年度额度仅恢复越站赔款部分', pol1.paid_total, pay6.payout)
    eq('保单年度额度口径', pol1.quota, 36000)
    db2.close()

    console.log('\n[历史保单兼容] 老行迁移补齐年度额度；老 active 保单按新制连续理赔')
    // 模拟老库：直接插入一行没有 quota/paid_total 的 active 保单（老 schema）
    await post(PORT, '/api/reset')
    const dbL = new DatabaseSync(path.join(dir, 'sky.db'))
    const seasonL = dbL.prepare('SELECT season FROM team').get().season
    dbL.prepare(`INSERT INTO insurance (plan_id,name,season,premium,coverage,max_payout,status,created_at)
      VALUES (2,'云安·全程护艇险',?,2600,0.75,7000,'active',?)`).run(seasonL, String(Date.now()))
    dbL.close()
    proc.kill('SIGKILL'); proc = null; await sleep(150)
    proc = startServer(dir, PORT)
    const stL = await waitReady(PORT)
    eq('老 active 保单迁移出年度额度', stL.insurance.policy.quota, 15000)
    eq('老保单已赔付初始为 0', stL.insurance.policy.paidTotal, 0)
    eq('老保单状态保持有效', stL.insurance.policy.status, 'active')
    // 老保单按新制连续理赔（两起注入事故）
    const ridA = injectIncidentRace(dir, { circuitId: 1, damage: 20, season: seasonL })
    const ridB = injectIncidentRace(dir, { circuitId: 2, damage: 12, season: seasonL })
    const repA = await post(PORT, `/api/incidents/${ridA}/report`, {})
    ok('老保单可报案（新制）', repA.ok)
    const assA = await post(PORT, `/api/incidents/${repA.incident.id}/assess`, {})
    eq('老保单定损口径不变', assA.incident.assessed, 20 * 25)
    const payA = await post(PORT, `/api/incidents/${repA.incident.id}/payout`, {})
    eq('老保单按 75% 赔付', payA.payout, Math.round(500 * 0.75))
    const repB = await post(PORT, `/api/incidents/${ridB}/report`, {})
    const assB = await post(PORT, `/api/incidents/${repB.incident.id}/assess`, {})
    const payB = await post(PORT, `/api/incidents/${repB.incident.id}/payout`, {})
    eq('老保单可连续理赔', payB.payout, Math.round(300 * 0.75))
    const stL2 = await api(PORT, '/api/state')
    eq('老保单年度额度累计', stL2.insurance.policy.paidTotal, Math.round(500 * 0.75) + Math.round(300 * 0.75))

    console.log('\n[历史保单兼容] 老 claimed 保单（单季一次制）保持结案，不再赔付')
    await post(PORT, '/api/reset')
    const dbC = new DatabaseSync(path.join(dir, 'sky.db'))
    const seasonC0 = dbC.prepare('SELECT season FROM team').get().season
    const tsC = String(Date.now())
    // 老库结案现场：第 1 站合法完赛 + 已赔付理赔单 + claimed 保单（无额度列）
    const c1 = dbC.prepare('SELECT * FROM circuits WHERE id=1').get()
    const recC = {
      v: 1, circuit: { id: 1, name: c1.name, diff: c1.diff, weather: c1.weather }, season: seasonC0,
      segments: [], factors: { weather: c1.weather, rental: null, lineup: { shipMode: 'own' }, mods: [], pilot: null, mech: null, base: {} },
      racers: [], events: [],
      result: { rank: 2, pts: 18, money: 1000, wear: 8, repGain: 4 },
      incident: { level: 'major', damage: 20, cause: '老库事故' }
    }
    dbC.exec('BEGIN')
    dbC.prepare('UPDATE circuits SET finished=1, rank=2 WHERE id=1').run()
    const ridC = dbC.prepare(`INSERT INTO races (circuit_id,season,status,settled,rank,pts,money,wear,rep_gain,record,watch_el,created_at,created_ts,settled_at)
      VALUES (1,?,'settled',1,2,18,1000,8,4,?,0,?,?,?)`)
      .run(seasonC0, JSON.stringify(recC), tsC, Date.now(), tsC).lastInsertRowid
    const legPolId = Number(dbC.prepare(`INSERT INTO insurance (plan_id,name,season,premium,coverage,max_payout,status,created_at,claimed_at)
      VALUES (2,'云安·全程护艇险',?,2600,0.75,7000,'claimed',?,?)`).run(seasonC0, tsC, tsC).lastInsertRowid)
    const legIncId = Number(dbC.prepare(`INSERT INTO incidents (race_id,season,circuit_id,level,cause,damage,repair_cost,assessed,payout,claim_id,status,created_at,reported_at,assessed_at,paid_at)
      VALUES (?,?,?,'major','老库事故',20,500,500,375,?,'paid',?,?,?,?)`)
      .run(ridC, seasonC0, 1, legPolId, tsC, tsC, tsC, tsC).lastInsertRowid)
    dbC.prepare('UPDATE insurance SET claimed_incident_id=? WHERE id=?').run(legIncId, legPolId)
    dbC.exec('COMMIT')
    dbC.close()
    proc.kill('SIGKILL'); proc = null; await sleep(150)
    proc = startServer(dir, PORT)
    const stC0 = await waitReady(PORT)
    eq('老 claimed 保单迁移出年度额度', stC0.insurance.policy.quota, 15000)
    eq('老 claimed 保单回填已赔付', stC0.insurance.policy.paidTotal, 375)
    eq('老 claimed 保单保持结案', stC0.insurance.policy.status, 'claimed')
    // 新事故可报案定损留档，但赔付被老保单结案态拦截
    const ridD = injectIncidentRace(dir, { circuitId: 2, damage: 10, season: seasonC0 })
    const repD = await post(PORT, `/api/incidents/${ridD}/report`, {})
    ok('老 claimed 保单项下仍可报案留档', repD.ok)
    const assD = await post(PORT, `/api/incidents/${repD.incident.id}/assess`, {})
    ok('老 claimed 保单项下仍可定损', assD.ok)
    const payD = await post(PORT, `/api/incidents/${repD.incident.id}/payout`, {})
    eq('老 claimed 保单不再赔付', payD.ok, false)
    ok('拦截原因指向旧制结案', /已理赔结案/.test(payD.msg || ''))

    console.log('\n[历史保单兼容] 老 claimed 保单的已赔付事故越站 → 对称恢复为有效')
    // 把老库结案现场搬到越站（第 3 站，跳过 1-2 站）：迁移补齐额度后，越站冲回应恢复保单
    await post(PORT, '/api/reset')
    const dbE = new DatabaseSync(path.join(dir, 'sky.db'))
    const seasonE = dbE.prepare('SELECT season FROM team').get().season
    const tsE = String(Date.now())
    const c3E = dbE.prepare('SELECT * FROM circuits WHERE id=3').get()
    const recE = {
      v: 1, circuit: { id: 3, name: c3E.name, diff: c3E.diff, weather: c3E.weather }, season: seasonE,
      segments: [], factors: { weather: c3E.weather, rental: null, lineup: { shipMode: 'own' }, mods: [], pilot: null, mech: null, base: {} },
      racers: [], events: [],
      result: { rank: 2, pts: 18, money: 1000, wear: 8, repGain: 4 },
      incident: { level: 'major', damage: 20, cause: '老库越站事故' }
    }
    dbE.exec('BEGIN')
    dbE.prepare('UPDATE circuits SET finished=1, rank=2 WHERE id=3').run()
    const ridE = dbE.prepare(`INSERT INTO races (circuit_id,season,status,settled,rank,pts,money,wear,rep_gain,record,watch_el,created_at,created_ts,settled_at)
      VALUES (3,?,'settled',1,2,18,1000,8,4,?,0,?,?,?)`)
      .run(seasonE, JSON.stringify(recE), tsE, Date.now(), tsE).lastInsertRowid
    const legPolId2 = Number(dbE.prepare(`INSERT INTO insurance (plan_id,name,season,premium,coverage,max_payout,status,created_at,claimed_at)
      VALUES (2,'云安·全程护艇险',?,2600,0.75,7000,'claimed',?,?)`).run(seasonE, tsE, tsE).lastInsertRowid)
    const legIncId2 = Number(dbE.prepare(`INSERT INTO incidents (race_id,season,circuit_id,level,cause,damage,repair_cost,assessed,payout,claim_id,status,created_at,reported_at,assessed_at,paid_at)
      VALUES (?,?,?,'major','老库越站事故',20,500,500,375,?,'paid',?,?,?,?)`)
      .run(ridE, seasonE, 3, legPolId2, tsE, tsE, tsE, tsE).lastInsertRowid)
    dbE.prepare('UPDATE insurance SET claimed_incident_id=? WHERE id=?').run(legIncId2, legPolId2)
    dbE.exec('COMMIT')
    dbE.close()
    proc.kill('SIGKILL'); proc = null; await sleep(150)
    proc = startServer(dir, PORT)
    const stE = await waitReady(PORT)
    eq('越站冲回后老保单恢复有效', stE.insurance.policy.status, 'active')
    eq('越站赔款冲回后已赔付归零', stE.insurance.policy.paidTotal, 0)
    eq('年度额度完全恢复', stE.insurance.policy.remaining, 15000)
    // 恢复后的老保单可按新制连续理赔
    const ridF = injectIncidentRace(dir, { circuitId: 1, damage: 10, season: seasonE })
    const repF = await post(PORT, `/api/incidents/${ridF}/report`, {})
    const assF = await post(PORT, `/api/incidents/${repF.incident.id}/assess`, {})
    const payF = await post(PORT, `/api/incidents/${repF.incident.id}/payout`, {})
    eq('恢复后的老保单可重新赔付', payF.payout, Math.round(250 * 0.75))

    console.log('\n[并发幂等·年度额度封顶] 并发抢额度不越上限，同一事故只赔一次')
    await post(PORT, '/api/reset')
    const buyQ = await post(PORT, '/api/insurance/buy', { id: 1 })  // 额度 6000 / 单次上限 3000 / 比例 50%
    ok('投保成功', buyQ.ok)
    const stQ0 = await api(PORT, '/api/state')
    const seasonQ = stQ0.team.season
    const moneyAfterBuyQ = stQ0.team.money
    // 注入 4 起已结算事故：损伤 160 → 定损 4000 → 单笔赔付 min(2000, 3000, 剩余额度) = 2000；额度仅够 3 起
    const raceIds = [1, 2, 3, 4].map(cid => injectIncidentRace(dir, { circuitId: cid, damage: 160, level: 'crash', season: seasonQ }))
    const incIds = []
    for (const rid of raceIds) {
      const repQ = await post(PORT, `/api/incidents/${rid}/report`, {})
      assert.ok(repQ.ok, '注入事故报案失败')
      const assQ = await post(PORT, `/api/incidents/${repQ.incident.id}/assess`, {})
      eq('注入事故定损=160×25', assQ.incident.assessed, 4000)
      incIds.push(repQ.incident.id)
    }
    // 每起事故同时发两笔赔付请求（8 个并发）
    const resps = await Promise.all(incIds.flatMap(id => [post(PORT, `/api/incidents/${id}/payout`, {}), post(PORT, `/api/incidents/${id}/payout`, {})]))
    const byInc = incIds.map((id, i) => resps.slice(i * 2, i * 2 + 2))
    let paidCount = 0, paidSum = 0
    byInc.forEach(rs => {
      const wins = rs.filter(r => r.ok && !r.already)
      const idem = rs.filter(r => r.ok && r.already)
      const denied = rs.filter(r => !r.ok)
      if (wins.length) {
        eq('同一起事故并发只赔付一次', wins.length, 1)
        eq('该起另一笔并发请求幂等返回', idem.length, 1)
        paidCount++
        paidSum += wins[0].payout
      } else {
        eq('额度耗尽的事故两笔并发均被拒', denied.length, 2)
      }
    })
    eq('年度额度 6000 恰好承保 3 起（2000×3）', paidCount, 3)
    eq('并发赔付总额不越年度额度', paidSum, 6000)
    const stQ = await api(PORT, '/api/state')
    eq('已赔付封顶于年度额度', stQ.insurance.policy.paidTotal, 6000)
    eq('剩余额度归零', stQ.insurance.policy.remaining, 0)
    eq('赔款总额到账', stQ.team.money, moneyAfterBuyQ + 6000)
    // 额度用尽后：仍可报案定损留档，仅赔付关闭
    const ridG = injectIncidentRace(dir, { circuitId: 5, damage: 10, season: seasonQ })
    const repG = await post(PORT, `/api/incidents/${ridG}/report`, {})
    ok('额度用尽仍可报案留档', repG.ok)
    const assG = await post(PORT, `/api/incidents/${repG.incident.id}/assess`, {})
    ok('额度用尽仍可定损', assG.ok)
    const payG = await post(PORT, `/api/incidents/${repG.incident.id}/payout`, {})
    eq('额度用尽赔付被拒', payG.ok, false)
    const insView = await api(PORT, '/api/insurance')
    const deniedInc = insView.incidents.find(i => i.status === 'assessed')
    ok('额度用尽事故的可执行动作提示关闭赔付', !!(deniedInc && deniedInc.elig && !deniedInc.elig.canPayout && /额度/.test(deniedInc.elig.reason)))

    proc.kill('SIGKILL'); proc = null; await sleep(120)
    rmSync(dir, { recursive: true, force: true })
  } finally {
    if (proc) proc.kill('SIGKILL')
    rmSync(dir, { recursive: true, force: true })
  }
  console.log(`\n🎉 全部 ${pass} 项断言通过：年度额度制下的投保/连续报案定损赔付/额度封顶/并发幂等/租约押金/维修/资金声望/赛季归档/越站冲回/历史保单兼容一致`)
}
main().catch(e => { console.error('\n❌ 验证失败：', e); process.exit(1) })
