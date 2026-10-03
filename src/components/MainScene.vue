<script setup>
import { computed, ref } from 'vue'
import { useSkyStore } from '@/store/sky'
const store = useSkyStore()
const emit = defineEmits(['view'])

const wIco = { '晴': '🌤️', '风': '🌬️', '雨': '🌧️', '雾': '🌫️', '雷暴': '⛈️' }
// 浮岛在航线图上的坐标（左下→右上一条上升的航线）
const spots = [
  { x: 150, y: 480 }, { x: 320, y: 415 }, { x: 490, y: 350 },
  { x: 660, y: 290 }, { x: 828, y: 225 }, { x: 955, y: 170 }
]
const circuits = computed(() => store.circuits)
// 当前赛季各完赛赛站是否发生过事故（结算后的比赛记录带 incident 快照），航线上以 💥 标记
const incidentCircuitIds = computed(() => new Set(
  (store.raceHistory || [])
    .filter(r => r.record?.season === store.team.season && r.record?.incident)
    .map(r => r.record.circuit.id)
))
// 赛季进度与航线解锁规则前后端一致：已完赛赛站数即进度，当前待赛站为第一个未完成站
const done = computed(() => circuits.value.filter(c => c.finished).length)
const total = computed(() => store.state?.seasonTotal || circuits.value.length || 6)
const nextId = computed(() => circuits.value.find(c => !c.finished)?.id ?? null)
function isOpen(c) { return !c.finished && c.id === nextId.value }
// 中断续看：未结算的比赛记录（开赛瞬间生成，奖励尚未落账）
const active = computed(() => store.activeRace)
const activeCid = computed(() => active.value?.record?.circuit?.id ?? null)
// 本战排班（下一站实际出赛阵容，服务端解析结果）
const lineupTxt = computed(() => {
  const r = store.lineup?.resolved
  if (!r) return ''
  const p = r.pilot ? r.pilot.name + (r.pilot.auto ? '·自动' : '') : '无机师'
  const m = r.mech ? r.mech.name + (r.mech.auto ? '·自动' : '') : '无技工'
  return `${p} / ${m} / ${r.ship?.name || '自有艇'}`
})

const starting = ref(false)
// 6 站全部完赛（尚未衔接）：航线终点弹出完季浮条，衔接新赛季而不是停在终点
const seasonComplete = computed(() => store.seasonComplete && circuits.value.length > 0)
const advancing = ref(false)
async function advance() {
  if (advancing.value) return
  advancing.value = true
  const r = await store.advanceSeason()
  advancing.value = false
  if (r.ok) {
    await store.refresh()
    store.tip(`第 ${r.season} 赛季开启，新航线已解锁`)
  } else store.tip(r.msg || '新赛季开启失败')
}
// 玩家游艇巡航位置：比赛中停靠在参赛岛；否则锁定当前待赛站；全部完赛后停靠终点岛
const playerPos = computed(() => {
  let idx
  if (activeCid.value != null) idx = circuits.value.findIndex(c => c.id === activeCid.value)
  else idx = nextId.value == null ? total.value - 1 : circuits.value.findIndex(c => c.id === nextId.value)
  return spots[Math.max(0, Math.min(idx, total.value - 1))]
})
function fmt(c) { return '第 ' + c.rank + ' 名' }
async function go(c) {
  if (starting.value) return
  // 该赛站存在未结算的比赛 → 直接续看同一份记录
  if (active.value && activeCid.value === c.id) { emit('view', active.value, 'live'); return }
  if (!isOpen(c)) return
  starting.value = true
  // 开赛：服务器在这一刻生成完整比赛记录（分段过程、事件、奖励全部确定）
  const r = await store.startRace(c.id)
  if (r.ok) {
    if (r.resumed) store.tip('继续观看未结束的比赛')
    emit('view', r.race, 'live')
  } else store.tip(r.msg || '当前还不能参加该站')
  starting.value = false
}
// 顶部「中断续看」浮条
function resume() { if (active.value) emit('view', active.value, 'live') }
</script>

