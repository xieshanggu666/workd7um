import express from 'express'
import { db, run, all, get } from './db.js'

const app = express()
app.use(express.json())
const PORT = Number(process.env.PORT) || 4180
const PTS = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1]
// 天气对整场比赛的总体系数（用于部件磨损判定等）
const WEATHER = { '晴': 1.0, '风': 0.96, '雨': 0.9, '雾': 0.84, '雷暴': 0.78 }
// 天气对三个分段的发挥系数：雾/雷暴在「中段云流」「冲线段」压制更大
const SEG_WEATHER = {
  '晴':   [1.00, 1.00, 1.00],
  '风':   [0.99, 0.94, 0.96],
  '雨':   [0.94, 0.89, 0.91],
  '雾':   [0.92, 0.80, 0.85],
  '雷暴': [0.88, 0.72, 0.78]
}
// 三个分段：名称 + 四项性能在该段的权重（启航拼加速、中段拼极速转向、冲线拼极速爆发）
const SEGMENTS = [
  { key: 'start', name: '启航段', w: { speed: 0.28, turn: 0.14, acc: 0.30, dur: 0.10 } },
  { key: 'mid', name: '中段云流', w: { speed: 0.38, turn: 0.20, acc: 0.16, dur: 0.14 } },
  { key: 'finish', name: '冲线段', w: { speed: 0.40, turn: 0.14, acc: 0.20, dur: 0.14 } }
]
const SEG_K = 260           // 分段用时换算系数：t = SEG_K / pace（秒）
const AI_NAMES = ['苍穹极光', '翡翠之翼', '雷鸣环驾', '暮色猎手', '星尘漂流']
const AI_COLORS = ['#7ecbff', '#b19cff', '#6fe7d0', '#ff9fb0', '#ffb85c']
const PLAYER_COLOR = '#ffcf5c'
const FLAVOR = {
  '晴': ['晴空暖流，各艇全速巡航', '上升气流托举艇身，编队顺畅通航', '云絮拂面，引擎工况极佳'],
  '风': ['侧风突袭，舵面负荷加大！', '一阵横切气流扫过航线，队形被打乱', '逆风段来临，飞艇纷纷压低航向'],
  '雨': ['雨幕遮蔽视野，编队整体减速', '冰晶打在护甲上噼啪作响', '积雨云边缘湿滑，过弯需格外谨慎'],
  '雾': ['浓雾中能见度骤降，只能凭仪表飞行', '乳白雾气吞没了半个编队', '领航员紧盯着罗盘穿出雾团'],
  '雷暴': ['一道惊雷掠过，护甲承受冲击！', '雷暴电场干扰仪表，航向微微偏移', '闪电点亮云谷，众艇冒死突进']
}
const now = () => new Date().toLocaleString('zh-CN')
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
// 确定性伪随机：同一场比赛的分段过程与事件只生成一次，之后回放永远一致
function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/* ================= 零件商店：商品配置（服务端唯一事实来源） =================
 * 客户端只能按 id 下单；名称、槽位、加成项、加成数值与价格一律由服务端从这份配置取值，
 * 请求体中夹带的 price/bonus/stat/slot/name 一律忽略，杜绝「1 元购入 +9999 性能件」
 * 之类越权改写经济与比赛性能的请求。
 */
const VALID_SLOTS = ['引擎', '翼板', '氮气', '龙骨', '护甲']
const VALID_STATS = ['speed', 'turn', 'acc', 'dur']
const SHOP_ITEMS = [
  { id: 1, name: '竞速涡轮', slot: '引擎', stat: 'speed', bonus: 14, price: 2600 },
  { id: 2, name: '流线翼板', slot: '翼板', stat: 'speed', bonus: 9, price: 1800 },
  { id: 3, name: '氮气助推', slot: '氮气', stat: 'acc', bonus: 16, price: 2200 },
  { id: 4, name: '回旋舵', slot: '龙骨', stat: 'turn', bonus: 12, price: 2000 },
  { id: 5, name: '云母护甲', slot: '护甲', stat: 'dur', bonus: 15, price: 2400 },
  { id: 6, name: '轻量合金', slot: '翼板', stat: 'acc', bonus: 11, price: 1900 },
  { id: 7, name: '蓝纹喷射引擎', slot: '引擎', stat: 'speed', bonus: 20, price: 3200 },
  { id: 8, name: '硬壳鳞甲', slot: '护甲', stat: 'dur', bonus: 22, price: 3400 }
]
const SHOP_MAP = new Map(SHOP_ITEMS.map(i => [i.id, i]))
// 启动即自检：非法商品配置应在上线前暴露，而不是等玩家下单
for (const it of SHOP_ITEMS) {
  const ok = VALID_SLOTS.includes(it.slot) && VALID_STATS.includes(it.stat) &&
    Number.isInteger(it.bonus) && it.bonus > 0 && it.bonus <= 100 &&
    Number.isInteger(it.price) && it.price > 0 && typeof it.name === 'string' && it.name.trim()
  if (!ok) throw new Error('[SKY] 商店商品配置非法：' + JSON.stringify(it))
}

/* ================= 飞艇租赁：艇型目录（服务端唯一事实来源） =================
 * 与商店同口径：客户端只能按 id 签约；性能、押金、租金、租约场次与磨损费率一律以这份
 * 配置为准，请求体夹带的任何价格/性能字段都不被采信。押金+租金在签约时一次扣除，
 * 归还时按「累计磨损 × 磨损费率」从押金中结算退款（租金不退）。
 */
const RENTAL_SHIPS = [
  { id: 1, name: '雨燕·轻竞技', speed: 66, turn: 62, acc: 72, dur: 64, deposit: 2400, rent: 600, maxRaces: 2, wearRate: 35 },
  { id: 2, name: '猎鹰·巡航者', speed: 76, turn: 72, acc: 74, dur: 80, deposit: 4500, rent: 1200, maxRaces: 3, wearRate: 50 },
  { id: 3, name: '雷霆·竞速型', speed: 88, turn: 76, acc: 88, dur: 70, deposit: 7200, rent: 2000, maxRaces: 3, wearRate: 65 },
  { id: 4, name: '星凰·旗舰', speed: 97, turn: 91, acc: 93, dur: 90, deposit: 11000, rent: 3200, maxRaces: 4, wearRate: 85 }
]
const RENTAL_MAP = new Map(RENTAL_SHIPS.map(s => [s.id, s]))
for (const s of RENTAL_SHIPS) {
  const ok = ['speed', 'turn', 'acc', 'dur', 'deposit', 'rent', 'maxRaces', 'wearRate']
    .every(k => Number.isInteger(s[k]) && s[k] > 0) && typeof s.name === 'string' && s.name.trim()
  if (!ok) throw new Error('[SKY] 租赁艇型配置非法：' + JSON.stringify(s))
}

/* ================= 赛事保险：方案目录（服务端唯一事实来源） =================
 * 每赛季可投保一份（保险费不退、仅当季有效，衔接新赛季自然到期）；一份保单当季只
 * 理赔一次：报案 → 定损（维修费用口径，全部由服务端核定）→ 赔付（定损额 × 赔付比例，
 * 以单次上限封顶）。与商店/租约同口径，客户端只能按 id 投保，价格与比例均不可改写。
 */
const INSURANCE_PLANS = [
  { id: 1, name: '云安·基础赛险', premium: 1200, coverage: 0.5, maxPayout: 3000, note: '基础保障，按定损额 50% 赔付，单季一次' },
  { id: 2, name: '云安·全程护艇险', premium: 2600, coverage: 0.75, maxPayout: 7000, note: '高额护艇，按定损额 75% 赔付，单季一次' },
  { id: 3, name: '苍穹·旗舰全险', premium: 4800, coverage: 1.0, maxPayout: 15000, note: '全损全赔，按定损额 100% 赔付，单季一次' }
]
const INSURANCE_MAP = new Map(INSURANCE_PLANS.map(p => [p.id, p]))
for (const p of INSURANCE_PLANS) {
  const ok = typeof p.name === 'string' && p.name.trim() &&
    Number.isInteger(p.premium) && p.premium > 0 &&
    typeof p.coverage === 'number' && p.coverage > 0 && p.coverage <= 1 &&
    Number.isInteger(p.maxPayout) && p.maxPayout > 0
  if (!ok) throw new Error('[SKY] 保险方案配置非法：' + JSON.stringify(p))
}
// 事故等级与情形文案（事故在开赛瞬间按比赛因素确定性生成，文案随记录走）
const INCIDENT_LEVELS = { minor: { label: '轻微事故', repLoss: 0 }, major: { label: '严重事故', repLoss: 1 }, crash: { label: '坠毁事故', repLoss: 3 } }
const INCIDENT_CAUSES = {
  minor: ['云流擦碰，护甲轻度刮损', '侧风偏移蹭上浮岛礁岩，蒙皮小面积损伤', '编队缠斗中擦碰翼尖，局部铆钉松脱'],
  major: ['乱流中舵面过载变形，转向机构受损', '积雨云结冰打坏翼板，龙骨出现裂纹', '能见度骤降中追尾，护甲大面积凹陷'],
  crash: ['雷暴直击！艇身结构重创、引擎熄火', '风切变将飞艇抛向礁岩，龙骨断裂迫降云海', '闪电点燃氮气管路，艇体焚毁边缘惊险迫降']
}

/* ================= 赛季合约：条款配置（服务端唯一事实来源） =================
 * 取代旧版「固定积分达标」赞助：每份合约由若干条款组成，进度按本赛季已结算比赛
 * （天气 / 最终名次 / 开赛时的租赁艇快照）累计，全部条款（或 need 指定条数）达成后，
 * 在结算事务内一次性兑现资金 + 声望。条款口径与奖励一律由这份配置核定，客户端不可改写。
 *
 * 条款类型：
 *  - points : 赛季积分累计达到 value
 *  - weather: 在 weather 指定天气下完赛 value 场（weather 省略或为 '*' = 任意天气）
 *  - rank   : 取得 rankMax 名以内（含）完赛 value 场（rankMax 省略 = 任意名次）
 *  - rental : 以租赁艇完赛 value 场；ship 指定租赁艇型 id；ship 省略 = 任意租赁艇
 *  - race   : 同一场比赛同时满足 weather/rankMax/ship 条件即计 1 场，value 场（复合条款）
 */
const VALID_TERM_TYPES = ['points', 'weather', 'rank', 'rental', 'race']
const CONTRACT_SEASON = 1
const CONTRACTS = [
  {
    id: 1, name: '云帆工坊 · 积分赞助', note: '赛季积分达标，基础赞助照常兑现',
    terms: [{ type: 'points', value: 12 }],
    reward: 4000, rep: 8
  },
  {
    id: 2, name: '星罗航空 · 全天候完赛', note: '在雨、雾、雷暴的恶劣云况下各完成一场分站赛',
    terms: [
      { type: 'weather', weather: '雨', value: 1 },
      { type: 'weather', weather: '雾', value: 1 },
      { type: 'weather', weather: '雷暴', value: 1 }
    ],
    reward: 8000, rep: 15
  },
  {
    id: 3, name: '流风动力 · 领奖台合约', note: '两次以前三名冲线，或至少一场以租赁艇代赛（任一达成即兑现）',
    need: 1,
    terms: [
      { type: 'rank', rankMax: 3, value: 2 },
      { type: 'rental', value: 1 }
    ],
    reward: 14000, rep: 22
  },
  {
    id: 4, name: '苍穹商会 · 赛季之巅', note: '积分 45 分，并在雷暴云谷租赁旗舰艇夺冠',
    terms: [
      { type: 'points', value: 45 },
      { type: 'race', weather: '雷暴', rankMax: 1, ship: 4, value: 1 }
    ],
    reward: 22000, rep: 32
  }
]
// 条款合法性自检：非法合约配置必须在启动时就暴露，而不是等玩家差一场才发现条款无效
function validateTerms(terms) {
  if (!Array.isArray(terms) || !terms.length) return false
  return terms.every(t => {
    if (!t || typeof t !== 'object' || !VALID_TERM_TYPES.includes(t.type)) return false
    if (!Number.isInteger(t.value) || t.value <= 0) return false
    if ('weather' in t && t.weather !== '*' && !(t.weather in WEATHER)) return false
    if ('rankMax' in t && (!Number.isInteger(t.rankMax) || t.rankMax < 1 || t.rankMax > 6)) return false
    if ('ship' in t && (!Number.isInteger(t.ship) || !RENTAL_MAP.has(t.ship))) return false
    // 天气白名单（不含 '*'）只对天气语义条款有意义；rental/race 额外条件用上面的字段校验
    return true
  })
}
for (const c of CONTRACTS) {
  const ok = typeof c.name === 'string' && c.name.trim() &&
    validateTerms(c.terms) &&
    Number.isInteger(c.reward) && c.reward >= 0 &&
    Number.isInteger(c.rep) && c.rep >= 0 &&
    (c.need === undefined || (Number.isInteger(c.need) && c.need >= 1 && c.need <= c.terms.length))
  if (!ok) throw new Error('[SKY] 赛季合约配置非法：' + JSON.stringify(c))
  c.need = c.need ?? c.terms.length
}

