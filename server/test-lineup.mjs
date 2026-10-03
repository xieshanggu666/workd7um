/**
 * 赛事排班 功能验证（排班解析 / 开赛快照 / 结算归属 / 租约联动）
 *
 * 用法：node server/test-lineup.mjs
 * 在临时目录里起一份独立 DB 与独立端口的真实服务，跑完即销毁，不污染开发库。
 */
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
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sky-lineup-'))
  cpSync(path.join(__dirname, 'db.js'), path.join(dir, 'db.js'))
  cpSync(path.join(__dirname, 'index.js'), path.join(dir, 'index.js'))
  symlinkSync(path.join(__dirname, '..', 'node_modules'), path.join(dir, 'node_modules'), 'dir')
  return dir
}
async function waitReady(port) {
  for (let i = 0; i < 100; i++) {
    try { const s = await api(port, '/api/state'); if (s?.team) return s } catch { /* wait */ }
    await sleep(80)
  }
  throw new Error('server not ready')
}

async function scenario() {
  console.log('\n[排班] 解析 → 开赛快照 → 结算归属 → 租约/自有艇排班联动')
  const PORT = 4407
  const dir = makeSandbox()
  let proc
  try {
    proc = spawn(process.execPath, ['index.js'], { cwd: dir, env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' })
    const s0 = await waitReady(PORT)

    /* ---- 1. 默认排班：全自动，解析出最强阵容与自有艇 ---- */
    ok('状态携带排班视图', !!s0.lineup && !!s0.lineup.resolved)
    eq('默认出赛艇模式 auto', s0.lineup.shipMode, 'auto')
    ok('默认机师为自动', s0.lineup.resolved.pilot.auto)
    ok('默认技工为自动', s0.lineup.resolved.mech.auto)
    eq('默认出赛艇为自有艇', s0.lineup.resolved.ship.kind, 'own')
    const autoPilot = s0.lineup.resolved.pilot.id
    const otherPilot = s0.pilots.find(p => p.id !== autoPilot).id
    const expOf = (s, id) => s.pilots.find(p => p.id === id).exp

    /* ---- 2. 开赛快照：记录锁定排班解析结果，赛后改排班不影响 ---- */
    const r1 = await post(PORT, '/api/races/start/1', {})
    ok('第 1 站开赛成功', r1.ok)
    eq('记录快照为自动排班', r1.race.record.factors.lineup.shipMode, 'auto')
    eq('记录机师=自动机师', r1.race.record.factors.pilot.id, autoPilot)
    // 开赛后立即改排班：已生成的记录绝不变
    const set1 = await post(PORT, '/api/lineup', { pilotId: otherPilot })
    ok('改排班成功', set1.ok)
    const r1again = await api(PORT, `/api/races/${r1.race.id}`)
    eq('改排班后记录机师仍为快照', r1again.race.record.factors.pilot.id, autoPilot)
    const expAuto0 = expOf(s0, autoPilot), expOther0 = expOf(s0, otherPilot)
    const st1 = await post(PORT, `/api/races/${r1.race.id}/settle`, {})
    ok('第 1 站结算成功', st1.ok)
    const s1 = await api(PORT, '/api/state')
    const gain1 = r1.race.record.result.rank <= 4 ? 3 : 1
    eq('经验发给快照机师（非新排班机师）', expOf(s1, autoPilot), expAuto0 + gain1)
    eq('新排班机师本场未获经验', expOf(s1, otherPilot), expOther0)

    /* ---- 3. 指定排班用于下一站：机师+技工都按排班进记录、进结算 ---- */
    const hire = await post(PORT, '/api/hire_mech', {})
    ok('招募第二名技工', hire.ok)
    const s2 = await api(PORT, '/api/state')
    const mech2 = s2.mechanics.find(m => m.id !== s0.lineup.resolved.mech.id).id
    const set2 = await post(PORT, '/api/lineup', { mechanicId: mech2 })
    ok('指定技工成功', set2.ok)
    eq('排班视图保留此前指定的机师（省略字段不变）', set2.pilotId, otherPilot)
    eq('排班视图技工已更新', set2.mechanicId, mech2)
    const r2 = await post(PORT, '/api/races/start/2', {})
    ok('第 2 站开赛成功', r2.ok)
    eq('记录机师=排班机师', r2.race.record.factors.pilot.id, otherPilot)
    eq('记录技工=排班技工', r2.race.record.factors.mech.id, mech2)
    eq('记录排班快照含指定机师', r2.race.record.factors.lineup.pilotId, otherPilot)
    const st2 = await post(PORT, `/api/races/${r2.race.id}/settle`, {})
    ok('第 2 站结算成功', st2.ok)
    const s3 = await api(PORT, '/api/state')
    const gain2 = r2.race.record.result.rank <= 4 ? 3 : 1
    eq('经验发给排班机师', expOf(s3, otherPilot), expOther0 + gain2)

    /* ---- 4. 非法排班被服务端拒绝 ---- */
    const bad1 = await post(PORT, '/api/lineup', { pilotId: 99999 })
    eq('不存在的机师被拒绝', bad1.ok, false)
    const bad2 = await post(PORT, '/api/lineup', { shipMode: 'submarine' })
    eq('非法出赛艇模式被拒绝', bad2.ok, false)
    const s4 = await api(PORT, '/api/state')
    eq('非法请求未污染排班', s4.lineup.pilotId, otherPilot)

    /* ---- 5. 排班租赁艇：无租约拦截开赛，签约后租约艇出赛并计场次 ---- */
    const setR = await post(PORT, '/api/lineup', { shipMode: 'rental' })
    ok('切租赁艇模式成功', setR.ok)
    ok('缺租约警告出现', setR.rentalMissing)
    const r3deny = await post(PORT, '/api/races/start/3', {})
    eq('无租约时拒绝开赛', r3deny.ok, false)
    const rent = await post(PORT, '/api/rentals/rent', { id: 1 }) // 雨燕·轻竞技
    ok('签约租艇成功', rent.ok)
    const r3 = await post(PORT, '/api/races/start/3', {})
    ok('签约后开赛成功', r3.ok)
    eq('记录为租约艇出赛', r3.race.record.factors.rental.name, '雨燕·轻竞技')
    eq('记录排班快照=rental', r3.race.record.factors.lineup.shipMode, 'rental')
    const wear3 = r3.race.record.result.wear
    const dmg3 = r3.race.record.incident?.damage || 0
    await post(PORT, `/api/races/${r3.race.id}/settle`, {})
    const s5 = await api(PORT, '/api/state')
    eq('租约场次计入', s5.rental.races_used, 1)
    eq('租约累计磨损计入（含事故损伤）', s5.rental.wear_total, wear3 + dmg3)
    eq('出赛艇镜像租约艇部件健康', s5.airship.parts_dur, 100 - wear3 - dmg3)
    const maintainDenied = await post(PORT, '/api/maintain', {})
    eq('租约艇出赛排班下维护被拒', maintainDenied.ok, false)

    /* ---- 6. 排班自有艇：租约在履但自有艇出赛，租约场次不消耗 ---- */
    const setO = await post(PORT, '/api/lineup', { shipMode: 'own' })
    ok('切自有艇模式成功', setO.ok)
    eq('解析出赛艇=自有艇', setO.resolved.ship.kind, 'own')
    const r4 = await post(PORT, '/api/races/start/4', {})
    ok('第 4 站开赛成功', r4.ok)
    eq('记录为自有艇出赛（无租约快照）', r4.race.record.factors.rental, null)
    // 自有艇累计磨损 = 第 1、2 站（租约前）+ 第 4 站（排班自有艇）；第 3 站租约艇出赛不计。
    // 事故损伤与正常磨损同口径归属出赛艇，一并计入
    const recWear = r => r.race.record.result.wear + (r.race.record.incident?.damage || 0)
    const ownWear = recWear(r1) + recWear(r2) + recWear(r4)
    await post(PORT, `/api/races/${r4.race.id}/settle`, {})
    const s6 = await api(PORT, '/api/state')
    eq('自有艇按各场记录累计磨损（租约场不计，含事故）', s6.airship.parts_dur, 100 - ownWear)
    eq('租约场次未被消耗', s6.rental.races_used, 1)
    eq('租约磨损未增加', s6.rental.wear_total, wear3 + dmg3)
    const maintainOk = await post(PORT, '/api/maintain', {})
    ok('自有艇出赛排班下可维护', maintainOk.ok)
    const s7 = await api(PORT, '/api/state')
    eq('维护后部件恢复 100', s7.airship.parts_dur, 100)

    /* ---- 7. 恢复自动：租约在履即回到租约艇 ---- */
    const setA = await post(PORT, '/api/lineup', { shipMode: 'auto', pilotId: null, mechanicId: null })
    ok('恢复全自动排班', setA.ok)
    eq('自动模式解析出租约艇', setA.resolved.ship.kind, 'rental')
    ok('机师恢复自动', setA.resolved.pilot.auto)

    proc.kill('SIGKILL'); proc = null; await sleep(120)
  } finally { if (proc) proc.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }) }
}

const run = async () => {
  await scenario()
  console.log(`\n🎉 全部 ${pass} 项断言通过：排班解析、开赛快照、结算归属与租约联动一致`)
}
run().catch(e => { console.error('\n❌ 验证失败：', e); process.exit(1) })
