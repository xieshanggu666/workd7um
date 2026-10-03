<script setup>
import { computed, ref } from 'vue'
import { useSkyStore } from '@/store/sky'
const store = useSkyStore()
defineEmits(['close'])

const ins = computed(() => store.insurance)
const policy = computed(() => ins.value.policy)
// 本季事故理赔单（最近在前；status: unfiled 未报案 / reported / assessed / paid / rejected / void）
const incidents = computed(() => ins.value.incidents || [])

const LEVEL_META = {
  minor: { icon: '🩹', cls: 'lv-minor', name: '轻微' },
  major: { icon: '🛠️', cls: 'lv-major', name: '严重' },
  crash: { icon: '💥', cls: 'lv-crash', name: '坠毁' }
}
const STATUS_META = {
  unfiled: { text: '未报案', cls: 'st-unfiled' },
  reported: { text: '已报案 · 待定损', cls: 'st-reported' },
  assessed: { text: '已定损 · 待赔付', cls: 'st-assessed' },
  paid: { text: '✔ 已赔付结案', cls: 'st-paid' },
  rejected: { text: '赛季结束 · 已拒付', cls: 'st-rejected' },
  void: { text: '记录已作废', cls: 'st-void' }
}
const covPct = v => Math.round(v * 100)

const buying = ref(false)
async function buy(p) {
  if (buying.value) return
  buying.value = true
  const r = await store.buyInsurance(p.id)
  if (r?.ok) store.tip(r.msg)
  buying.value = false
}

// 理赔流转：报案 → 定损 → 赔付（每步独立 loading，防重复点击；接口本身幂等）
const busyId = ref(0)
async function report(it) {
  busyId.value = it.raceId
  const r = await store.reportIncident(it.raceId)
  if (r?.ok) store.tip(r.already ? '该事故已报案' : '报案成功，等待定损')
  busyId.value = 0
}
async function assess(it) {
  busyId.value = it.id
  const r = await store.assessIncident(it.id)
  if (r?.ok) store.tip(r.already ? '定损已完成' : `定损完成：维修费用 ¥${r.incident.assessed}`)
  busyId.value = 0
}
async function payout(it) {
  busyId.value = it.id
  const r = await store.payoutIncident(it.id)
  busyId.value = 0
  if (r?.ok) {
    if (r.already) store.tip('该理赔单已赔付，不会重复打款')
    else store.tip(`保险赔付 ¥${r.payout} 已到账`)
  }
}
</script>