// 新赛季建档：按当前服务端配置为指定赛季复制一份合约（条款为配置快照）。
// 进度不入库，随后由对账按该赛季已结算战绩决定是否立即兑现，天然幂等——
// 仅在该赛季尚无合约时补建（老库升级到第 1 季、新赛季衔接时调用）。
function ensureContracts(season = CONTRACT_SEASON) {
  if (get('SELECT COUNT(*) c FROM contracts WHERE season=?', season).c > 0) return
  CONTRACTS.forEach(c => run(
    'INSERT INTO contracts (name,season,note,terms,need,reward,rep) VALUES (?,?,?,?,?,?,?)',
    c.name, season, c.note || '', JSON.stringify({ v: 1, terms: c.terms }), c.need, c.reward, c.rep))
}
function seed() {
  if (get('SELECT COUNT(*) c FROM team').c > 0) return
  run('INSERT INTO team (name) VALUES (?)', '苍穹疾风战队')
  run('INSERT INTO airships (name) VALUES (?)', '云雀·I').lastInsertRowid
  run('INSERT INTO pilots (name,skill,courage,exp,wage,mood) VALUES (?,?,?,?,?,?)', '奥罗·晨曦', 62, 58, 20, 80, 75)
  run('INSERT INTO pilots (name,skill,courage,exp,wage,mood) VALUES (?,?,?,?,?,?)', '莉娜·云涛', 55, 65, 8, 55, 82)
  run('INSERT INTO mechanics (name,skill,wage,mood) VALUES (?,?,?,?)', '格蕾丝·铆钉', 58, 45, 78)
  const ups = SHOP_ITEMS.map(i => [i.name, i.slot, i.stat, i.bonus, i.price])
  ups.forEach(([n, slot, stat, bonus, price]) => run('INSERT INTO upgrades (name,slot,stat,bonus,price) VALUES (?,?,?,?,?)', n, slot, stat, bonus, price))
  const cir = [['晨雾浮岛','1','雾'],['雷鸣云谷','2','雷暴'],['翡翠群岛','3','晴'],['风暴裂谷','3','雨'],['极光穹顶','4','风'],['星界之巅','5','雾']]
  cir.forEach(([n, d, w]) => run('INSERT INTO circuits (name,diff,weather,bonus_pts) VALUES (?,?,?,?)', n, Number(d), w, Number(d) * 4))
  CONTRACTS.forEach(c => run(
    'INSERT INTO contracts (name,season,note,terms,need,reward,rep) VALUES (?,?,?,?,?,?,?)',
    c.name, CONTRACT_SEASON, c.note || '',
    JSON.stringify({ v: 1, terms: c.terms }), c.need, c.reward, c.rep))
}
export function teamCore() { return get('SELECT * FROM team WHERE id=1') }
export function airship() { return all('SELECT * FROM airships')[0] || { speed: 60, dur: 80, turn: 55, acc: 60, parts_dur: 100, hp: 100, name: '云雀·I', id: 1 } }
// 当前生效的租约（每车队同时仅一份；null = 使用自有艇）
function activeRental() { return get("SELECT * FROM rentals WHERE status='active' ORDER BY id DESC LIMIT 1") || null }
// 比赛开赛快照中本场出赛艇的租约（不区分 active/returned）。
// 结算与回滚的磨损归属、退款口径永远以这份快照为唯一依据，而不是「此刻是否在履租约」——
// 否则租约归还后再结算/回滚，会错扣自有艇磨损或漏退已钱货两讫的磨损费。
function raceRental(rec) {
  const rtId = rec?.factors?.rental?.id
  return rtId ? get('SELECT * FROM rentals WHERE id=?', rtId) : null
}
export function fleetStats(rt = activeRental()) {
  // 租约期间车队以租赁艇出赛：基础四项与部件健康取自租约快照，自有艇入库封存不磨损。
  // 出赛艇由调用方按排班解析结果传入（默认沿用旧行为：有在履租约即租约艇）
  const a = rt || airship()
  const up = all('SELECT * FROM upgrades WHERE equipped=1')
  const s = { speed: a.speed, dur: a.dur, turn: a.turn, acc: a.acc, name: a.name, id: a.id, parts_dur: a.parts_dur, hp: a.hp ?? 100 }
  up.forEach(u => { s[u.stat] = (s[u.stat] || 0) + u.bonus })
  if (rt) s.rental = { id: rt.id, shipId: rt.ship_id, name: rt.name, racesLeft: rt.max_races - rt.races_used, maxRaces: rt.max_races, wearTotal: rt.wear_total }
  return s
}
function leadPilot() { return all('SELECT * FROM pilots ORDER BY (skill+courage) DESC')[0] || null }
function topMech() { return all('SELECT * FROM mechanics ORDER BY skill DESC')[0] || null }

/* ================= 赛事排班：机师 / 技工 / 出赛艇（服务端唯一事实来源） =================
 * 排班存于单行表 lineup（id=1），开赛瞬间由 resolveLineup 解析为实际出赛人选与出赛艇，
 * 并快照进比赛记录（factors.pilot / factors.mech / factors.rental / factors.lineup）。
 * 结算、越站回滚、历史回放一律只认快照——赛后调整排班绝不影响已开赛的比赛。
 */
const SHIP_MODES = ['auto', 'own', 'rental']
function lineupRow() { return get('SELECT * FROM lineup WHERE id=1') || { id: 1, pilot_id: null, mechanic_id: null, ship_mode: 'auto' } }
function ensureLineup() { run("INSERT OR IGNORE INTO lineup (id, ship_mode) VALUES (1, 'auto')") }
// 解析排班 → 本场实际出赛阵容。指定人员已离队（脏数据）时回落自动，绝不让比赛无法生成
function resolveLineup() {
  const l = lineupRow()
  const pilotSet = l.pilot_id ? get('SELECT * FROM pilots WHERE id=?', l.pilot_id) : null
  const mechSet = l.mechanic_id ? get('SELECT * FROM mechanics WHERE id=?', l.mechanic_id) : null
  const mode = SHIP_MODES.includes(l.ship_mode) ? l.ship_mode : 'auto'
  const rt = activeRental()
  // auto：租约在履即租约艇（沿用旧行为）；own：自有艇出赛（租约不消耗场次与磨损）；rental：必须租约艇
  const useRental = mode === 'own' ? false : !!rt
  return {
    row: l, mode,
    pilot: pilotSet || leadPilot(), pilotAuto: !pilotSet,
    mech: mechSet || topMech(), mechAuto: !mechSet,
    rental: useRental ? rt : null,
    rentalMissing: mode === 'rental' && !rt   // 排班指定租赁艇但无在履租约：开赛时拦截
  }
}
// 对外排班视图：原始排班 + 下一站实际出赛阵容（含自动回落标记与缺租约警告）
function lineupPayload() {
  const lu = resolveLineup()
  return {
    pilotId: lu.row.pilot_id, mechanicId: lu.row.mechanic_id, shipMode: lu.mode,
    resolved: {
      pilot: lu.pilot ? { id: lu.pilot.id, name: lu.pilot.name, auto: lu.pilotAuto } : null,
      mech: lu.mech ? { id: lu.mech.id, name: lu.mech.name, auto: lu.mechAuto } : null,
      ship: lu.rental
        ? { kind: 'rental', id: lu.rental.id, name: lu.rental.name }
        : { kind: 'own', name: airship().name }
    },
    rentalMissing: lu.rentalMissing
  }
}
function leadership(p) {
  if (!p) return 20
  return (p.skill + p.courage) / 2 * 0.4 + p.exp * 0.15 + (p.mood - 50) * 0.08
}
function mechBonus(m) {
  if (!m) return 10
  return m.skill * 0.12 + (m.mood - 50) * 0.06
}
// 赛站必须按 id（航线下行→上行）顺序参赛，前一站未完赛前后续赛站一律锁定
function orderedCircuits() { return all('SELECT * FROM circuits ORDER BY id ASC') }
// 当前唯一允许参赛的赛站：航线上第一个未完成的赛站；全部完赛时为 null
function nextCircuit() { return orderedCircuits().find(c => !c.finished) || null }
// 赛季是否已全部完赛（结算卡据此提示进入新赛季；已衔接归档的老赛季恒为 false）
function isSeasonComplete(season) {
  const cs = orderedCircuits()
  return !!cs.length && cs.every(c => c.finished) &&
    !get('SELECT season FROM seasons WHERE season=?', season)
}

/* ================= 比赛记录：动画 / 实时排名 / 最终奖励共用的唯一事实来源 ================= */

// 某分段内「性能发挥」→ pace：受天气、改装（已含在 st）、部件健康、机师/技工状态共同影响
function playerPace(st, seg, wF, lead, mech, grit, rng) {
  const statPts = st.speed * seg.w.speed + st.turn * seg.w.turn + st.acc * seg.w.acc + st.dur * seg.w.dur
  const parts = clamp(st.parts_dur / 100, 0.62, 1.12)
  const wEff = 1 - (1 - wF) * grit                    // 机师胆识越高，越能扛住坏天气
  const raw = (statPts * parts * wEff + lead + mech)
  return raw * (1 + (rng() * 0.22 - 0.11))
}
function aiPace(ai, seg, wF, rng) {
  const grit = 0.5 + ai.courage / 200                // 对手机师的天气抗性（与玩家同口径）
  const wEff = 1 - (1 - wF) * grit
  const statPts = 57 + 6 * ai.diff + ai.skill * 0.07
  const crew = ai.skill * 0.17 + ai.courage * 0.06 + (ai.mood - 50) * 0.04
  const profile = ai.profile[SEGMENTS.indexOf(seg)]  // 每艘 AI 艇的分段特长
  return (statPts + crew) * wEff * profile * (1 + (rng() * 0.18 - 0.09))
}

