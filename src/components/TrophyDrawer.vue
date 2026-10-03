<script setup>
import { computed } from 'vue'
import { useSkyStore } from '@/store/sky'
const store = useSkyStore()
const emit = defineEmits(['close', 'replay'])
const wIco = { '晴': '🌤️', '风': '🌬️', '雨': '🌧️', '雾': '🌫️', '雷暴': '⛈️' }
// 历史战绩按「赛季 → 航线赛站顺序」排列；已结算的比赛记录自带完整过程，可点击回放
const rows = computed(() => {
  const order = new Map(store.circuits.map((c, i) => [c.id, i]))
  return (store.raceHistory || [])
    .map(r => ({ ...r, seq: order.get(r.record?.circuit?.id) ?? Number.MAX_SAFE_INTEGER }))
    .sort((a, b) => (b.record.season - a.record.season) || (a.seq - b.seq) || b.id - a.id)
})
// 按赛季分组（新赛季在前）：跨赛季同名赛站各自成组，回放只认各场自己的记录
const groups = computed(() => {
  const gs = new Map()
  rows.value.forEach(r => {
    const s = r.record?.season ?? 1
    if (!gs.has(s)) gs.set(s, [])
    gs.get(s).push(r)
  })
  return [...gs.entries()].map(([season, list]) => ({ season, list }))
})
function stationName(seq) { return seq < 0 || seq >= store.circuits.length ? '' : `第 ${seq + 1} 站` }
const curSeason = computed(() => store.team.season || 1)
const rankTxt = r => (r == null ? '—' : '第 ' + r + ' 名')
</script>

<template>
  <div class="drawer-mask" @click.self="emit('close')">
    <aside class="drawer">
      <header class="d-h">
        <div><h3>🏆 赛季之巅</h3><div class="d-sub">合约条款、历届赛季榜与跨赛季回放</div></div>
        <button class="d-x" @click="emit('close')">✕</button>
      </header>

      <div class="d-body">
        <!-- 赛季积分大数（仅当前赛季；完季归档后归零重开） -->
        <div class="pts-card">
          <div class="pts-num mono">{{ store.team.season_pts }}</div>
          <div class="pts-label">第 {{ curSeason }} 赛季积分</div>
        </div>

        <!-- 历届赛季榜：完季归档快照 + 当前赛季滚动行，按赛季分层 -->
        <section>
          <div class="sec-h"><b>🗂️ 历届赛季榜</b><span class="d-sub">完季归档 · 跨赛季排名</span></div>
          <div class="season-board">
            <div v-for="s in store.seasons" :key="s.season" class="sb-row" :class="{ cur: s.current }">
              <span class="sb-s">S{{ s.season }}</span>
              <span class="sb-pts mono">{{ s.pts }}<em>分</em></span>
              <span class="sb-pos">{{ s.current ? '暂列 ' : '最终 ' }}{{ rankTxt(s.bestPos) }}</span>
              <span class="sb-meta mono">{{ s.wins }}🏆 · {{ s.podiums }}🥉 · {{ s.racesN }}站</span>
              <span class="sb-inc mono" :class="{ bad: s.incidents > 0 }">💥 {{ s.incidents }} · 🛡️¥{{ s.payouts || 0 }}</span>
              <span v-if="s.current" class="tag o sb-tag">进行中</span>
              <span v-else class="tag m sb-tag">已归档</span>
            </div>
          </div>
        </section>

        <!-- 赛季合约：按天气/名次/租赁艇等条款累计进度，全部达成后一次性兑现（仅当前赛季） -->
        <section>
          <div class="sec-h"><b>🚩 第 {{ curSeason }} 赛季合约 <span class="d-sub">累计条款进度，结算时一次性兑现</span></b></div>
          <div v-for="c in store.contracts" :key="c.id" class="sp-card ct-card" :class="{ done: c.earned }">
            <div class="sp-top">
              <b>{{ c.name }}</b>
              <span class="tag" :class="c.earned ? 'm' : 'o'">
                {{ c.earned ? '✔ 已兑现 ' + (c.paidAt || '') : `条款 ${c.doneCount}/${c.need}` }}
              </span>
            </div>
            <div v-if="c.note" class="ct-note">{{ c.note }}</div>
            <div v-for="(tm, i) in c.terms" :key="i" class="ct-term" :class="{ ok: tm.reached }">
              <span class="ct-tick">{{ tm.reached ? '✔' : '○' }}</span>
              <span class="ct-label">{{ tm.label }}</span>
              <span class="ct-prog mono" :class="{ done: tm.reached }">
                {{ tm.type === 'points' ? Math.min(tm.value, tm.target) : tm.value }}/{{ tm.target }}
              </span>
              <span class="hbar ct-bar"><i :style="{ width: Math.min(100, tm.value / tm.target * 100) + '%' }"></i></span>
            </div>
            <div class="sp-reward"><span>兑现奖励</span><span class="row gap8"><span class="tag o">¥{{ c.reward }}</span><span class="tag v">声望+{{ c.rep }}</span></span></div>
          </div>
        </section>

        <!-- 战绩：按赛季分层分组；点击「回放」用该场比赛记录重放动画，不再次结算 -->
        <section>
          <div class="sec-h"><b>🏁 历史战绩</b><span class="d-sub">按赛季分层 · 点击回放全场</span></div>
          <div v-if="groups.length" class="race-groups">
            <div v-for="g in groups" :key="g.season" class="race-group">
              <div class="rg-head" :class="{ cur: g.season === curSeason }">
                <b>第 {{ g.season }} 赛季</b>
                <span v-if="g.season === curSeason" class="tag o sm-tag">当前赛季 · {{ g.list.length }} 站</span>
                <span v-else class="tag m sm-tag">已归档 · {{ g.list.length }} 站</span>
              </div>
              <div class="race-rows">
                <div v-for="l in g.list" :key="l.id" class="race-row replay-row">
                  <span class="rname">
                    <em class="rseq">{{ stationName(l.seq) }}</em>{{ l.record.circuit.name }}
                    <em class="rweather">{{ wIco[l.record.circuit.weather] }} {{ l.record.circuit.weather }}</em>
                    <em v-if="l.record.incident" class="rincident" :title="l.record.incident.cause">💥 {{ ({ minor: '轻微', major: '严重', crash: '坠毁' })[l.record.incident.level] }}</em>
                  </span>
                  <span class="rmedal" :class="'m' + l.rank">{{ l.rank <= 3 ? ['🥇','🥈','🥉'][l.rank-1] : '🌊' }}</span>
                  <span class="rpts mono">+{{ l.pts }} 分</span>
                  <button class="btn ghost sm" @click="emit('replay', l)">↻ 回放</button>
                </div>
              </div>
            </div>
          </div>
          <div v-else class="empty" style="color:var(--muted)">尚未参赛，去浮岛赛道开赛吧！</div>
        </section>
      </div>
    </aside>
  </div>
</template>
