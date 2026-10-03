/**
 * 赛季合约引擎纯逻辑测试（不依赖 node:sqlite）：
 * 从 server/index.js 抽取真实源码片段，注入最小 DB 桩后直接验证
 * 条款匹配 / 进度累计 / need 判定 / 展示文案，避免复制实现造成"测的不是线上代码"。
 * 用法：node server/test-contracts-logic.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const src = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8')

// 抽取需要的常量与函数源码（以注释锚点/函数签名切出，保证与上线代码同源）
const weatherConst = src.match(/const WEATHER = \{[^}]+\}/)[0]
const rentalBlock = src.slice(src.indexOf('const RENTAL_SHIPS = ['), src.indexOf('function seed()'))
const engineBlock = src.slice(src.indexOf('function parseTerms('), src.indexOf('// 历史数据兼容（迁移补偿）'))

// DB 桩：rental 表内容由测试注入
let rentals = []
const dbStub = {
  get: (sql, id) => /ship_id FROM rentals/.test(sql) ? (rentals.find(r => r.id === id) || null) : null,
  all: () => [], run: () => {}
}
const teamNow = { season: 1, season_pts: 0 }
const factory = new Function('all', 'get', 'run', 'teamCore', 'now', `
${weatherConst}
${rentalBlock}
${engineBlock}
return { termProgress, contractView, reconcileContracts, contractsPayload, termLabel, raceShipId, CONTRACTS }
`)
const api = factory(dbStub.all, dbStub.get, dbStub.run, () => teamNow, () => 't')

let pass = 0
const ok = (n, c) => { assert.ok(c, n); pass++; console.log('  ✅ ' + n) }
const eq = (n, a, b) => { assert.equal(a, b, `${n}（期望 ${b}，实际 ${a}）`); pass++; console.log('  ✅ ' + n) }

const R = (over = {}) => ({
  circuit: { id: 1, weather: over.weather ?? '晴' },
  factors: { weather: over.weather ?? '晴', rental: over.rental ?? null },
  result: { rank: over.rank ?? 5, pts: over.pts ?? 10, money: 800, wear: 8, repGain: 2 }
})

// 1) 天气条款
eq('雷暴完赛 1/1', api.termProgress({ type: 'weather', weather: '雷暴', value: 1 }, [R({ weather: '雷暴' })], 0).reached, true)
eq('雨场不计入雷暴条款', api.termProgress({ type: 'weather', weather: '雷暴', value: 1 }, [R({ weather: '雨' })], 0).value, 0)
eq('任意天气累计场次', api.termProgress({ type: 'weather', weather: '*', value: 2 }, [R(), R(), R()], 0).value, 3)

// 2) 名次条款
eq('第 3 名命中前 3', api.termProgress({ type: 'rank', rankMax: 3, value: 2 }, [R({ rank: 1 }), R({ rank: 3 }), R({ rank: 4 })], 0).value, 2)
eq('第 4 名不命中前 3', api.termProgress({ type: 'rank', rankMax: 3, value: 1 }, [R({ rank: 4 })], 0).reached, false)

// 3) 租赁艇条款（含指定艇型；老记录无 shipId 时查租约行回推）
const rtRace = R({ rental: { id: 9, shipId: 4, name: '星凰·旗舰' } })
eq('指定艇型 4 命中', api.termProgress({ type: 'rental', ship: 4, value: 1 }, [rtRace], 0).reached, true)
eq('指定艇型 2 不命中', api.termProgress({ type: 'rental', ship: 2, value: 1 }, [rtRace], 0).reached, false)
eq('自有艇不计租赁场次', api.termProgress({ type: 'rental', value: 1 }, [R()], 0).value, 0)
rentals = [{ id: 9, ship_id: 2 }]
const oldRace = R({ rental: { id: 9, name: '猎鹰·巡航者' } }) // 老快照无 shipId
eq('老记录按租约行回推艇型 id=2', api.raceShipId(oldRace), 2)
eq('老记录回推艇型后命中 ship=2', api.termProgress({ type: 'rental', ship: 2, value: 1 }, [oldRace], 0).reached, true)

// 4) 复合条款：同一场同时满足天气+名次+租赁艇
const hero = R({ weather: '雷暴', rank: 1, rental: { id: 9, shipId: 4, name: '星凰·旗舰' } })
const composite = { type: 'race', weather: '雷暴', rankMax: 1, ship: 4, value: 1 }
eq('复合条款同场全中', api.termProgress(composite, [hero], 0).reached, true)
eq('天气不符则不命中（不能跨场拼凑）', api.termProgress(composite, [R({ weather: '晴', rank: 1, rental: { id: 9, shipId: 4 } })], 0).value, 0)
eq('名次不符则不命中', api.termProgress(composite, [R({ weather: '雷暴', rank: 2, rental: { id: 9, shipId: 4 } })], 0).value, 0)
eq('租赁艇缺失不命中', api.termProgress(composite, [R({ weather: '雷暴', rank: 1 })], 0).value, 0)
eq('跨场条件不能拼凑', api.termProgress(composite, [R({ weather: '雷暴' }), R({ rank: 1 }), R({ rental: { id: 9, shipId: 4 } })], 0).value, 0)

// 5) 积分条款
eq('积分条款按 team.season_pts', api.termProgress({ type: 'points', value: 45 }, [], 45).reached, true)

// 6) 合约级 need 判定（流风动力：领奖台 2 场 或 租赁艇 1 场，need=1 → 任一达成即兑现）
{
  const c3 = api.CONTRACTS.find(c => c.id === 3)
  const row = { id: 3, need: c3.need, terms: JSON.stringify({ v: 1, terms: c3.terms }) }
  eq('need=1：租赁 1 场即兑现（领奖台不足 2 场）',
    api.contractView(row, [R({ rank: 2, rental: { id: 9, shipId: 1 } }), R({ rank: 5 })], 10).reached, true)
  eq('need=1：领奖台 2 场即兑现（无租赁艇）',
    api.contractView(row, [R({ rank: 2 }), R({ rank: 1 }), R({ rank: 6 })], 10).reached, true)
  eq('两条都不达成则不兑现（只有 1 次领奖台、无租赁）',
    api.contractView(row, [R({ rank: 2 }), R({ rank: 5 })], 10).reached, false)
}

// 7) 苍穹商会：积分 + 复合条款必须同时达成
{
  const c4 = api.CONTRACTS.find(c => c.id === 4)
  const row = { id: 4, need: 2, terms: JSON.stringify({ v: 1, terms: c4.terms }) }
  eq('复合达成但积分不足→不兑现', api.contractView(row, [hero], 30).reached, false)
  eq('积分足但缺复合场→不兑现', api.contractView(row, [R()], 46).reached, false)
  eq('积分与复合场同时满足→兑现', api.contractView(row, [hero], 46).reached, true)
}

// 8) 文案
eq('天气文案', api.termLabel({ type: 'weather', weather: '雾', value: 1 }), '雾完赛 1 场')
eq('名次文案', api.termLabel({ type: 'rank', rankMax: 3, value: 2 }), '前 3 名完赛 2 场')
eq('租赁指定艇型文案', api.termLabel({ type: 'rental', ship: 4, value: 1 }), '驾驶星凰·旗舰完赛 1 场')
eq('复合文案', api.termLabel({ type: 'race', weather: '雷暴', rankMax: 1, ship: 4, value: 1 }), '雷暴、取得前 1 名、驾驶星凰·旗舰 1 场')
eq('积分文案', api.termLabel({ type: 'points', value: 45 }), '赛季积分达到 45')

console.log(`\n🎉 合约引擎 ${pass} 项纯逻辑断言通过`)