// 生成完整比赛记录（结果在开赛瞬间即确定，后续只是对这份记录的播放与结算）
function buildRace(c) {
  const t = teamCore()
  const lu = resolveLineup()                 // 排班决定本场出赛艇与机师/技工，随即快照进记录
  const st = fleetStats(lu.rental)
  const pilot = lu.pilot
  const mech = lu.mech
  const mods = all('SELECT * FROM upgrades WHERE equipped=1').map(u => ({ id: u.id, name: u.name, slot: u.slot, stat: u.stat, bonus: u.bonus }))
  const lead = leadership(pilot)
  const mechB = mechBonus(mech)
  const grit = 0.5 + (pilot?.courage || 50) / 200
  const segW = SEG_WEATHER[c.weather] || [1, 1, 1]
  const rng = mulberry32((Date.now() & 0xffffffff) ^ (c.id * 2654435761))

  // 5 名对手，共 6 艇竞技；各自带机师状态与分段特长，档位参差保证每场有慢艇也有快车
  const ais = AI_NAMES.map((name, i) => ({
    name, color: AI_COLORS[i], diff: c.diff,
    skill: 48 + c.diff * 4 + Math.floor(rng() * 10) + (-17 + Math.floor(rng() * 40)),
    courage: 40 + Math.floor(rng() * 40),
    mood: 58 + Math.floor(rng() * 38),
    profile: [0.97 + rng() * 0.06, 0.97 + rng() * 0.06, 0.97 + rng() * 0.06]
  }))

  const racers = [{ id: 'p', name: t.name, color: PLAYER_COLOR, isPlayer: true, paces: [], segW: [], times: [], entry: [0] }]
  ais.forEach(ai => racers.push({ id: 'ai' + ai.name, name: ai.name, color: ai.color, isPlayer: false, ai, skill: ai.skill, courage: ai.courage, mood: ai.mood, paces: [], segW: [], times: [], entry: [0] }))

  SEGMENTS.forEach((seg, si) => {
    racers.forEach(r => {
      const gritP = r.isPlayer ? grit : (0.5 + r.ai.courage / 200)
      const wF = segW[si]                            // 同一场天气对所有艇一致，差异只在机师抗性
      const wEff = 1 - (1 - wF) * gritP
      const pace = r.isPlayer
        ? playerPace(st, seg, wF, lead, mechB, grit, rng) * (1 + c.diff * 0.006)
        : aiPace(r.ai, seg, wF, rng)
      const time = SEG_K / Math.max(1, pace)
      r.paces.push(Math.round(pace * 100) / 100)
      r.segW.push(Math.round(wEff * 1000) / 1000)
      r.times.push(Math.round(time * 1000) / 1000)
      r.entry.push(Math.round((r.entry[si] + time) * 1000) / 1000)
    })
  })
  racers.forEach(r => { r.total = r.entry[3] })

  // 总用时排序得最终名次（玩家名次），动画、LIVE 榜、奖励全部以此为准
  const order = [...racers].sort((a, b) => a.total - b.total)
  const rank = order.findIndex(r => r.isPlayer) + 1
  const pts = PTS[rank - 1] || 1
  const money = Math.round((600 + (7 - rank) * 180) * (1 + c.diff * 0.05))
  const wear = 5 + c.diff * 3 + (WEATHER[c.weather] < 0.9 ? 4 : 0)
  const repGain = Math.max(1, 5 - rank + c.diff)

  // 赛事事故（与比赛结果同在开赛瞬间确定，回放/重放永远一致）：事故率随正常磨损、
  // 赛道难度、恶劣天气上升，机师胆识（grit，与天气抗性同口径）显著化解。
  // 事故只作用于赛后部件/结构与声望，不改变已经定出的排名；定损与赔付在结算后另走理赔流程。
  const weatherRisk = { '晴': 0, '风': 0.03, '雨': 0.06, '雾': 0.1, '雷暴': 0.18 }[c.weather] || 0
  const accChance = clamp(0.06 + wear * 0.006 + c.diff * 0.035 + weatherRisk - (grit - 0.5) * 0.5, 0.03, 0.72)
  let incident = null
  if (rng() < accChance) {
    const sevRoll = rng()
    const level = sevRoll < 0.62 ? 'minor' : sevRoll < 0.9 ? 'major' : 'crash'
    const [d0, d1] = { minor: [6, 12], major: [15, 26], crash: [30, 45] }[level]
    const damage = d0 + Math.floor(rng() * (d1 - d0 + 1))
    const causes = INCIDENT_CAUSES[level]
    incident = { level, damage, chance: +accChance.toFixed(2), cause: causes[Math.floor(rng() * causes.length)] }
  }

  // 分段事件：分段节点的名次变化（超车）+ 天气氛围事件，计时锚点取玩家艇自身时间轴
  const events = []
  const flavors = FLAVOR[c.weather] || FLAVOR['晴']
  let prevRank = null
  SEGMENTS.forEach((seg, si) => {
    const segOrder = [...racers].sort((a, b) => a.entry[si + 1] - b.entry[si + 1])
    const pRank = segOrder.findIndex(r => r.isPlayer) + 1
    const tEnd = racers[0].entry[si + 1]
    if (prevRank && pRank < prevRank) {
      const behind = segOrder[pRank] // segOrder 为 0 基；玩家位于 pRank-1，紧随其后的即索引 pRank
      events.push({ t: +(tEnd - 0.35).toFixed(2), type: 'overtake', text: `你在「${seg.name}」超越 ${behind ? behind.name : '对手'}，升至第 ${pRank} 位！` })
    }
    events.push({ t: +(racers[0].entry[si] + racers[0].times[si] * 0.5).toFixed(2), type: 'flavor', text: flavors[Math.floor(rng() * flavors.length)] })
    prevRank = pRank
  })
  // 事故横幅：在中后段随机时刻弹出，结算卡与理赔单共用同一事故快照
  if (incident) {
    events.push({ t: +(racers[0].total * (0.55 + rng() * 0.35)).toFixed(2), type: 'incident', text: `⚠ ${INCIDENT_LEVELS[incident.level].label}！${incident.cause}（艇体损伤 ${incident.damage} 点）` })
  }
  events.sort((a, b) => a.t - b.t)

  racers.forEach(r => { delete r.ai }) // ai 仅引擎内部使用，其字段已展开到记录顶层
  const duration = Math.max(...racers.map(r => r.total)) + 0.15
  return {
    v: 1,
    circuit: { id: c.id, name: c.name, diff: c.diff, weather: c.weather },
    season: t.season,
    segments: SEGMENTS.map(s => ({ key: s.key, name: s.name })),
    factors: {
      weather: c.weather,
      weatherCoeff: WEATHER[c.weather] || 1,
      segWeather: segW,
      base: { speed: st.speed - mods.filter(m => m.stat === 'speed').reduce((a, m) => a + m.bonus, 0),
        turn: st.turn - mods.filter(m => m.stat === 'turn').reduce((a, m) => a + m.bonus, 0),
        acc: st.acc - mods.filter(m => m.stat === 'acc').reduce((a, m) => a + m.bonus, 0),
        dur: st.dur - mods.filter(m => m.stat === 'dur').reduce((a, m) => a + m.bonus, 0) },
      parts_dur: st.parts_dur,
      // 本场出赛租约快照：结算时磨损记入该租约；shipId 供合约条款按指定艇型判定；null = 自有艇出赛
      rental: st.rental ? { id: st.rental.id, shipId: st.rental.shipId, name: st.rental.name } : null,
      // 本场排班快照：排班原始配置（null = 自动），赛后改排班不影响这份记录
      lineup: { shipMode: lu.mode, pilotId: lu.row.pilot_id, mechanicId: lu.row.mechanic_id },
      mods,
      pilot: pilot ? { id: pilot.id, name: pilot.name, skill: pilot.skill, courage: pilot.courage, exp: pilot.exp, mood: pilot.mood } : null,
      mech: mech ? { id: mech.id, name: mech.name, skill: mech.skill, mood: mech.mood } : null,
      detail: { parts: +clamp(st.parts_dur / 100, 0.62, 1.12).toFixed(2), lead: +lead.toFixed(1), mech: +mechB.toFixed(1), grit: +grit.toFixed(2) }
    },
    racers,
    events,
    result: { rank, pts, money, wear, repGain },
    // 本场事故快照（null = 平安完赛）：结算时按此施加事故损伤/声望，理赔单以此为定损事实
    incident,
    duration: +duration.toFixed(2)
  }
}