<template>
  <div class="mains">
    <div class="scene-box">
      <svg viewBox="0 0 1060 600" class="scene-svg" preserveAspectRatio="xMidYMid meet">
        <defs>
          <linearGradient id="island" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="#6fd07a" /><stop offset=".6" stop-color="#3f9c5b" /><stop offset="1" stop-color="#3c7d52" />
          </linearGradient>
          <linearGradient id="rock" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="#b98a5a" /><stop offset="1" stop-color="#8a5f37" />
          </linearGradient>
          <radialGradient id="cloudc" cx=".5" cy=".5" r=".5">
            <stop offset="0" stop-color="rgba(255,255,255,.9)" /><stop offset="1" stop-color="rgba(255,255,255,0)" />
          </radialGradient>
        </defs>

        <!-- 云海 -->
        <g opacity=".95">
          <ellipse cx="90" cy="520" rx="260" ry="30" fill="url(#cloudc)" />
          <ellipse cx="330" cy="560" rx="330" ry="36" fill="url(#cloudc)" />
          <ellipse cx="700" cy="585" rx="360" ry="40" fill="url(#cloudc)" />
          <ellipse cx="1000" cy="540" rx="280" ry="34" fill="url(#cloudc)" />
        </g>
        <!-- 远景小云 -->
        <g opacity=".55">
          <circle cx="60" cy="130" r="26" fill="url(#cloudc)" /><circle cx="92" cy="138" r="20" fill="url(#cloudc)" />
          <circle cx="140" cy="90" r="18" fill="url(#cloudc)" />
          <circle cx="880" cy="70" r="22" fill="url(#cloudc)" /><circle cx="912" cy="78" r="16" fill="url(#cloudc)" />
        </g>

        <!-- 航线虚线 -->
        <polyline :points="spots.map(s => s.x + ',' + (s.y - 48)).join(' ')" fill="none" stroke="rgba(255,215,106,.55)" stroke-width="2.5" stroke-dasharray="7 9" stroke-linecap="round" />

        <!-- 6 座浮岛 -->
        <g v-for="(c, i) in circuits" :key="c.id">
          <g :transform="'translate(' + spots[i].x + ',' + spots[i].y + ')'">
            <!-- 浮岛基座 -->
            <ellipse cy="16" rx="34" ry="11" fill="rgba(0,0,40,.25)" />
            <path d="M-34 0 Q-30 -26 0 -30 Q30 -26 34 0 L30 16 Q0 22 -30 16 Z" fill="url(#rock)" />
            <path d="M-24 -10 Q-12 -34 8 -36 Q26 -32 24 -14 L-26 -18 Z" fill="url(#island)" />
            <rect x="-6" y="-24" width="12" height="15" rx="2" fill="#fff5d0" stroke="#d9a441" stroke-width="1.5" />
            <text y="27" text-anchor="middle" font-size="15" font-weight="800" fill="#fff">{{ i + 1 }}</text>

            <!-- 当前待赛站高亮脉冲环 -->
            <circle v-if="isOpen(c)" cy="0" r="40" fill="none" stroke="#ffd76a" stroke-width="2.5" class="pulse-ring" />
            <!-- 未解锁赛站锁标记 -->
            <g v-if="!c.finished && !isOpen(c)" opacity=".9">
              <circle cy="0" r="15" fill="rgba(12,14,42,.72)" stroke="rgba(159,193,255,.55)" stroke-width="1.5" />
              <text y="5" text-anchor="middle" font-size="14">🔒</text>
            </g>

            <!-- 云端标签 -->
            <g :transform="'translate(0,-46)'">
              <rect x="-52" y="-13" width="104" height="26" rx="13" fill="rgba(20,22,58,.78)" stroke="rgba(255,215,106,.5)" />
              <text y="5" text-anchor="middle" font-size="12.5" font-weight="700" fill="#ffe9a8" dominant-baseline="middle">{{ c.name }}</text>
              <text :x="c.weather === '晴' ? 0 : -14" y="24" text-anchor="middle" font-size="12" fill="#9fc1ff">{{ wIco[c.weather] }} {{ c.weather }} · 难度{{ '★'.repeat(c.diff) }}</text>
              <!-- 完赛标记 -->
              <text v-if="c.finished" y="40" text-anchor="middle" font-size="13" font-weight="800" fill="#6fe7d0">✔ {{ fmt(c) }}</text>
              <!-- 事故标记：该站完赛记录中发生过事故（理赔在「赛事保险」抽屉处理） -->
              <text v-if="c.finished && incidentCircuitIds.has(c.id)" y="57" text-anchor="middle" font-size="12">💥</text>
            </g>
          </g>
        </g>

        <!-- 玩家游艇巡航 -->
        <g :transform="'translate(' + (playerPos.x - 56) + ',' + (playerPos.y - 110) + ')'">
          <ellipse cx="40" cy="66" rx="22" ry="6" fill="rgba(0,0,40,.35)" />
          <g class="drift">
            <ellipse cx="40" cy="52" rx="40" ry="14" fill="rgba(255,255,255,.4)" />
            <rect x="22" y="16" width="36" height="24" rx="9" fill="#ffcf5c" stroke="#fff" stroke-width="2" />
            <path d="M40 10 L32 26 L48 26 Z" fill="#ff9fb0" />
            <circle cx="40" cy="44" r="9" fill="#2b2a63" /><circle cx="40" cy="44" r="5" fill="#7ecbff" />
            <text x="61" y="26" font-size="11" font-weight="800" fill="#fff3c9">✈️</text>
          </g>
        </g>
      </svg>

      <!-- HTML 开赛按钮层：叠加在浮岛上方，仅当前待赛站可点击，其余赛站锁定 -->
      <button v-for="(c, i) in circuits" :key="'b' + c.id" v-show="!c.finished"
        class="start-btn" :class="{ locked: !(isOpen(c) || activeCid === c.id) }"
        :disabled="starting || !(isOpen(c) || activeCid === c.id)"
        :title="isOpen(c) || activeCid === c.id ? '' : `请先完成前面的第 ${i} 站`"
        :style="{ left: (spots[i].x / 1060 * 100) + '%', top: ((spots[i].y - 8) / 600 * 100) + '%' }"
        @click="go(c)">{{ activeCid === c.id ? '▶ 续看' : isOpen(c) ? '🚀 开赛' : '🔒 未解锁' }}</button>
    </div>

    <!-- 中断续看浮条：存在未结算比赛时出现，从上次观赛进度继续 -->
    <transition name="pop">
      <button v-if="active" class="resume-hud" @click="resume">
        <span class="rh-dot"></span>
        「{{ active.record.circuit.name }}」比赛进行中 · 点击中断续看
        <b>▶</b>
      </button>
    </transition>

    <!-- 完季浮条：6 站全部结算后衔接新赛季（老赛季战绩与回放保留在赛季之巅） -->
    <transition name="pop">
      <div v-if="seasonComplete" class="season-end-hud">
        <div class="se-trophy">🏆</div>
        <div class="se-main">
          <b>第 {{ store.team.season }} 赛季 6 站全部完赛！</b>
          <span>积分 / 赛站 / 合约 / 排行榜分层重置，资金飞艇与班底保留，往季回放随时可看</span>
        </div>
        <button class="se-go" :disabled="advancing" @click="advance">
          {{ advancing ? '开启中…' : `🚀 进入第 ${store.team.season + 1} 赛季` }}
        </button>
      </div>
    </transition>

    <!-- 赛季进度浮条 -->
    <div class="progress-hud">
      <div class="ph-label">赛季航线进度</div>
      <div class="ph-bar"><i :style="{ width: (done / total * 100) + '%' }"></i></div>
      <div class="ph-nums mono">{{ done }} / {{ total }} 站完赛</div>
      <div v-if="lineupTxt" class="ph-lineup" title="机库「赛事排班」中可调整下一站出赛阵容">🗓️ {{ lineupTxt }}</div>
    </div>
  </div>
</template>