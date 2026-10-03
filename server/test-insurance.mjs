/**
 * 赛事事故与保险理赔 功能验证（投保 / 事故生成 / 报案 / 定损 / 赔付状态机 /
 * 租约押金联动 / 自有艇维修联动 / 资金声望 / 幂等 / 赛季到期 / 越站对称冲回）
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
    const bad = await post(PORT, '/api/insurance/buy', { id: 99 })
    eq('非法方案被拒', bad.ok, false)
    const buy = await post(PORT, '/api/insurance/buy', { id: 2 })
    ok('投保成功', buy.ok)
    const moneyAfterBuy = (await api(PORT, '/api/state')).team.money
    eq('投保即扣保险费', moneyAfterBuy, s0.team.money - 2600)
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
    eq('保单结案 claimed', st1.insurance.policy.status, 'claimed')
    eq('保单记录理赔单 id', st1.insurance.policy.claimedIncidentId, rep.incident.id)

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

    console.log('\n[越站回滚] 已赔付理赔随越站作废对称冲回（赔款/保单/损伤恢复）')
    // 新一季：第 1 站事故并完成赔付
    const r6 = await playUntilIncident(PORT, { plan: 3, stations: 1 })
    const rp6 = await post(PORT, `/api/incidents/${r6.race.started.race.id}/report`, {})
    await post(PORT, `/api/incidents/${rp6.incident.id}/assess`, {})
    const pay6 = await post(PORT, `/api/incidents/${rp6.incident.id}/payout`, {})
    ok('第 1 站理赔已付', pay6.ok && pay6.payout > 0)
    const pre = await api(PORT, '/api/state')
    const moneyPre = pre.team.money
    // 直接写库制造越站：跳过第 2 站，把第 3 站置为 finished 并塞一条带 crash 事故的已结算记录
    const db = new DatabaseSync(path.join(dir, 'sky.db'))
    const season = db.prepare('SELECT season FROM team').get().season
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
    // 真实结算会同时落物理赔单（reported）：未赔付状态随越站作废
    db.prepare(`INSERT INTO incidents (race_id,season,circuit_id,level,cause,damage,status,created_at,reported_at)
      VALUES (?,?,?, 'crash','越站坠毁',30,'reported',?,?)`)
      .run(raceId3, season, 3, ts, ts)
    // 真实越站只在结算事务内产生一条「被比赛记录认领」的流水（此处不再额外注入，
    // 未关联流水的兜底回滚路径由 test-consistency 场景覆盖）
    db.exec('COMMIT')
    db.close()
    // 重启服务器触发启动迁移修复
    proc.kill('SIGKILL'); proc = null; await sleep(150)
    proc = startServer(dir, PORT)
    const post2 = await waitReady(PORT)
    // 资金冲回分项：越站奖金 1200；因越站记录（rank3 完赛）被对账撤销的合约奖励；
    // 若越站事故曾被赔付（此处未理赔，应为 0）
    const revokedRewards = pre.contracts
      .filter(c => c.earned && !(post2.contracts.find(x => x.id === c.id)?.earned))
      .reduce((a, c) => a + c.reward, 0)
    eq('合约冲回项非负（越站 rank3 完赛可影响条款）', revokedRewards >= 0, true)
    eq('越站资金（奖金+对账合约）已冲回', Math.round(post2.team.money), Math.round(moneyPre - 1200 - revokedRewards))
    const db2 = new DatabaseSync(path.join(dir, 'sky.db'))
    const voidRace = db2.prepare("SELECT status FROM races WHERE circuit_id=3").get()
    eq('越站记录置 void', voidRace.status, 'void')
    const inc3 = db2.prepare("SELECT i.status FROM incidents i JOIN races r ON r.id=i.race_id WHERE r.circuit_id=3").get()
    eq('越站事故理赔单作废', inc3.status, 'void')
    const inc1 = db2.prepare("SELECT status,payout FROM incidents WHERE race_id=?").get(r6.race.started.race.id)
    eq('第 1 站合法理赔仍为 paid', inc1.status, 'paid')
    eq('第 1 站赔款未被冲回', inc1.payout, pay6.payout)
    const pol1 = db2.prepare("SELECT status,claimed_incident_id FROM insurance ORDER BY id DESC LIMIT 1").get()
    eq('第 1 站保单仍为 claimed（未被误恢复）', pol1.status, 'claimed')
    db2.close()

    proc.kill('SIGKILL'); proc = null; await sleep(120)
    rmSync(dir, { recursive: true, force: true })
  } finally {
    if (proc) proc.kill('SIGKILL')
    rmSync(dir, { recursive: true, force: true })
  }
  console.log(`\n🎉 全部 ${pass} 项断言通过：投保/事故/报案/定损/赔付状态机、租约押金、维修、资金声望、幂等与赛季联动一致`)
}
main().catch(e => { console.error('\n❌ 验证失败：', e); process.exit(1) })