<template>
  <div class="drawer-mask" @click.self="$emit('close')">
    <aside class="drawer">
      <header class="d-h">
        <div><h3>🛡️ 赛事保险</h3><div class="d-sub">投保护艇 · 事故报案定损赔付（一案一季）</div></div>
        <button class="d-x" @click="$emit('close')">✕</button>
      </header>

      <div class="d-body">
        <!-- 当季概览 -->
        <div class="ins-overview">
          <div class="io-stat"><b class="mono">{{ ins.stats?.incidents ?? 0 }}</b><span>本季事故</span></div>
          <div class="io-stat"><b class="mono">¥{{ (ins.stats?.payout ?? 0).toLocaleString() }}</b><span>累计赔付</span></div>
          <div class="io-stat"><b class="mono">S{{ ins.season }}</b><span>保险赛季</span></div>
        </div>

        <!-- 当前保单 -->
        <section v-if="policy">
          <div class="sec-h"><b>📃 当前保单</b><span class="d-sub">仅当季有效 · 理赔一次</span></div>
          <div class="policy-card" :class="policy.status">
            <div class="pol-top">
              <b>{{ policy.name }}</b>
              <span class="tag" :class="policy.status === 'active' ? 'm' : policy.status === 'claimed' ? 'o' : 'b'">
                {{ policy.status === 'active' ? '✔ 保障中' : policy.status === 'claimed' ? '已理赔结案' : '已到期' }}
              </span>
            </div>
            <div class="pol-grid">
              <span>保险费<em class="mono">¥{{ policy.premium.toLocaleString() }}</em></span>
              <span>赔付比例<em class="mono">{{ covPct(policy.coverage) }}%</em></span>
              <span>单次上限<em class="mono">¥{{ policy.maxPayout.toLocaleString() }}</em></span>
            </div>
            <div class="pol-hint">
              {{ policy.status === 'claimed'
                ? '本季保单的一次理赔机会已使用，再发生事故仅可维修，不再赔付'
                : policy.status === 'expired'
                  ? '保单随赛季结束到期，保险费不退'
                  : '赛中不可投保；保单须在开赛前生效，事故方在保障范围' }}
            </div>
          </div>
        </section>

        <!-- 投保：每赛季一份，赛中不可投保（防先出事后补保） -->
        <section v-else>
          <div class="sec-h">
            <b>🏦 投保方案</b>
            <span class="d-sub">{{ ins.canInsure ? '当季一份 · 保险费不退' : '比赛进行中，完赛结算后方可投保' }}</span>
          </div>
          <div class="plan-list">
            <div v-for="p in ins.plans" :key="p.id" class="plan-card">
              <div class="plan-top"><b>{{ p.name }}</b><span class="tag b">{{ covPct(p.coverage) }}% 赔付</span></div>
              <div class="plan-note">{{ p.note }}</div>
              <div class="plan-rows">
                <div class="rent-row"><span>保险费（当季）</span><b class="mono">¥{{ p.premium.toLocaleString() }}</b></div>
                <div class="rent-row"><span>单次赔付上限</span><b class="mono">¥{{ p.maxPayout.toLocaleString() }}</b></div>
              </div>
              <button class="btn sm primary w-full" :disabled="buying || !ins.canInsure || store.team.money < p.premium" @click="buy(p)">
                {{ ins.canInsure ? `投保 ¥${p.premium.toLocaleString()}` : '比赛进行中不可投保' }}
              </button>
            </div>
          </div>
        </section>

        <!-- 事故与理赔单 -->
        <section>
          <div class="sec-h">
            <b>🚨 事故与理赔</b><span class="d-sub">事故随比赛记录确定 · 结算后报案</span>
          </div>
          <div v-if="!incidents.length" class="empty" style="color:var(--muted)">
            本季尚无事故记录。恶劣天气、高强度磨损会提高事故率，胆识高的机师更能化险为夷。
          </div>
          <div v-else class="claim-list">
            <div v-for="it in incidents" :key="it.raceId" class="claim-card">
              <div class="cl-head">
                <span class="cl-level" :class="LEVEL_META[it.level]?.cls">
                  {{ LEVEL_META[it.level]?.icon }} {{ LEVEL_META[it.level]?.name || it.level }}
                </span>
                <b class="cl-place">{{ it.circuit.name }}<em v-if="it.rank" class="cl-rank">第 {{ it.rank }} 名</em></b>
                <span class="cl-status" :class="STATUS_META[it.status]?.cls">{{ STATUS_META[it.status]?.text || it.status }}</span>
              </div>
              <div class="cl-cause">{{ it.cause }}</div>
              <div class="cl-meta">
                <span :class="it.ship.kind === 'rental' ? 'tag rose' : 'tag b'">
                  {{ it.ship.kind === 'rental' ? '🛟 ' + it.ship.name : '🛸 ' + it.ship.name }}
                </span>
                <span class="tag o">损伤 {{ it.damage }} 点</span>
                <span v-if="it.repLoss" class="tag rose">声望 −{{ it.repLoss }}</span>
              </div>

              <!-- 定损 / 赔付明细 -->
              <div v-if="it.assessed" class="cl-rows">
                <div class="rent-row"><span>定损维修费用</span><b class="mono">¥{{ it.assessed.toLocaleString() }}</b></div>
                <div v-if="it.status === 'assessed' && policy?.status === 'active'" class="rent-row">
                  <span>预计赔付（{{ covPct(policy.coverage) }}% · 上限 ¥{{ policy.maxPayout.toLocaleString() }}）</span>
                  <b class="mono" style="color:var(--mint)">¥{{ Math.min(Math.round(it.assessed * policy.coverage), policy.maxPayout).toLocaleString() }}</b>
                </div>
                <div v-if="it.status === 'paid'" class="rent-row">
                  <span>实际赔付（{{ it.policyName || '保险' }}）</span>
                  <b class="mono" style="color:var(--mint)">+¥{{ it.payout.toLocaleString() }}</b>
                </div>
              </div>
              <div v-if="['unfiled', 'reported', 'assessed'].includes(it.status) && it.elig?.reason" class="cl-warn">
                ⚠️ {{ it.elig.reason }}
              </div>

              <!-- 状态机操作（可用性以服务端 elig 判定为准：保单有效性/先后/当季次数） -->
              <div class="cl-actions">
                <button v-if="it.status === 'unfiled'" class="btn sm"
                  :class="it.elig?.canReport ? 'primary' : 'ghost'"
                  :disabled="busyId === it.raceId || !it.elig?.canReport" @click="report(it)">📝 报案</button>
                <button v-if="it.status === 'reported'" class="btn sm"
                  :class="it.elig?.canAssess ? 'primary' : 'ghost'"
                  :disabled="busyId === it.id || !it.elig?.canAssess" @click="assess(it)">🔍 提交定损</button>
                <button v-if="it.status === 'assessed'" class="btn sm"
                  :class="it.elig?.canPayout ? 'mint' : 'ghost'"
                  :disabled="busyId === it.id || !it.elig?.canPayout" @click="payout(it)">💰 申请赔付</button>
                <span v-if="it.status === 'paid'" class="cl-done">赔款已到账，可在机库维修恢复部件</span>
                <span v-if="it.status === 'rejected'" class="cl-done dim">未在赛季结束前完成赔付，保险责任终止</span>
              </div>
            </div>
          </div>
        </section>
      </div>
    </aside>
  </div>
</template>