// 读取/解析比赛记录
const parseRace = r => (r ? { ...r, settled: !!r.settled, record: JSON.parse(r.record) } : null)
function getRaceRow(id) { return get('SELECT * FROM races WHERE id=?', Number(id)) }
// 单场已结算比赛的发奖口径（与 settleRace 完全一致）；历史修复按此逐项反向回滚
function raceEffect(row, c) {
  let rec = null
  try { rec = JSON.parse(row.record) } catch (e) { rec = null }
  const rank = row.rank ?? rec?.result?.rank ?? c?.rank ?? 6
  const pts = row.pts ?? rec?.result?.pts ?? (PTS[rank - 1] || 1)
  const money = row.money ?? rec?.result?.money ?? 0
  const wear = row.wear ?? rec?.result?.wear ?? 0
  const repGain = row.rep_gain ?? rec?.result?.repGain ?? Math.max(1, 5 - rank + (c?.diff || 0))
  return { row, rec, rank, pts, money, wear, repGain }
}
// 反向回滚单场已结算比赛：部件磨损（parts_dur/hp）与机师经验、心情同积分奖金一道冲回，
// 保证「资源状态」与「战绩」始终一致。维护等操作若已介入，恢复值以 100 为上限，不会溢出。
//
// 磨损归属以开赛快照为准（raceRental），与 settleRace 完全对称：
//  - 租约仍在履行：磨损与场次回滚到租约，不动钱（押金尚未结算）；
//  - 租约已归还：归还时已按累计磨损计费钱货两讫——先回滚累计磨损/场次，再按「本场磨损对应的
//    边际磨损费」补退（押金−磨损费的下限 0 效应按重算结果保留），并回写 wear_fee/refund，
//    使租约行与比赛结果重新自洽；自有艇封存未磨损，绝不回错对象；
//  - 无租约（自有艇出赛）：恢复自有艇 parts_dur/hp。
// 返回 refundAdd（需要在调用方统一补给车队资金的退款），资金改动只在单一边界发生，保证幂等。
function reverseSettledRace(row, c) {
  const g = raceEffect(row, c)
  const rt = raceRental(g.rec)
  // 事故快照（老记录无此字段 = 平安完赛）与已落物理赔单：回滚口径以快照 + 理赔行为准
  const inc = g.rec?.incident || null
  const totalWear = g.wear + (inc?.damage || 0)
  const incRow = inc ? get('SELECT * FROM incidents WHERE race_id=?', row.id) : null
  let refundAdd = 0
  let payoutBack = 0
  if (rt && rt.status === 'active') {
    // 该场为租约艇出赛且租约仍在履行：磨损（含事故损伤）与已用场次一并回滚到租约（恢复以 100 为上限）
    run('UPDATE rentals SET parts_dur=MIN(100,parts_dur+?), wear_total=MAX(0,wear_total-?), races_used=MAX(0,races_used-1) WHERE id=?',
      totalWear, totalWear, rt.id)
  } else if (rt && rt.status === 'returned') {
    // 归还已结算：把本场磨损（含事故损伤）从「已计费基数」中剔除，按剩余磨损重算边际磨损费与押金退款
    const wearTotal2 = Math.max(0, (rt.wear_total || 0) - totalWear)
    const wearFee2 = wearTotal2 * rt.wear_rate
    const refund2 = Math.max(0, (rt.deposit || 0) - wearFee2)
    refundAdd = Math.max(0, refund2 - (rt.refund || 0))
    run('UPDATE rentals SET parts_dur=MIN(100,parts_dur+?), wear_total=?, races_used=MAX(0,races_used-1), wear_fee=?, refund=? WHERE id=?',
      totalWear, wearTotal2, wearFee2, refund2, rt.id)
  } else if (!rt) {
    // 自有艇出赛：恢复自有艇磨损（含事故损伤）
    const a = airship()
    run('UPDATE airships SET parts_dur=MIN(100,parts_dur+?), hp=MIN(100,hp+?) WHERE id=?', totalWear, totalWear, a.id)
  }
  // 租约记录缺失：无归属可回（数据已不在），保持与正向口径一致，不动任何部件与资金
  const pilotId = g.rec?.factors?.pilot?.id
  if (pilotId) {
    const expGain = g.rank <= 4 ? 3 : 1   // 与 settleRace 的发奖口径逐字对应
    const moodLoss = g.rank > 8 ? 6 : 2
    run('UPDATE pilots SET exp=MAX(0,exp-?), mood=MIN(100,MAX(0,mood+?)) WHERE id=?',
      expGain, moodLoss, pilotId)
  }
  // 事故理赔单回滚：已赔付的冲回赔款、恢复保单（claimed→active）；未赔付的报案/定损单只作废；
  // 坠毁/严重事故的声望扣减同步恢复。资金冲回交由调用方在单一边界统一入账
  let repIncidentBack = 0
  if (inc && incRow) {
    if (incRow.status === 'paid') {
      payoutBack = incRow.payout || 0
      if (incRow.claim_id) {
        run("UPDATE insurance SET status='active', claimed_incident_id=NULL, claimed_at=NULL WHERE id=?", incRow.claim_id)
      }
    }
    repIncidentBack = INCIDENT_LEVELS[inc.level]?.repLoss || 0
    run("UPDATE incidents SET status='void' WHERE id=?", incRow.id)
  }
  return { ...g, refundAdd, payoutBack, repIncidentBack }
}
function settleRace(id) {
  const row = getRaceRow(id)
  if (!row) return { ok: false, status: 404, msg: '比赛记录不存在' }
  if (row.status === 'void') return { ok: false, status: 409, msg: '该比赛已在历史修复中作废，不能再次结算' }
  // 幂等重放同样要告知前端「本季是否已 6 站完赛」（决定结算卡是否展示进入新赛季）
  if (row.settled) return { ok: true, already: true, race: parseRace(row), contractsPaid: [], contractsRevoked: [], incident: incidentBrief(row.season, row.id), seasonComplete: isSeasonComplete(row.season) }

  const rec = JSON.parse(row.record)
  const c = get('SELECT * FROM circuits WHERE id=?', row.circuit_id)
  let result
  db.exec('BEGIN')
  try {
    // 事务内二次确认闸门：同步执行下杜绝并发/重放造成的重复发奖
    const again = getRaceRow(id)
    if (again.status === 'void') {
      result = { ok: false, status: 409, msg: '该比赛已在历史修复中作废，不能再次结算' }
    } else if (again.settled) {
      result = { ok: true, already: true, race: parseRace(again), contractsPaid: [], contractsRevoked: [], incident: incidentBrief(again.season, again.id), seasonComplete: isSeasonComplete(again.season) }
    } else if (c?.finished) {
      // 极端兜底：赛站已被另一场比赛结算 → 本条记录作废，绝不重复发奖，也不混入历史战绩
      run("UPDATE races SET status='void', settled=0, voided_at=? WHERE id=?", now(), row.id)
      result = { ok: false, status: 409, msg: '该赛站已完赛，此条比赛记录已作废' }
    } else {
      // 顺序闸门：仅当前待赛站可结算；running 记录正常必然命中，越站脏数据在此被拦截
      const cur = nextCircuit()
      if (!cur || cur.id !== row.circuit_id) {
        result = { ok: false, status: 409, msg: '前置赛站尚未完赛，该比赛暂不能结算' }
      } else {
        const { rank, pts, money, wear, repGain } = rec.result
        const incidentSnap = rec.incident || null  // 事故快照：null = 平安完赛
        // 磨损归属以开赛快照为唯一依据（与 reverseSettledRace 对称）：
        //  - 租约仍 active：正常磨损 + 事故损伤一并记入租约（归还时按 wear_total 计费）并计一场次，
        //    保险赔付的是「租方本要承担的磨损费」，自有艇不磨损；
        //  - 租约已 returned：归还时磨损已钱货两讫，本场不再重复计费，更不得回扣封存的自有艇；
        //  - 无租约：自有艇出赛，正常磨损 + 事故损伤由本队承担（事后可维护/理赔）。
        const rt = raceRental(rec)
        const dmg = incidentSnap?.damage || 0
        if (rt && rt.status === 'active') {
          run('UPDATE rentals SET parts_dur=MAX(5,parts_dur-?), wear_total=wear_total+?, races_used=races_used+1 WHERE id=?',
            wear + dmg, wear + dmg, rt.id)
        } else if (!rt) {
          const a = airship()
          const newPd = Math.max(5, a.parts_dur - wear - dmg)
          run('UPDATE airships SET parts_dur=?, hp=? WHERE id=?', newPd, Math.max(10, a.hp - wear - dmg), a.id)
        }
        if (rec.factors.pilot) {
          run('UPDATE pilots SET exp=exp+?, mood=MIN(100,MAX(0,mood-?)) WHERE id=?',
            rank <= 4 ? 3 : 1, rank > 8 ? 6 : 2, rec.factors.pilot.id)
        }
        // 事故声望扣减：严重 -1、坠毁 -3（轻微事故不扣声望），与名次声望分开入账
        const repLoss = incidentSnap ? (INCIDENT_LEVELS[incidentSnap.level]?.repLoss || 0) : 0
        run('UPDATE team SET money=money+?, rep=MAX(0,rep+?), season_pts=season_pts+? WHERE id=1', money, repGain - repLoss, pts)
        const ranksDone = all('SELECT rank FROM circuits WHERE finished=1')
        const best = Math.min(rank, ...ranksDone.map(r => r.rank))
        run('UPDATE team SET season_pos=? WHERE id=1', Math.max(1, best))
        run('UPDATE circuits SET finished=1, rank=? WHERE id=?', rank, row.circuit_id)
        const note = rec.factors.weather === '晴' ? `晴空万里，${rec.circuit.name}` : `${rec.factors.weather}天，${rec.circuit.name}`
        run('INSERT INTO race_log (circuit_id, race_id, season, rank, pts, money, note, ts) VALUES (?,?,?,?,?,?,?,?)',
          row.circuit_id, row.id, rec.season, rank, pts, money, note, now())
        run("UPDATE races SET status='settled', settled=1, rank=?, pts=?, money=?, wear=?, rep_gain=?, settled_at=? WHERE id=?",
          rank, pts, money, wear, repGain, now(), row.id)
        // 事故理赔单（status=reported）随结算一并落库：定损/赔付只能在这条行上推进，
        // 一场比赛至多一起（race_id 唯一）；平安完赛不落行，事后报案无据（接口 404）
        let incBrief = null
        if (incidentSnap) {
          run(`INSERT INTO incidents (race_id,season,circuit_id,level,cause,damage,status,created_at,reported_at)
            VALUES (?,?,?,?,?,?, 'reported', ?, ?)`,
            row.id, rec.season, row.circuit_id, incidentSnap.level, incidentSnap.cause, dmg, row.created_at || now(), now())
          incBrief = incidentBrief(rec.season, row.id)
        }
        const contractSettle = reconcileContracts(rec.season) // 同一事务内对账赛季合约（累计进度→一次性兑现）
        const settledRow = parseRace(getRaceRow(id))
        // 全部 6 站已结算（且尚未衔接新赛季）→ 结算卡展示赛季总结与「进入新赛季」
        const complete = orderedCircuits().every(x => x.finished)
        result = { ok: true, already: false, race: settledRow, contractsPaid: contractSettle.paid, contractsRevoked: contractSettle.revoked, incident: incBrief, seasonComplete: complete }
      }
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
  return result
}
/* ================= 赛季合约：进度引擎 + 一次性兑现对账 =================
 * 进度不入库：始终以本赛季「已结算且未作废」的比赛记录为唯一事实来源现算
 * （weather=赛道天气，rank=最终名次，rental=开赛快照中的租赁艇/艇型）。
 * 积分条款直接以 team.season_pts 为准——积分本身已由每场结算与越站回滚维护。
 * 全部条款（或 need 指定条数）达成即在结算事务内一次性兑现资金 + 声望；
 * 若因越站作废等导致进度跌破门槛，则冲回奖励，与正向口径完全对称，函数幂等。
 */
function parseTerms(row) {
  try {
    const j = JSON.parse(row.terms)
    return Array.isArray(j) ? j : (j?.terms || []) // 兼容裸数组老快照
  } catch (e) { return [] }
}
// 租赁艇型 id 的稳健解析：新记录快照带 shipId；老记录只有租约行 id，需查库回推目录艇型
function raceShipId(rec) {
  const rtSnap = rec?.factors?.rental
  if (!rtSnap) return null
  if (Number.isInteger(rtSnap.shipId)) return rtSnap.shipId
  const rtRow = get('SELECT ship_id FROM rentals WHERE id=?', rtSnap.id)
  return rtRow?.ship_id ?? null
}
// 单场比赛是否命中条款的附加条件（weather / rankMax / ship）
function raceMatch(rec, t) {
  const w = rec?.circuit?.weather ?? rec?.factors?.weather
  if (t.weather && t.weather !== '*' && w !== t.weather) return false
  if (Number.isInteger(t.rankMax) && (rec.result.rank ?? 6) > t.rankMax) return false
  if ('ship' in t && raceShipId(rec) !== t.ship) return false
  return true
}
// 计算一份条款在给定已结算比赛集合上的累计进度 { value, target }
function termProgress(term, races, pts) {
  const target = term.value
  let value = 0
  if (term.type === 'points') {
    value = pts
  } else if (term.type === 'weather') {
    value = races.filter(r => raceMatch(r, term)).length
  } else if (term.type === 'rank') {
    value = races.filter(r => raceMatch(r, term)).length
  } else if (term.type === 'rental') {
    // ship 缺省 = 任意租赁艇；指定 ship 时由 raceMatch 校验艇型
    value = races.filter(r => !!r.factors?.rental && raceMatch(r, term)).length
  } else if (term.type === 'race') {
    // 复合条款：天气 + 名次 + 租赁艇（可含指定艇型）必须在同一场比赛同时满足
    value = races.filter(r => !!r.factors?.rental && raceMatch(r, term)).length
  }
  return { value, target, reached: value >= target }
}
// 合约整体进度：每条条款的进度 + 是否满足 need 条
function contractView(row, races, pts) {
  const terms = parseTerms(row)
  const items = terms.map(t => ({ term: t, ...termProgress(t, races, pts) }))
  const need = Math.min(row.need || items.length || 1, items.length)
  const doneCount = items.filter(i => i.reached).length
  return { terms: items, need, doneCount, reached: items.length > 0 && doneCount >= need }
}
// 取某赛季全部已结算、未作废比赛的解析记录（合约进度的唯一统计口径）
function settledRaceRecs(season) {
  return all("SELECT * FROM races WHERE status='settled' AND settled=1 AND season=? ORDER BY id ASC", season)
    .map(r => { try { return JSON.parse(r.record) } catch (e) { return null } })
    .filter(Boolean)
}
// 合约对账（与旧赞助对账同一边界）：达成即一次性兑现，跌破即冲回；幂等。
// 返回 { paid:[...], revoked:[...] }，结算卡据此展示当场兑现的合约。
function reconcileContracts(season = teamCore().season) {
  const t = teamCore()
  const pts = Number(t.season_pts) || 0
  const races = settledRaceRecs(season)
  const paid = [], revoked = []
  all('SELECT * FROM contracts WHERE season=?', season).forEach(c => {
    if (!c.reward && !c.rep) return
    const view = contractView(c, races, pts)
    const wasEarned = !!c.earned
    if (view.reached && !wasEarned) {
      run('UPDATE team SET money=money+?, rep=rep+? WHERE id=1', c.reward, c.rep)
      run('UPDATE contracts SET earned=1, paid_at=? WHERE id=?', now(), c.id)
      paid.push({ id: c.id, name: c.name, reward: c.reward, rep: c.rep })
    } else if (!view.reached && wasEarned) {
      run('UPDATE team SET money=MAX(0,money-?), rep=MAX(0,rep-?) WHERE id=1', c.reward, c.rep)
      run('UPDATE contracts SET earned=0, paid_at=NULL WHERE id=?', c.id)
      revoked.push({ id: c.id, name: c.name, reward: c.reward, rep: c.rep })
    }
  })
  return { paid, revoked }
}
// 条款展示文案（服务端生成，前端直接渲染；目标值/艇型口径不在客户端拼接）
function termLabel(t) {
  const n = t.value
  switch (t.type) {
    case 'points': return `赛季积分达到 ${n}`
    case 'weather': return `${(t.weather && t.weather !== '*') ? t.weather : '任意天气'}完赛 ${n} 场`
    case 'rank': {
      const place = Number.isInteger(t.rankMax) ? `前 ${t.rankMax} 名` : '任意名次'
      return `${place}完赛 ${n} 场`
    }
    case 'rental': {
      const ship = 'ship' in t ? RENTAL_MAP.get(t.ship)?.name || '指定艇型' : '租赁艇'
      return `驾驶${ship}完赛 ${n} 场`
    }
    case 'race': {
      const parts = []
      if (t.weather && t.weather !== '*') parts.push(t.weather)
      parts.push(Number.isInteger(t.rankMax) ? `取得前 ${t.rankMax} 名` : '完赛')
      if ('ship' in t) parts.push(`驾驶${RENTAL_MAP.get(t.ship)?.name || '指定艇型'}`)
      else parts.push('驾驶租赁艇')
      return `${parts.join('、')} ${n} 场`
    }
    default: return '未知条款'
  }
}
// 对外合约视图：配置条款 + 实时累计进度 + 兑现状态
function contractsPayload(season = teamCore().season) {
  const t = teamCore()
  const pts = Number(t.season_pts) || 0
  const races = settledRaceRecs(season)
  return all('SELECT * FROM contracts WHERE season=? ORDER BY id ASC', season).map(c => {
    const view = contractView(c, races, pts)
    return {
      id: c.id, name: c.name, note: c.note, season: c.season,
      reward: c.reward, rep: c.rep, earned: !!c.earned, paidAt: c.paid_at,
      need: view.need, doneCount: view.doneCount,
      terms: view.terms.map(i => ({ type: i.term.type, label: termLabel(i.term), value: i.value, target: i.target, reached: i.reached }))
    }
  })
}

/* ================= 新赛季衔接：完季 → 归档排行榜 → 分层重置（老赛季原样可回放） =================
 * 6 站全部结算后由前端显式触发：
 *  - 积分（team.season_pts/season_pos）、赛站（circuits.finished/rank）、赛季合约（新季重签）、
 *    历史战绩与排行榜均按赛季分层——老赛季的 races / race_log / contracts 一行不删，继续回放；
 *  - 资金、声望、飞艇（含部件健康）、改装件、机师技工（含经验/心情）、租约（含押金/场次/磨损归属）
 *    属于车队跨赛季资产，全部保留；排行榜快照存入 seasons，供「历届赛季榜」分层展示。
 * 幂等：以 seasons 中是否已有该季档案为唯一闸门（事务内二次校验），并发/重复衔接不产生两份档案。
 */
// 某赛季滚动战绩统计（完季归档与「当前赛季行」共用同一口径）
function seasonLiveStats(season) {
  const rows = all(
    "SELECT rank,pts,money,rep_gain FROM races WHERE status='settled' AND settled=1 AND season=?", season)
  const ranks = rows.map(r => r.rank).filter(r => r != null)
  // 事故与理赔统计按物理理赔单口径（作废单不计；事故数按比赛记录中的事故快照统计）
  const incRows = all("SELECT status,payout FROM incidents WHERE season=? AND status!='void'", season)
  const settledRows = all(
    "SELECT record FROM races WHERE status='settled' AND settled=1 AND season=?", season)
  const accidentN = settledRows.reduce((n, r) => {
    try { return n + (JSON.parse(r.record)?.incident ? 1 : 0) } catch (e) { return n }
  }, 0)
  return {
    season,
    pts: rows.reduce((a, r) => a + (r.pts || 0), 0),
    money: rows.reduce((a, r) => a + Math.round(r.money || 0), 0),
    rep: rows.reduce((a, r) => a + (r.rep_gain || 0), 0),
    wins: ranks.filter(r => r === 1).length,
    podiums: ranks.filter(r => r <= 3).length,
    bestRank: ranks.length ? Math.min(...ranks) : null,
    racesN: rows.length,
    incidents: accidentN,
    payouts: incRows.filter(i => i.status === 'paid').reduce((a, i) => a + (i.payout || 0), 0)
  }
}
// 历届赛季榜：seasons 归档行 + 当前赛季滚动行（未归档，标记 current），新季在前
function seasonsPayload() {
  const t = teamCore()
  const list = all('SELECT * FROM seasons ORDER BY season DESC').map(s => ({
    season: s.season, pts: s.pts, money: s.money, rep: s.rep, wins: s.wins,
    podiums: s.podiums, bestRank: s.best_rank, bestPos: s.best_pos,
    racesN: s.races_n, incidents: s.incidents || 0, payouts: s.payouts || 0,
    finishedAt: s.finished_at, current: false
  }))
  if (!list.some(s => s.season === t.season)) {
    const live = seasonLiveStats(t.season)
    list.unshift({
      season: t.season, pts: Number(t.season_pts) || 0, money: live.money, rep: live.rep,
      wins: live.wins, podiums: live.podiums, bestRank: live.bestRank,
      bestPos: Number(t.season_pos) || 1, racesN: live.racesN,
      incidents: live.incidents, payouts: live.payouts,
      finishedAt: null, current: true
    })
  }
  return list
}
// 完赛 6 站后的新赛季衔接（在独立事务内完成归档 + 分层重置）。返回 { status, body } 由路由映射
function advanceSeason() {
  if (get("SELECT id FROM races WHERE status='running' LIMIT 1")) {
    return { status: 409, body: { ok: false, msg: '尚有比赛进行中，结算后才能进入新赛季' } }
  }
  const t = teamCore()
  const season = Number(t.season) || 1
  if (get('SELECT season FROM seasons WHERE season=?', season)) {
    // 幂等：已衔接（并发重放 / 重复点击）直接返回当前状态，绝不二次归档、二次重置
    return { status: 200, body: { ok: true, already: true, msg: '新赛季已经开启', season: season + 1 } }
  }
  // 新赛季刚衔接、一站未跑时再次调用：上一季已归档即视为本次请求的重复，幂等返回，
  // 不把「尚未参赛」误报为错误（刷新页面 / 双击按钮的常见落点）
  if (season > 1 && get('SELECT season FROM seasons WHERE season=?', season - 1) &&
    !get('SELECT id FROM races WHERE season=? AND settled=1 LIMIT 1', season)) {
    return { status: 200, body: { ok: true, already: true, msg: '新赛季已经开启', season } }
  }
  const cs = orderedCircuits()
  const finishedCount = cs.filter(c => c.finished).length
  if (!finishedCount) return { status: 400, body: { ok: false, msg: '本赛季尚未参赛，无需进入新赛季' } }
  if (finishedCount < cs.length) {
    return { status: 409, body: { ok: false, msg: `本赛季还有 ${cs.length - finishedCount} 站未完赛，暂不能进入新赛季` } }
  }

  let body
  db.exec('BEGIN IMMEDIATE')
  try {
    // 事务内二次闸门：同步并发下只有一个衔接请求能穿过
    if (get('SELECT season FROM seasons WHERE season=?', season)) {
      body = { ok: true, already: true, msg: '新赛季已经开启', season: season + 1 }
    } else {
      // 1) 归档老赛季最终战绩到排行榜（races/race_log/contracts 原样保留，回放不受影响）
      const live = seasonLiveStats(season)
      const bestPos = Math.max(1, Number(t.season_pos) || 1)
      run(`INSERT INTO seasons (season,pts,money,rep,wins,podiums,best_rank,best_pos,races_n,incidents,payouts,finished_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        season, Number(t.season_pts) || 0, live.money, live.rep, live.wins, live.podiums,
        live.bestRank, bestPos, finishedCount, live.incidents, live.payouts, now())
      // 2) 滚动数据分层重置：积分/车队名次归零（money、rep 为跨赛季资产，保留）
      const nextSeason = season + 1
      run('UPDATE team SET season=?, season_pts=0, season_pos=1 WHERE id=1', nextSeason)
      // 3) 赛站重新开放（天气/难度配置不变，清完赛名次）
      run('UPDATE circuits SET finished=0, rank=NULL')
      // 4) 新赛季合约按当前配置重签（老合约行保留，进度按各自赛季的比赛记录现算，互不串账）
      ensureContracts(nextSeason)
      // 5) 保险按赛季分层：老赛季有效保单自然到期（不退保险费）；当季已报案/定损但未赔付的
      //    理赔单一律拒付结案（赛季结束是保险责任的终点），已赔付的不受影响、原样归档可查
      run("UPDATE insurance SET status='expired', expired_at=? WHERE season=? AND status='active'", now(), season)
      run("UPDATE incidents SET status='rejected', rejected_at=? WHERE season=? AND status IN ('reported','assessed')",
        now(), season)
      body = {
        ok: true, already: false, season: nextSeason,
        summary: {
          season, pts: Number(t.season_pts) || 0, money: live.money, rep: live.rep,
          wins: live.wins, podiums: live.podiums, bestRank: live.bestRank, bestPos,
          incidents: live.incidents, payouts: live.payouts
        }
      }
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    console.error('[SKY] 新赛季衔接失败', e)
    return { status: 500, body: { ok: false, msg: '新赛季开启失败，请重试' } }
  }
  return { status: 200, body }
}

/* ================= 赛事事故与保险理赔 =================
 * 事故在开赛瞬间随比赛记录确定性生成（record.incident），结算时事故损伤施加给出赛艇
 * （自有艇 → parts_dur/hp，租约艇 → wear_total，与正常磨损同口径），并生成物理理赔单
 * （reported）。车队随后可：定损（服务端按出赛艇归属核定维修费用）→ 赔付（当季有效保单、
 * 且保单先于开赛存在，按 coverage 与上限赔付，一案一季，付款幂等）。
 * 保单按赛季分层：衔接新赛季时有效保单到期、未决理赔单拒付；越站作废按结算口径对称冲回
 * （已赔付的赔款冲回、保单恢复有效）。所有资金/声望改动都在调用方事务边界一次完成。
 */
const OWN_REPAIR_RATE = 25  // 自有艇事故损伤的单位维修费用（与 /api/maintain 的 25/点同价）
function currentPolicy(season = teamCore().season) {
  return get('SELECT * FROM insurance WHERE season=? ORDER BY id DESC LIMIT 1', season) || null
}
// 行时间 → epoch ms：新表 created_at 为数字串；老库/中文时间串兜底回退 0（按「不早于」失败处理）
function tsMs(v) { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : (Date.parse(v) || 0) }
// 理赔单对外视图：附带比赛/赛道信息、出赛艇归属与当前可执行动作（服务端判定，前端只渲染）
function incidentBrief(season, raceId) {
  const row = get('SELECT * FROM incidents WHERE race_id=? AND season=?', raceId, season)
  if (!row) return null
  const race = get('SELECT * FROM races WHERE id=?', row.race_id)
  let rec = null
  try { rec = race ? JSON.parse(race.record) : null } catch (e) { rec = null }
  const cir = get('SELECT name,weather,diff FROM circuits WHERE id=?', row.circuit_id)
  const rentalSnap = rec?.factors?.rental || null
  const policy = row.claim_id ? get('SELECT * FROM insurance WHERE id=?', row.claim_id) : null
  const lv = INCIDENT_LEVELS[row.level]
  return {
    id: row.id, raceId: row.raceId || row.race_id, season: row.season,
    circuit: { id: row.circuit_id, name: cir?.name || '', weather: cir?.weather || rec?.circuit?.weather || '', diff: cir?.diff ?? rec?.circuit?.diff ?? 0 },
    rank: race?.rank ?? rec?.result?.rank ?? null,
    level: row.level, levelLabel: lv?.label || row.level, repLoss: lv?.repLoss || 0,
    cause: row.cause, damage: row.damage,
    ship: rentalSnap ? { kind: 'rental', name: rentalSnap.name } : { kind: 'own', name: airship().name },
    repairCost: row.repair_cost || 0, assessed: row.assessed || 0, payout: row.payout || 0,
    status: row.status, claimId: row.claim_id || null,
    policyName: policy?.name || null,
    reportedAt: row.reported_at, assessedAt: row.assessed_at, paidAt: row.paid_at, rejectedAt: row.rejected_at
  }
}
// 报案 → 定损 → 赔付 各阶段的可行性（服务端单一口径，按钮与接口共用）。
// filed=false 时用于「未报案事故」的入口判定（只关心保单是否有效、是否先于开赛）。
function claimEligibility(inc, season = teamCore().season, filed = true) {
  const res = { canReport: false, canAssess: false, canPayout: false, reason: '' }
  const race = inc.race_id != null ? getRaceRow(inc.race_id) : null
  if (!race || race.status !== 'settled' || !race.settled) {
    res.reason = '只有已结算的比赛才能报案理赔'
    return res
  }
  if (race.season !== season) { res.reason = '该事故属于往季赛事，保险责任已终止'; return res }
  if (filed && inc.status === 'void') { res.reason = '该事故记录已随比赛作废'; return res }
  const policy = currentPolicy(season)
  if (!policy || policy.status !== 'active') { res.reason = '当前赛季没有有效保单，请先投保'; return res }
  if (policy.claimed_incident_id) { res.reason = '本季保单的一次理赔机会已使用'; return res }
  // 事后投保不予理赔：保单必须在该场开赛之前生效（1s 时钟余量：开赛仅早于保单 1s 内仍视为在先）；
  // created_ts 为 epoch 列，老库缺失时回退 created_at 字符串解析（0 = 无法证明在先）
  if ((Number(race.created_ts) || tsMs(race.created_at)) - 1000 > tsMs(policy.created_at)) {
    res.reason = '保单生效于该场比赛之后，事故不在保障范围'
    return res
  }
  res.policy = policy
  if (!filed) res.canReport = true
  else if (inc.status === 'reported') { res.canReport = true; res.canAssess = true }
  else if (inc.status === 'assessed') { res.canPayout = true }
  else res.reason = '该理赔单已结案'
  return res
}
// 定损核算：只根据事故快照的出赛艇归属计算，金额完全服务端核定，客户端提交一律忽略。
//  - 租约艇：事故损伤已计入租约 wear_total（将在归还时按费率扣押金），按租约快照费率定损；
//    租约已归还则按实际磨损费口径（回查租约行费率），赔付对冲的是租方承担的押金损失；
//  - 自有艇：按统一维修单价定损，赔付可直接用于机库维修恢复部件。
function assessIncident(inc) {
  let repairRate = OWN_REPAIR_RATE, shipName = airship().name
  const race = getRaceRow(inc.race_id)
  let rec = null
  try { rec = race ? JSON.parse(race.record) : null } catch (e) { rec = null }
  const rtSnapId = rec?.factors?.rental?.id
  if (rtSnapId) {
    // 租约艇出赛：事故损伤已计入 wear_total（归还时按费率扣押金），按租约快照费率定损，
    // 保险赔付对冲的正是租方要承担的这部分押金损失
    const rt = get('SELECT * FROM rentals WHERE id=?', rtSnapId)
    if (rt) { repairRate = rt.wear_rate; shipName = rt.name }
  }
  const repairCost = (inc.damage || 0) * repairRate
  return { repairCost, assessed: repairCost, shipName }
}
// 对外保险视图：方案目录 + 当季保单 + 本季事故清单（含尚未报案的已结算事故）+ 赛季统计
function insurancePayload(season = teamCore().season) {
  const policy = currentPolicy(season)
  // 本季全部「已结算且未作废」且带事故快照的比赛：有物理理赔单的以单子状态为准，
  // 尚未报案的给出 filed=false 的视图供前端渲染「报案」入口
  const settled = all("SELECT * FROM races WHERE status='settled' AND settled=1 AND season=? ORDER BY id DESC", season)
  const incidents = []
  // 每条事故附上服务端判定的可执行动作（按钮置灰与提示与接口口径完全一致）
  const eligOf = (raceRow, filedInc) => {
    const e = claimEligibility(filedInc || { race_id: raceRow.id, status: 'unfiled' }, season, !!filedInc)
    return { canReport: !!e.canReport, canAssess: !!e.canAssess, canPayout: !!e.canPayout, reason: e.reason || '' }
  }
  settled.forEach(race => {
    let rec = null
    try { rec = JSON.parse(race.record) } catch (e) { rec = null }
    if (!rec?.incident) return
    const existing = get('SELECT * FROM incidents WHERE race_id=?', race.id)
    if (existing) {
      const v = incidentBrief(season, race.id)
      v.elig = eligOf(race, existing)
      incidents.push(v)
      return
    }
    const lv = INCIDENT_LEVELS[rec.incident.level]
    const cir = rec.circuit
    incidents.push({
      id: null, raceId: race.id, season,
      circuit: { id: cir.id, name: cir.name, weather: cir.weather, diff: cir.diff },
      rank: race.rank, level: rec.incident.level, levelLabel: lv?.label || rec.incident.level,
      repLoss: lv?.repLoss || 0, cause: rec.incident.cause, damage: rec.incident.damage,
      ship: rec.factors?.rental ? { kind: 'rental', name: rec.factors.rental.name } : { kind: 'own', name: airship().name },
      repairCost: 0, assessed: 0, payout: 0, status: 'unfiled', claimId: null,
      reportedAt: null, assessedAt: null, paidAt: null, rejectedAt: null,
      elig: eligOf(race, null)
    })
  })
  const stats = seasonLiveStats(season)
  return {
    plans: INSURANCE_PLANS.map(p => ({ ...p })),
    policy: policy ? {
      id: policy.id, planId: policy.plan_id, name: policy.name, season: policy.season,
      premium: policy.premium, coverage: policy.coverage, maxPayout: policy.max_payout,
      status: policy.status, claimedIncidentId: policy.claimed_incident_id,
      createdAt: policy.created_at, claimedAt: policy.claimed_at, expiredAt: policy.expired_at
    } : null,
    incidents,
    season,
    stats: { incidents: stats.incidents, payouts: stats.payouts },
    // 此刻是否允许为当季投保（无保单且无进行中比赛；已有有效保单则只能用不能再买）
    canInsure: !policy && !get("SELECT id FROM races WHERE status='running' LIMIT 1")
  }
}
// 投保：客户端只提交方案 id；价格/比例以服务端配置核定。同事务完成
// 「无保单 → 非赛中 → 资金校验 → 扣款 → 建单」，每赛季至多一份，重复/并发不产生两张单。
function buyInsurance(planId) {
  const cfg = INSURANCE_MAP.get(planId)
  if (!cfg) return { status: 400, body: { ok: false, msg: '保险方案不存在' } }
  let result
  db.exec('BEGIN IMMEDIATE')
  try {
    const t = teamCore()
    const season = Number(t.season) || 1
    if (currentPolicy(season)) {
      result = { status: 409, body: { ok: false, msg: '本赛季已持有保单，一份保单当季有效' } }
    } else if (get("SELECT id FROM races WHERE status='running' LIMIT 1")) {
      // 与租艇签约同口径：赛中投保会让「先出事后补保」无从拦截，一律拒绝
      result = { status: 409, body: { ok: false, msg: '比赛进行中，完赛结算后方可投保' } }
    } else if (t.money < cfg.premium) {
      result = { status: 400, body: { ok: false, msg: '资金不足，无法支付保险费', price: cfg.premium } }
    } else {
      run('UPDATE team SET money=money-? WHERE id=1', cfg.premium)
      const r = run(`INSERT INTO insurance (plan_id,name,season,premium,coverage,max_payout,status,created_at)
        VALUES (?,?,?,?,?,?,'active',?)`,
        cfg.id, cfg.name, season, cfg.premium, cfg.coverage, cfg.maxPayout, String(Date.now()))
      result = { status: 200, body: { ok: true, msg: `已投保「${cfg.name}」，保险费 ¥${cfg.premium}（当季有效，理赔一次）`, id: Number(r.lastInsertRowid) } }
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    console.error('[SKY] 投保失败', e)
    result = { status: 500, body: { ok: false, msg: '投保失败，请重试' } }
  }
  return result
}
// 报案：只有比赛记录中确有事故且该场已结算才能立案；幂等（重复报案返回同一张单）
function reportIncident(raceId) {
  const race = getRaceRow(raceId)
  if (!race) return { status: 404, body: { ok: false, msg: '比赛记录不存在' } }
  let rec = null
  try { rec = JSON.parse(race.record) } catch (e) { rec = null }
  if (!rec?.incident) return { status: 400, body: { ok: false, msg: '该场比赛没有发生事故，无需报案' } }
  if (race.status !== 'settled' || !race.settled) return { status: 409, body: { ok: false, msg: '比赛完赛结算后才能报案' } }
  let result
  db.exec('BEGIN IMMEDIATE')
  try {
    const exist = get('SELECT * FROM incidents WHERE race_id=?', race.id)
    if (exist) {
      if (exist.status === 'void') result = { status: 409, body: { ok: false, msg: '该事故记录已随比赛作废' } }
      else if (exist.status === 'rejected') result = { status: 409, body: { ok: false, msg: '该理赔单已随赛季结束拒付结案' } }
      else result = { status: 200, body: { ok: true, already: true, incident: incidentBrief(exist.season, race.id) } }
    } else {
      const t = teamCore()
      if (race.season !== (Number(t.season) || 1)) {
        result = { status: 409, body: { ok: false, msg: '该事故属于往季赛事，保险责任已终止' } }
      } else {
        run(`INSERT INTO incidents (race_id,season,circuit_id,level,cause,damage,status,created_at,reported_at)
          VALUES (?,?,?,?,?,?,'reported',?,?)`,
          race.id, race.season, race.circuit_id, rec.incident.level, rec.incident.cause,
          rec.incident.damage, race.created_at || now(), now())
        result = { status: 200, body: { ok: true, already: false, incident: incidentBrief(race.season, race.id) } }
      }
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    console.error('[SKY] 事故报案失败', e)
    result = { status: 500, body: { ok: false, msg: '报案失败，请重试' } }
  }
  return result
}
// 定损：金额全部服务端核定（出赛艇归属 × 损伤点数），重复定损幂等返回同一结果
function assessIncidentById(incidentId) {
  const inc = get('SELECT * FROM incidents WHERE id=?', incidentId)
  if (!inc) return { status: 404, body: { ok: false, msg: '理赔单不存在' } }
  if (inc.status === 'void') return { status: 409, body: { ok: false, msg: '该理赔单已随比赛作废' } }
  if (inc.season !== (Number(teamCore().season) || 1)) {
    return { status: 409, body: { ok: false, msg: '该事故属于往季赛事，保险责任已终止' } }
  }
  if (inc.status === 'paid') return { status: 200, body: { ok: true, already: true, incident: incidentBrief(inc.season, inc.race_id) } }
  if (inc.status === 'rejected') return { status: 409, body: { ok: false, msg: '该理赔单已拒付结案' } }
  let result
  db.exec('BEGIN IMMEDIATE')
  try {
    const cur = get('SELECT * FROM incidents WHERE id=?', inc.id)
    if (cur.status === 'assessed' || cur.status === 'paid') {
      result = { status: 200, body: { ok: true, already: true, incident: incidentBrief(cur.season, cur.race_id) } }
    } else if (cur.status !== 'reported') {
      result = { status: 409, body: { ok: false, msg: '当前状态不能定损' } }
    } else {
      const a = assessIncident(cur)
      run('UPDATE incidents SET repair_cost=?, assessed=?, status=?, assessed_at=? WHERE id=?',
        a.repairCost, a.assessed, 'assessed', now(), cur.id)
      result = { status: 200, body: { ok: true, already: false, incident: incidentBrief(cur.season, cur.race_id) } }
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    console.error('[SKY] 定损失败', e)
    result = { status: 500, body: { ok: false, msg: '定损失败，请重试' } }
  }
  return result
}
// 赔付：当季有效保单（且先于开赛）→ 按 coverage 与单次上限核定赔款 → 资金到账、保单结案。
// 以 incidents.status='assessed' 为唯一闸门（事务内二次校验），重复/并发只赔一次。
function payoutIncident(incidentId) {
  const inc = get('SELECT * FROM incidents WHERE id=?', incidentId)
  if (!inc) return { status: 404, body: { ok: false, msg: '理赔单不存在' } }
  if (inc.status === 'void') return { status: 409, body: { ok: false, msg: '该理赔单已随比赛作废' } }
  if (inc.status === 'rejected') return { status: 409, body: { ok: false, msg: '该理赔单已拒付结案' } }
  if (inc.season !== (Number(teamCore().season) || 1)) {
    return { status: 409, body: { ok: false, msg: '该事故属于往季赛事，保险责任已终止' } }
  }
  if (inc.status === 'paid') return { status: 200, body: { ok: true, already: true, incident: incidentBrief(inc.season, inc.race_id) } }
  if (inc.status !== 'assessed') return { status: 409, body: { ok: false, msg: '请先完成定损再申请赔付' } }
  const elig = claimEligibility(inc, inc.season)
  if (!elig.policy) return { status: 409, body: { ok: false, msg: elig.reason || '当前不满足赔付条件' } }
  const policy = elig.policy
  let result
  db.exec('BEGIN IMMEDIATE')
  try {
    const cur = get('SELECT * FROM incidents WHERE id=?', inc.id)
    const pol = get('SELECT * FROM insurance WHERE id=?', policy.id)
    const race = getRaceRow(cur.race_id)
    if (cur.status === 'paid') {
      result = { status: 200, body: { ok: true, already: true, incident: incidentBrief(cur.season, cur.race_id) } }
    } else if (cur.status !== 'assessed') {
      result = { status: 409, body: { ok: false, msg: '请先完成定损再申请赔付' } }
    } else if (!pol || pol.status !== 'active' || pol.claimed_incident_id) {
      result = { status: 409, body: { ok: false, msg: '保单已失效或本季理赔机会已使用' } }
    } else if ((Number(race.created_ts) || tsMs(race.created_at)) - 1000 > tsMs(pol.created_at)) {
      result = { status: 409, body: { ok: false, msg: '保单生效于该场比赛之后，事故不在保障范围' } }
    } else {
      const payout = Math.min(Math.round(cur.assessed * pol.coverage), pol.max_payout)
      run('UPDATE team SET money=money+? WHERE id=1', payout)
      run("UPDATE incidents SET status='paid', payout=?, claim_id=?, paid_at=? WHERE id=?",
        payout, pol.id, now(), cur.id)
      run("UPDATE insurance SET status='claimed', claimed_incident_id=?, claimed_at=? WHERE id=?",
        cur.id, now(), pol.id)
      result = {
        status: 200,
        body: { ok: true, already: false, payout, assessed: cur.assessed, coverage: pol.coverage, incident: incidentBrief(cur.season, cur.race_id) }
      }
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    console.error('[SKY] 保险赔付失败', e)
    result = { status: 500, body: { ok: false, msg: '赔付失败，请重试' } }
  }
  return result
}

// 历史数据兼容（迁移补偿）：修复「跳站参赛」产生的脏数据——首个未完成赛站之后的
// 完赛记录一律视为越站。在同一事务内：
//   1) 按各场记录的发奖口径，回滚积分/奖金/声望/部件磨损（parts_dur、hp）/机师经验与心情；
//      租约艇比赛按开赛快照归属回滚：在履租约回滚磨损/场次（不动钱），已归还租约重算磨损费
//      并补退押金差额（与 settleRace / 归还结算共用同一磨损归属边界）；
//   2) 删除对应 race_log 流水（含无记录关联的老版残留流水）；
//   3) 将这些赛站的 races 记录一律置为 void（作废，不再出现在历史战绩、不能续看或再结算）；
//   4) 重置赛站，再统一重算赛季合约对账与赛季名次。
// 所有资金改动（奖金冲回、押金补退、合约兑现/冲回）在同一事务边界一次完成；函数天然幂等：
// 已作废的记录与已删流水在重启时不会被再次统计，已回写的租约退款也不会二次补退。
function reconcileLegacySkips() {
  const cs = orderedCircuits()
  const firstOpen = cs.findIndex(c => !c.finished)
  if (firstOpen === -1) return
  const skipped = cs.slice(firstOpen + 1).filter(c => c.finished)
  if (!skipped.length) return

  db.exec('BEGIN')
  try {
    let ptsBack = 0, moneyBack = 0, repBack = 0, refundBack = 0, payoutBack = 0, repIncBack = 0, racesVoided = 0
    skipped.forEach(c => {
      // 已被 races 记录认领的流水 id：其数额随记录回滚，兜底循环里不得再统计，避免双重回滚
      const claimedLogIds = new Set()
      // 该越站赛站的全部比赛记录：已结算的按记录反向回滚；running 仅作废（从未发奖）
      all('SELECT * FROM races WHERE circuit_id=? ORDER BY id ASC', c.id).forEach(rw => {
        if (rw.settled || rw.status === 'settled') {
          const g = reverseSettledRace(rw, c)
          ptsBack += g.pts; moneyBack += g.money; repBack += g.repGain
          refundBack += g.refundAdd   // 已归还租约需补退的磨损费（回写租约行，由这里统一给钱）
          payoutBack += g.payoutBack // 已理赔结案需冲回的保险赔付金（保单同步恢复有效）
          repIncBack += g.repIncidentBack // 事故声望扣减随作废恢复
          if (rw.id) all('SELECT id FROM race_log WHERE race_id=?', rw.id).forEach(l => claimedLogIds.add(l.id))
        }
        run("UPDATE races SET status='void', settled=0, voided_at=? WHERE id=?", now(), rw.id)
        racesVoided += 1
      })
      // 兜底：早期版本可能留下无 races 关联（或关联未结算记录）的流水，按其自身数额补偿，
      // 声望缺失时按名次/难度重算；已被上面的比赛记录认领的流水一律跳过，确保每条只回滚一次
      all('SELECT * FROM race_log WHERE circuit_id=?', c.id).forEach(l => {
        if (claimedLogIds.has(l.id)) { run('DELETE FROM race_log WHERE id=?', l.id); return }
        ptsBack += l.pts || 0
        moneyBack += l.money || 0
        repBack += Math.max(1, 5 - (l.rank || c.rank || 6) + c.diff)
        run('DELETE FROM race_log WHERE id=?', l.id)
      })
      console.log(`[SKY] 历史修复：赛站《${c.name}》在前置赛站未完成时已完赛（名次 ${c.rank}），回滚战绩、奖励、磨损与人员经验`)
      run('UPDATE circuits SET finished=0, rank=NULL WHERE id=?', c.id)
    })
    // 奖金/声望冲回，押金磨损费补退（refundBack）、保险理赔冲回（payoutBack）
    // ——全部资金改动在同一边界一次完成
    const netMoney = moneyBack + payoutBack - refundBack
    const netRep = Math.max(0, repBack - repIncBack)
    if (ptsBack || netMoney || netRep) {
      run('UPDATE team SET season_pts=MAX(0,season_pts-?), money=money-?, rep=MAX(0,rep-?) WHERE id=1',
        ptsBack, netMoney, netRep)
    }

    reconcileContracts()
    const ranks = orderedCircuits().filter(x => x.finished && x.rank).map(x => x.rank)
    run('UPDATE team SET season_pos=? WHERE id=1', ranks.length ? Math.max(1, Math.min(...ranks)) : 1)
    db.exec('COMMIT')
    console.log(`[SKY] 历史修复完成：作废 ${racesVoided} 条越站比赛记录（${skipped.length} 个赛站），` +
      `积分 -${ptsBack}，奖金 -${moneyBack}，声望 -${netRep}` +
      (refundBack ? `，补退已归还租约磨损费 +${refundBack}` : '') +
      (payoutBack ? `，冲回保险理赔款 -${payoutBack}` : '') +
      '，部件磨损、事故理赔与人员经验已按记录冲回')
  } catch (e) {
    db.exec('ROLLBACK')
    console.error('[SKY] 历史修复失败，已回滚本次迁移补偿', e)
    throw e
  }
}
seed()
ensureContracts()
ensureLineup()
reconcileLegacySkips()
// 启动兜底：无越站可修（或老库/注入数据导致合约状态与战绩不一致）时，上面的修复不会跑对账；
// 这里再幂等对账一次，使「已兑现」始终与本赛季已结算战绩一致（重复执行不产生二次发奖）
db.exec('BEGIN')
try { reconcileContracts(); db.exec('COMMIT') } catch (e) { db.exec('ROLLBACK'); throw e }

/* ---------- 共享响应 ---------- */
const payload = () => {
  const t = teamCore()
  const lu = resolveLineup()
  const st = fleetStats(lu.rental)  // 机库主卡展示「下一站实际出赛艇」（排班解析结果）
  const upgrades = all('SELECT * FROM upgrades')
  const pilots = all('SELECT * FROM pilots')
  const mechanics = all('SELECT * FROM mechanics')
  const circuits = orderedCircuits()
  const contracts = contractsPayload(t.season)
  const insurance = insurancePayload(t.season)
  const log = all('SELECT * FROM race_log ORDER BY id DESC')
  const done = circuits.filter(c => c.finished).length
  // 中断续看：当前未结算的比赛（每场仅一场 running）；history 供历史回放
  const activeRow = get("SELECT * FROM races WHERE status='running' ORDER BY id DESC LIMIT 1")
  const raceRows = all("SELECT * FROM races WHERE status='settled' ORDER BY id DESC")
  return {
    team: t, airship: st, upgrades, pilots, mechanics, circuits, contracts, log,
    // 赛事保险：方案目录 + 当季保单 + 本季事故理赔单（含未报案）+ 事故/赔付统计
    insurance,
    shop: SHOP_ITEMS,
    // 赛事排班：原始排班 + 下一站实际出赛阵容（机师/技工/出赛艇）
    lineup: lineupPayload(),
    // 租赁：当前生效租约（null=自有艇出赛）、艇型目录与最近归还记录
    rental: activeRental(),
    rentalShop: RENTAL_SHIPS,
    rentalHistory: all("SELECT * FROM rentals WHERE status='returned' ORDER BY id DESC LIMIT 5"),
    activeRace: parseRace(activeRow),
    races: raceRows.map(parseRace),
    // 历届赛季榜（seasons 归档行 + 当前赛季滚动行）；6 站完赛、尚未衔接时提示进入新赛季
    seasons: seasonsPayload(),
    seasonComplete: done === circuits.length && circuits.length > 0,
    seasonDone: done, seasonTotal: circuits.length
  }
}

app.get('/api/state', (_, res) => res.json(payload()))
app.get('/api/overview', (_, res) => res.json(payload()))

// 商品目录（服务端配置，供前端渲染商店）：价格/属性均不在客户端可写
app.get('/api/shop', (_, res) => res.json({ ok: true, items: SHOP_ITEMS }))

// 购买改装件：客户端只能提交商品 id；名称、槽位、加成项、加成数值与价格全部以服务端
// SHOP_ITEMS 配置为准，请求体里任何 price/bonus/stat/slot/name 都不会被采信。
app.post('/api/shop', (req, res) => {
  const rawId = req.body?.id
  // 必须是 JSON 数值（拒绝字符串/布尔等可被 Number() 隐式转换的类型），且为正整数
  if (typeof rawId !== 'number' || !Number.isInteger(rawId) || rawId <= 0) {
    return res.status(400).json({ ok: false, msg: '商品编号无效' })
  }
  const item = SHOP_MAP.get(rawId)
  if (!item) return res.status(400).json({ ok: false, msg: '该商品不存在' })

  // 扣款与入库放在同一事务（BEGIN IMMEDIATE 立即取写锁）：余额检查与扣款原子完成，
  // 并发请求不会在「检查通过→实际扣款」之间把资金扣成负数
  let result
  db.exec('BEGIN IMMEDIATE')
  try {
    const t = teamCore()
    if (t.money < item.price) {
      result = { status: 400, body: { ok: false, msg: '资金不足', price: item.price } }
    } else {
      run('UPDATE team SET money=money-? WHERE id=1', item.price)
      const r = run('INSERT INTO upgrades (name,slot,stat,bonus,price,level) VALUES (?,?,?,?,?,1)',
        item.name, item.slot, item.stat, item.bonus, item.price)
      result = { status: 200, body: { ok: true, msg: `已购入「${item.name}」`, id: Number(r.lastInsertRowid), price: item.price } }
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    console.error('[SKY] 购买失败', e)
    result = { status: 500, body: { ok: false, msg: '购买失败，请重试' } }
  }
  return res.status(result.status).json(result.body)
})
// 装备/卸下
app.post('/api/equip/:id', (req, res) => {
  const up = get('SELECT * FROM upgrades WHERE id=?', Number(req.params.id))
  // 同槽位卸下其他
  all('SELECT id FROM upgrades WHERE slot=? AND equipped=1 AND id!=?', up.slot, up.id).forEach(u => run('UPDATE upgrades SET equipped=0 WHERE id=?', u.id))
  run('UPDATE upgrades SET equipped=1 WHERE id=?', up.id)
  res.json({ ok: true })
})
app.post('/api/unequip/:id', (req, res) => {
  run('UPDATE upgrades SET equipped=0 WHERE id=?', Number(req.params.id))
  res.json({ ok: true })
})

// 人员
app.post('/api/hire_pilot', (req, res) => {
  const t = teamCore(); const cost = 1500
  if (t.money < cost) return res.json({ ok: false, msg: '资金不足' })
  const names = ['鹰眼·鸦', '风歌·岚', '铁羽·矶', '晨星·曦']
  const n = names[Math.floor(Math.random() * names.length)]
  run('UPDATE team SET money=money-? WHERE id=1', cost)
  run('INSERT INTO pilots (name,skill,courage,wage,mood) VALUES (?,?,?,?,?)', n, 45 + Math.floor(Math.random() * 20), 48 + Math.floor(Math.random() * 18), 60, 72)
  res.json({ ok: true, msg: `已招募 ${n}` })
})
app.post('/api/hire_mech', (req, res) => {
  const t = teamCore(); const cost = 1000
  if (t.money < cost) return res.json({ ok: false, msg: '资金不足' })
  const n = '工匠·' + ['铁锤', '螺丝', '风箱', '砧台'][Math.floor(Math.random() * 4)]
  run('UPDATE team SET money=money-? WHERE id=1', cost)
  run('INSERT INTO mechanics (name,skill,wage,mood) VALUES (?,?,?,?)', n, 40 + Math.floor(Math.random() * 20), 40, 74)
  res.json({ ok: true, msg: `已招募 ${n}` })
})
app.post('/api/train', (req, res) => {
  const t = teamCore(); const cost = 800
  if (t.money < cost) return res.json({ ok: false, msg: '资金不足' })
  run('UPDATE team SET money=money-? WHERE id=1', cost)
  run('UPDATE pilots SET skill=skill+2, mood=mood+2 WHERE id=?', Number(req.body.id) || all('SELECT id FROM pilots LIMIT 1')[0].id)
  res.json({ ok: true, msg: '完成特训，技巧+2' })
})

/* ---------- 赛事排班：安排下一站出赛的机师 / 技工 / 飞艇 ---------- */

// 当前排班 + 下一站实际出赛阵容（含自动回落与缺租约警告）
app.get('/api/lineup', (_, res) => res.json({ ok: true, ...lineupPayload() }))

// 更新排班：请求体只接受 pilotId / mechanicId / shipMode 三个字段（省略的字段保持原值，
// null = 恢复自动）；人员 id 必须在车队名册中，其余字段一律忽略。排班在开赛瞬间才快照进
// 比赛记录，比赛进行中修改只影响下一站，不影响正在播放/结算的记录。
app.post('/api/lineup', (req, res) => {
  const b = req.body || {}
  const cur = lineupRow()
  let pilotId = cur.pilot_id, mechanicId = cur.mechanic_id, shipMode = cur.ship_mode
  if ('pilotId' in b) {
    if (b.pilotId === null) pilotId = null
    else if (typeof b.pilotId === 'number' && Number.isInteger(b.pilotId) && b.pilotId > 0 &&
      get('SELECT id FROM pilots WHERE id=?', b.pilotId)) pilotId = b.pilotId
    else return res.status(400).json({ ok: false, msg: '该机师不在车队名册中' })
  }
  if ('mechanicId' in b) {
    if (b.mechanicId === null) mechanicId = null
    else if (typeof b.mechanicId === 'number' && Number.isInteger(b.mechanicId) && b.mechanicId > 0 &&
      get('SELECT id FROM mechanics WHERE id=?', b.mechanicId)) mechanicId = b.mechanicId
    else return res.status(400).json({ ok: false, msg: '该技工不在车队名册中' })
  }
  if ('shipMode' in b) {
    if (!SHIP_MODES.includes(b.shipMode)) return res.status(400).json({ ok: false, msg: '出赛艇排班无效（auto/own/rental）' })
    shipMode = b.shipMode
  }
  run(`INSERT INTO lineup (id,pilot_id,mechanic_id,ship_mode,updated_at) VALUES (1,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET pilot_id=excluded.pilot_id, mechanic_id=excluded.mechanic_id,
    ship_mode=excluded.ship_mode, updated_at=excluded.updated_at`,
    pilotId, mechanicId, shipMode, now())
  res.json({ ok: true, msg: '排班已更新，下一站生效', ...lineupPayload() })
})

// 维护
app.post('/api/maintain', (req, res) => {
  // 排班出赛艇为租约艇时：租赁艇由出租方整备（磨损在归还时计费），自有艇封存，均不可自行维护；
  // 排班为自有艇出赛时（即便有在履租约），自有艇正常磨损，可随时维护
  if (resolveLineup().rental) return res.json({ ok: false, msg: '租约艇由出租方整备；如需维护自有艇，请先将排班出赛艇调整为自有艇' })
  const t = teamCore(); const a = airship()
  const cost = Math.round((100 - a.parts_dur) * 25)
  if (cost < 200 || t.money < 200) return res.status(200).json({ ok: false, cost, msg: cost < 200 ? '部件状态良好，无需维护' : '资金不足' })
  run('UPDATE team SET money=money-? WHERE id=1', cost)
  run('UPDATE airships SET parts_dur=100, hp=100 WHERE id=?', a.id)
  res.json({ ok: true, cost })
})

/* ---------- 飞艇租赁：签约（扣押金+租金）/ 归还（按磨损结算退款，幂等） ---------- */

// 租赁目录与当前租约（目录为服务端配置，客户端不可改写）
app.get('/api/rentals', (_, res) => res.json({
  ok: true,
  items: RENTAL_SHIPS,
  active: activeRental(),
  history: all("SELECT * FROM rentals WHERE status='returned' ORDER BY id DESC LIMIT 5")
}))

// 签约租艇：客户端只提交艇型 id；押金、租金、性能与场次以服务端目录核定。
// 同一事务（BEGIN IMMEDIATE）内完成「无在履租约 → 资金校验 → 扣款 → 建约」，
// 并发/重复点击不会重复扣款或叠加多份租约。
app.post('/api/rentals/rent', (req, res) => {
  const rawId = req.body?.id
  if (typeof rawId !== 'number' || !Number.isInteger(rawId) || rawId <= 0) {
    return res.status(400).json({ ok: false, msg: '艇型编号无效' })
  }
  const cfg = RENTAL_MAP.get(rawId)
  if (!cfg) return res.status(400).json({ ok: false, msg: '该艇型不存在' })

  let result
  db.exec('BEGIN IMMEDIATE')
  try {
    const cur = activeRental()
    if (cur) {
      result = { status: 409, body: { ok: false, msg: `已有进行中的租约《${cur.name}》，归还后方可再租` } }
    } else if (get("SELECT id FROM races WHERE status='running' LIMIT 1")) {
      // 比赛进行中签约会中途切换出赛艇，破坏比赛记录的唯一事实来源，一律拒绝
      result = { status: 409, body: { ok: false, msg: '比赛进行中，完赛结算后方可签约租艇' } }
    } else {
      const t = teamCore()
      const cost = cfg.deposit + cfg.rent
      if (t.money < cost) {
        result = { status: 400, body: { ok: false, msg: '资金不足，无法支付押金与租金', cost } }
      } else {
        run('UPDATE team SET money=money-? WHERE id=1', cost)
        const r = run(`INSERT INTO rentals (ship_id,name,speed,turn,acc,dur,deposit,rent_fee,wear_rate,max_races,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          cfg.id, cfg.name, cfg.speed, cfg.turn, cfg.acc, cfg.dur, cfg.deposit, cfg.rent, cfg.wearRate, cfg.maxRaces, now())
        result = { status: 200, body: { ok: true, msg: `已签约租用「${cfg.name}」（押金 ¥${cfg.deposit} + 租金 ¥${cfg.rent}）`, id: Number(r.lastInsertRowid) } }
      }
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    console.error('[SKY] 租艇签约失败', e)
    result = { status: 500, body: { ok: false, msg: '签约失败，请重试' } }
  }
  return res.status(result.status).json(result.body)
})

// 归还租艇：按租约结算——磨损费 = 累计磨损 × 费率，退款 = 押金 − 磨损费（下限 0）。
// 以 status='active' 为唯一闸门（事务内判定并置 returned），重复请求/断线重放只结算一次；
// 已归还时返回同一份结算结果（幂等），绝不二次退款。
app.post('/api/rentals/return', (req, res) => {
  let result
  db.exec('BEGIN IMMEDIATE')
  try {
    const r = activeRental()
    if (!r) {
      const last = get("SELECT * FROM rentals WHERE status='returned' ORDER BY id DESC LIMIT 1")
      if (last) {
        result = { status: 200, body: { ok: true, already: true, msg: `租约《${last.name}》已结算归还，不会重复退款`, refund: last.refund, wearFee: last.wear_fee, name: last.name } }
      } else {
        result = { status: 400, body: { ok: false, msg: '当前没有进行中的租约' } }
      }
    } else if (get("SELECT id FROM races WHERE status='running' LIMIT 1")) {
      result = { status: 409, body: { ok: false, msg: '比赛进行中，完赛结算后方可归还租艇' } }
    } else {
      const wearFee = r.wear_total * r.wear_rate
      const refund = Math.max(0, r.deposit - wearFee)
      run('UPDATE team SET money=money+? WHERE id=1', refund)
      run("UPDATE rentals SET status='returned', wear_fee=?, refund=?, returned_at=? WHERE id=?", wearFee, refund, now(), r.id)
      result = { status: 200, body: { ok: true, already: false, msg: `已归还「${r.name}」：磨损费 ¥${wearFee}，退还押金 ¥${refund}`, refund, wearFee, name: r.name } }
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    console.error('[SKY] 归还结算失败', e)
    result = { status: 500, body: { ok: false, msg: '归还结算失败，请重试' } }
  }
  return res.status(result.status).json(result.body)
})

/* ---------- 分段比赛：开赛（生成记录）/ 续看 / 进度 / 结算（幂等） ---------- */

// 开赛：仅允许按航线顺序挑战当前未完成的第一站；比赛记录在这一刻完整生成并落库
app.post('/api/races/start/:cid', (req, res) => {
  const cid = Number(req.params.cid)
  // 已有进行中的比赛 → 直接返回原记录用于「中断续看」，绝不重开、不重复结算
  const active = get("SELECT * FROM races WHERE status='running' ORDER BY id DESC LIMIT 1")
  if (active) return res.json({ ok: true, resumed: true, race: parseRace(active) })

  const c = get('SELECT * FROM circuits WHERE id=?', cid)
  if (!c) return res.json({ ok: false, msg: '该赛站不存在' })
  if (c.finished) return res.json({ ok: false, msg: '该站已完赛' })
  // 排班联动：指定租赁艇出赛但无在履租约时拒绝开赛，须先签约或调整排班
  const lu = resolveLineup()
  if (lu.rentalMissing) {
    return res.json({ ok: false, msg: '排班指定租赁艇出赛，但当前没有在履租约，请先在机库签约或调整排班' })
  }
  // 租约联动：排班出赛艇为租约艇且场次用尽时，须先在机库归还结算，才能继续参赛
  const rt = lu.rental
  if (rt && rt.races_used >= rt.max_races) {
    return res.json({ ok: false, msg: `租约《${rt.name}》场次已用完（${rt.races_used}/${rt.max_races}），请先在机库归还租艇` })
  }
  const cur = nextCircuit()
  if (!cur) return res.json({ ok: false, msg: '本赛季已全部完赛' })
  if (cur.id !== cid) {
    const idx = orderedCircuits().findIndex(x => x.id === cid) + 1
    return res.json({ ok: false, msg: `请先完成第 ${orderedCircuits().findIndex(x => x.id === cur.id) + 1} 站《${cur.name}》，第 ${idx} 站尚未解锁` })
  }

  const record = buildRace(c)
  const r = run('INSERT INTO races (circuit_id, season, status, settled, record, watch_el, created_at, created_ts) VALUES (?,?,?,?,?,?,?,?)',
    c.id, record.season, 'running', 0, JSON.stringify(record), 0, now(), Date.now())
  res.json({ ok: true, resumed: false, race: parseRace(getRaceRow(Number(r.lastInsertRowid))) })
})

// 单场比赛记录（历史回放 / 刷新续看进度）
app.get('/api/races/:id', (req, res) => {
  const row = getRaceRow(req.params.id)
  if (!row) return res.status(404).json({ ok: false, msg: '比赛记录不存在' })
  res.json({ ok: true, race: parseRace(row) })
})

// 上报观赛进度（中断续看锚点），只影响播放位置，与结算无关
app.post('/api/races/:id/progress', (req, res) => {
  const row = getRaceRow(req.params.id)
  if (!row) return res.status(404).json({ ok: false, msg: '比赛记录不存在' })
  if (row.settled) return res.json({ ok: true }) // 已结算无需再记进度
  const el = clamp(Number(req.body?.el) || 0, 0, JSON.parse(row.record).duration)
  run('UPDATE races SET watch_el=? WHERE id=?', el, row.id)
  res.json({ ok: true, watch_el: el })
})

// 结算：以比赛记录为唯一依据；幂等，重复/断线重放都只发一次奖；已作废记录返回 409
app.post('/api/races/:id/settle', (req, res) => {
  try {
    const r = settleRace(Number(req.params.id))
    if (r.status === 404) return res.status(404).json(r)
    if (r.status === 409) return res.status(409).json(r)
    res.json(r)
  } catch (e) {
    console.error('[SKY] 结算失败', e)
    res.status(500).json({ ok: false, msg: '结算失败，请重试' })
  }
})

// 新赛季衔接：6 站完赛后由玩家确认触发。归档老赛季排行榜快照、重置积分/赛站/合约滚动层，
// 老赛季 races/race_log/contracts 原样保留（历史战绩与回放不丢）；车队资金/声望/装备/人员/租约保留。
// 幂等：重复点击 / 并发重放只衔接一次（seasons 归档行为唯一闸门）
app.post('/api/seasons/advance', (_, res) => {
  const r = advanceSeason()
  return res.status(r.status).json(r.body)
})

/* ---------- 赛事保险：投保 / 事故清单 / 报案 / 定损 / 赔付（状态机 + 幂等） ---------- */

// 保险视图：方案目录、当季保单、本季事故理赔单与赛季事故统计
app.get('/api/insurance', (_, res) => res.json({ ok: true, ...insurancePayload() }))

// 投保：客户端只提交方案 id；保险费/赔付比例/上限均由服务端配置核定。
// 每赛季至多一份，赛中拒绝（防先出事后补保），扣款与建单在同一事务原子完成
app.post('/api/insurance/buy', (req, res) => {
  const rawId = req.body?.id
  if (typeof rawId !== 'number' || !Number.isInteger(rawId) || rawId <= 0) {
    return res.status(400).json({ ok: false, msg: '保险方案编号无效' })
  }
  const r = buyInsurance(rawId)
  return res.status(r.status).json(r.body)
})

// 报案：以比赛记录中的事故快照为事实依据，只有已结算比赛可立案；重复报案幂等
app.post('/api/incidents/:raceId/report', (req, res) => {
  const r = reportIncident(Number(req.params.raceId))
  return res.status(r.status).json(r.body)
})

// 定损：金额完全由服务端按出赛艇归属（自有艇维修费 / 租约艇磨损费）核定
app.post('/api/incidents/:id/assess', (req, res) => {
  const r = assessIncidentById(Number(req.params.id))
  return res.status(r.status).json(r.body)
})

// 赔付：当季有效保单（且先于开赛）按 coverage × 定损额（上限封顶）一次到账，保单结案；幂等
app.post('/api/incidents/:id/payout', (req, res) => {
  const r = payoutIncident(Number(req.params.id))
  return res.status(r.status).json(r.body)
})

// 重置（重置数据到初始种子）
app.post('/api/reset', (_, res) => {
  ['race_log', 'races', 'rentals', 'contracts', 'seasons', 'circuits', 'upgrades', 'mechanics', 'pilots', 'airships', 'team', 'lineup', 'insurance', 'incidents'].forEach(t => { try { run(`DELETE FROM ${t}`) } catch (e) {} })
  try { run('DELETE FROM sqlite_sequence') } catch (e) {}
  seed()
  ensureLineup()
  res.json({ ok: true })
})

app.listen(PORT, () => console.log(`[SKY] API running at http://localhost:${PORT}`))
