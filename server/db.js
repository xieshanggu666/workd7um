import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const db = new DatabaseSync(path.join(__dirname, 'sky.db'))

db.exec(`
CREATE TABLE IF NOT EXISTS team (
  id INTEGER PRIMARY KEY,
  name TEXT,
  money REAL DEFAULT 20000,
  rep INTEGER DEFAULT 50,
  level INTEGER DEFAULT 1,
  season INTEGER DEFAULT 1,
  season_pts INTEGER DEFAULT 0,
  season_pos INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS airships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  speed INTEGER DEFAULT 60,
  dur INTEGER DEFAULT 80,
  turn INTEGER DEFAULT 55,
  acc INTEGER DEFAULT 60,
  parts_dur INTEGER DEFAULT 100,
  hp INTEGER DEFAULT 100
);
CREATE TABLE IF NOT EXISTS pilots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  skill INTEGER DEFAULT 50,
  courage INTEGER DEFAULT 50,
  exp INTEGER DEFAULT 0,
  wage INTEGER DEFAULT 60,
  mood INTEGER DEFAULT 70
);
CREATE TABLE IF NOT EXISTS mechanics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  skill INTEGER DEFAULT 50,
  wage INTEGER DEFAULT 40,
  mood INTEGER DEFAULT 70
);
CREATE TABLE IF NOT EXISTS upgrades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slot TEXT NOT NULL,          -- 引擎/护甲/氮气/翼板/龙骨
  stat TEXT NOT NULL,          -- speed/dur/turn/acc 加成项
  bonus INTEGER NOT NULL,
  price INTEGER NOT NULL,
  level INTEGER DEFAULT 1,
  equipped INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS circuits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  diff INTEGER NOT NULL,       -- 1..5 难度
  weather TEXT NOT NULL,       -- 晴/风/雨/雾/雷暴
  bonus_pts INTEGER DEFAULT 0,
  done INTEGER DEFAULT 0,
  rank INTEGER,
  finished INTEGER DEFAULT 0
);
-- 赛季合约（取代固定积分型赞助）：条款为服务端配置快照（terms JSON），
-- 进度不入库——始终从本赛季已结算比赛记录（天气/名次/租约快照）现算，
-- 达成全部（或 need 指定数量）条款即在结算事务内一次性兑现奖励；earned=唯一闸门
CREATE TABLE IF NOT EXISTS contracts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  season INTEGER NOT NULL DEFAULT 1,
  note TEXT DEFAULT '',            -- 合约一句话说明（展示用）
  terms TEXT NOT NULL,             -- {v,terms:[...]} 条款配置快照（服务端配置，客户端不可改写）
  need INTEGER NOT NULL,           -- 需达成的条款数（=条款总数即全部达成）
  reward INTEGER NOT NULL DEFAULT 0,
  rep INTEGER NOT NULL DEFAULT 0,
  earned INTEGER NOT NULL DEFAULT 0,
  paid_at TEXT
);
-- 赛季档案（排行榜的单一事实来源）：新赛季衔接时把刚结束赛季的最终战绩快照归档于此，
-- 老赛季的 races/race_log/contracts 原样保留供历史回放；team.season_pts 等滚动数据随之归零。
-- 一季一行（season 唯一），赛季之巅抽屉的历届赛季榜按本表 + 当前赛季滚动数据分层渲染。
CREATE TABLE IF NOT EXISTS seasons (
  season INTEGER PRIMARY KEY,
  pts INTEGER NOT NULL DEFAULT 0,        -- 本赛季最终积分
  money INTEGER NOT NULL DEFAULT 0,      -- 本赛季累计奖金
  rep INTEGER NOT NULL DEFAULT 0,        -- 本赛季累计声望
  wins INTEGER NOT NULL DEFAULT 0,       -- 夺冠（第 1 名）场次
  podiums INTEGER NOT NULL DEFAULT 0,    -- 登台（前 3 名）场次
  best_rank INTEGER,                     -- 本赛季最佳分站名次
  best_pos INTEGER NOT NULL DEFAULT 1,   -- 赛季车队最终名次
  races_n INTEGER NOT NULL DEFAULT 0,    -- 已结算赛站数（完季 = 赛站总数）
  incidents INTEGER NOT NULL DEFAULT 0,  -- 本赛季发生的赛事事故起数（轻微/严重/坠毁）
  payouts INTEGER NOT NULL DEFAULT 0,    -- 本赛季保险理赔实际赔付总额
  finished_at TEXT
);
CREATE TABLE IF NOT EXISTS race_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  circuit_id INTEGER,
  race_id INTEGER,             -- 对应 races.id，一场比赛一条流水
  season INTEGER,
  rank INTEGER,
  pts INTEGER,
  money REAL,
  note TEXT,
  ts TEXT
);
-- 飞艇租约：签约时快照艇型性能与费用口径，履行期间的比赛磨损记入租约，
-- 归还时按 wear_total × wear_rate 从押金中结算退款；status=active 履行中 | returned 已归还
CREATE TABLE IF NOT EXISTS rentals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ship_id INTEGER NOT NULL,          -- 租赁目录艇型 id（服务端配置）
  name TEXT NOT NULL,                -- 艇名快照
  speed INTEGER NOT NULL,
  turn INTEGER NOT NULL,
  acc INTEGER NOT NULL,
  dur INTEGER NOT NULL,
  deposit INTEGER NOT NULL,          -- 押金（签约时暂扣，归还时按磨损结算退还）
  rent_fee INTEGER NOT NULL,         -- 租金（签约时一次性收取，不退）
  wear_rate INTEGER NOT NULL,        -- 每点比赛磨损的计费（归还时从押金中扣）
  max_races INTEGER NOT NULL,        -- 租约包含的场次
  races_used INTEGER NOT NULL DEFAULT 0,
  parts_dur INTEGER NOT NULL DEFAULT 100,  -- 租约艇部件健康（比赛磨损实时扣减）
  wear_total INTEGER NOT NULL DEFAULT 0,   -- 租约期间累计磨损（归还计费依据）
  status TEXT NOT NULL DEFAULT 'active',   -- active | returned
  wear_fee INTEGER,                  -- 归还结算的磨损费
  refund INTEGER,                    -- 归还实际退款（押金-磨损费，下限 0）
  created_at TEXT,
  returned_at TEXT
);
-- 赛事排班（单行表，id 恒为 1）：车队为下一站安排的机师 / 技工 / 出赛艇。
-- 人员为 NULL = 自动（最强阵容）；ship_mode = auto（租约在履即租约艇）| own（自有艇）| rental（必须租约艇）。
-- 开赛瞬间解析并快照进 races.record.factors.lineup，结算与历史修复只认快照，事后改排班不影响已开赛记录
CREATE TABLE IF NOT EXISTS lineup (
  id INTEGER PRIMARY KEY CHECK (id=1),
  pilot_id INTEGER,                      -- 指定机师；NULL = 自动
  mechanic_id INTEGER,                   -- 指定技工；NULL = 自动
  ship_mode TEXT NOT NULL DEFAULT 'auto',
  updated_at TEXT
);
-- 保单：赛季开始可投保（每赛季一份），保险费不退，赛季结束（衔接）自然到期。
-- status=active 有效（可报案）| expired 已到期（未用完的赛季失效）| claimed 本季已理赔结案
CREATE TABLE IF NOT EXISTS insurance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NOT NULL,
  name TEXT NOT NULL,             -- 方案名称快照
  season INTEGER NOT NULL,        -- 所属赛季（赛季分层：仅当季事故可报案）
  premium INTEGER NOT NULL,       -- 保险费（投保即扣，不退）
  coverage REAL NOT NULL,         -- 赔付比例（定损额 × coverage = 赔付额）
  max_payout INTEGER NOT NULL,    -- 单次赔付上限
  status TEXT NOT NULL DEFAULT 'active',
  claimed_incident_id INTEGER,    -- 已理赔结案的事故 id（一案一季）
  created_at TEXT,
  claimed_at TEXT,
  expired_at TEXT
);
-- 赛事事故与理赔单（一体）：事故在开赛瞬间随比赛记录确定性生成（incident 快照），
-- 但只有已结算比赛才能报案——退赛/作废记录的事故不可理赔。一案一次赔付，全链路幂等。
-- status: none 无事故（不建物理行）| reported 已报案待定损 | assessed 已定损待赔付 | paid 已赔付结案 | rejected 理赔拒付
CREATE TABLE IF NOT EXISTS incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  race_id INTEGER NOT NULL UNIQUE,   -- 一场比赛至多一起事故
  season INTEGER NOT NULL,
  circuit_id INTEGER NOT NULL,
  level TEXT NOT NULL,               -- minor 轻微 | major 严重 | crash 坠毁
  cause TEXT NOT NULL DEFAULT '',    -- 事故情形（服务端文案）
  damage INTEGER NOT NULL DEFAULT 0, -- 事故额外损伤（施加给出赛艇的部件/结构）
  repair_cost INTEGER NOT NULL DEFAULT 0,  -- 定损维修费用（事故维修实际花费口径）
  assessed INTEGER NOT NULL DEFAULT 0,     -- 定损总额（维修费用基准）
  payout INTEGER NOT NULL DEFAULT 0,       -- 保险实际赔付
  claim_id INTEGER,                        -- 理赔所用保单 id
  status TEXT NOT NULL DEFAULT 'reported',
  created_at TEXT,                         -- 事故发生（开赛）时间
  reported_at TEXT,
  assessed_at TEXT,
  paid_at TEXT,
  rejected_at TEXT
);
-- 比赛记录：动画 / 实时排名 / 最终奖励共用的唯一事实来源
-- status=running 未完赛（可中断续看）；settled=1 已结算（奖励只发一次，可历史回放）
CREATE TABLE IF NOT EXISTS races (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  circuit_id INTEGER NOT NULL,
  season INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'running',  -- running | settled
  settled INTEGER NOT NULL DEFAULT 0,
  rank INTEGER,
  pts INTEGER DEFAULT 0,
  money REAL DEFAULT 0,
  wear INTEGER DEFAULT 0,
  rep_gain INTEGER DEFAULT 0,
  record TEXT NOT NULL,                    -- 分段过程、快照因素、事件与奖励（JSON）
  watch_el REAL NOT NULL DEFAULT 0,        -- 最近观赛进度（秒），中断续看
  created_at TEXT,
  created_ts INTEGER,                      -- 开赛 epoch ms（保单生效先后的可靠判据）
  settled_at TEXT,
  voided_at TEXT                           -- 作废时间：越站迁移作废的记录，不再参与历史/结算
);
`)

// 老库兼容：为 race_log 增补 race_id 列（已存在则忽略）
try { db.exec('ALTER TABLE race_log ADD COLUMN race_id INTEGER') } catch (e) {}
// 老库兼容：races 增加 voided_at 列（越站历史修复作废记录用）
try { db.exec('ALTER TABLE races ADD COLUMN voided_at TEXT') } catch (e) {}
// 老库兼容：races 增加 created_ts（epoch ms，保单是否先于开赛生效的可靠判据；
// created_at 为本地化展示串，Date.parse 对中文格式不稳定）
try { db.exec('ALTER TABLE races ADD COLUMN created_ts INTEGER') } catch (e) {}
// 老库兼容：seasons 增加事故/理赔统计列（赛季事故与保险赔付归档用）
try { db.exec('ALTER TABLE seasons ADD COLUMN incidents INTEGER NOT NULL DEFAULT 0') } catch (e) {}
try { db.exec('ALTER TABLE seasons ADD COLUMN payouts INTEGER NOT NULL DEFAULT 0') } catch (e) {}

export function run(sql, ...p) { return db.prepare(sql).run(...p) }
export function all(sql, ...p) { return db.prepare(sql).all(...p) }
export function get(sql, ...p) { return db.prepare(sql).get(...p) }