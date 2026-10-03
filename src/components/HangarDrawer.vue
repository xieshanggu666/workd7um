<script setup>
import { computed, ref } from 'vue'
import { useSkyStore } from '@/store/sky'
const store = useSkyStore()
const emit = defineEmits(['close'])
const slotIco = { '引擎': '🔩', '翼板': '🦅', '氮气': '💨', '龙骨': '⛓️', '护甲': '🛡️' }
const statName = { speed: '速度', turn: '转向', acc: '加速', dur: '耐久' }
const perfList = () => [
  ['speed', '速度'], ['turn', '转向'], ['acc', '加速'], ['dur', '耐久']
].map(([k, l]) => ({ k, l, v: store.airship[k] || 0 }))
// 已持有数量按服务端商品配置比对（名称/槽位/加成项/数值/价格），下单只传 id
const ownedCount = it => store.upgrades.filter(u =>
  u.name === it.name && u.slot === it.slot && u.stat === it.stat && u.bonus === it.bonus && u.price === it.price).length
async function buy(it) {
  const r = await store.shop(it.id)
  if (r?.ok) store.tip(r.msg || '购买成功')
}

/* ---------- 飞艇租赁 ---------- */
const rental = computed(() => store.rental)
// 归还结算预览：按当前累计磨损估算（最终以归还时服务端结算为准）
const wearFeeNow = computed(() => rental.value ? rental.value.wear_total * rental.value.wear_rate : 0)
const refundNow = computed(() => rental.value ? Math.max(0, rental.value.deposit - wearFeeNow.value) : 0)
const renting = ref(false)
async function rent(it) {
  if (renting.value) return
  renting.value = true
  const r = await store.rentShip(it.id)
  if (r?.ok) store.tip(r.msg)
  renting.value = false
}
const returning = ref(false)
async function returnShip() {
  if (returning.value) return
  returning.value = true
  await store.returnShip()
  returning.value = false
}

/* ---------- 赛事排班：下一站出赛的机师 / 技工 / 飞艇（开赛时快照进比赛记录） ---------- */
const lineup = computed(() => store.lineup)
const savingLineup = ref(false)
async function setLineup(patch) {
  if (savingLineup.value) return
  savingLineup.value = true
  const r = await store.setLineup(patch)
  if (r?.ok) store.tip(r.msg || '排班已更新')
  savingLineup.value = false
}
const setPilot = e => setLineup({ pilotId: e.target.value === '' ? null : Number(e.target.value) })
const setMech = e => setLineup({ mechanicId: e.target.value === '' ? null : Number(e.target.value) })
const setShip = m => setLineup({ shipMode: m })
// 下一站实际出赛阵容一句话（服务端解析结果，含自动回落标记）
const lineupNext = computed(() => {
  const r = lineup.value?.resolved
  if (!r) return ''
  const p = r.pilot ? r.pilot.name + (r.pilot.auto ? '（自动）' : '') : '无机师'
  const m = r.mech ? r.mech.name + (r.mech.auto ? '（自动）' : '') : '无技工'
  return `${p} · ${m} · ${r.ship?.name || '自有艇'}`
})
</script>

<template>
  <div class="drawer-mask" @click.self="emit('close')">
    <aside class="drawer">
      <header class="d-h">
        <div><h3>✈️ 机库 Hangar</h3><div class="d-sub">改装你的飞艇，招募机师技工</div></div>
        <button class="d-x" @click="emit('close')">✕</button>
      </header>

      <div class="d-body">
        <!-- 飞艇主展示 -->
        <div class="airship-card">
          <div class="air-top">
            <div class="air-icon">🛸</div>
            <div>
              <b>{{ store.airship.name }}</b>
              <div class="air-tag tag" :class="store.airship.rental ? 'rose' : 'b'">
                {{ store.airship.rental ? `租赁中 · 剩 ${store.airship.rental.racesLeft} 场` : '主力飞艇' }}
              </div>
            </div>
            <div class="air-health">
              <div class="ah-label">部件健康 <span class="mono" :class="{ low: store.airship.parts_dur < 40 }">{{ store.airship.parts_dur }}%</span></div>
              <div class="hbar"><i :style="{ width: store.airship.parts_dur + '%', background: store.airship.parts_dur < 40 ? 'linear-gradient(90deg,var(--rose),var(--gold2))' : 'linear-gradient(90deg,var(--mint),var(--sky))' }"></i></div>
            </div>
          </div>
          <div class="perf-grid">
            <div v-for="p in perfList()" :key="p.k" class="perf">
              <span class="pl">{{ p.l }}</span>
              <div class="hbar"><i :style="{ width: Math.min(100, p.v) + '%' }"></i></div>
              <b class="mono">{{ p.v }}</b>
            </div>
          </div>
          <button class="btn mint w-full" :disabled="!!store.airship.rental" @click="store.maintain()">
            {{ store.airship.rental ? '🛟 租约艇由出租方整备' : '🔧 维护部件' }}
          </button>
        </div>

        <!-- 赛事排班：安排下一站出赛的机师/技工/飞艇，开赛瞬间快照进比赛记录 -->
        <section>
          <div class="sec-h">
            <b>🗓️ 赛事排班</b><span class="d-sub">下一站出赛阵容 · 开赛时快照</span>
          </div>
          <div class="rent-card">
            <div class="lu-row">
              <span class="lu-label">🧑‍✈️ 机师</span>
              <select :value="lineup?.pilotId ?? ''" :disabled="savingLineup" @change="setPilot">
                <option value="">自动 · 最强机师</option>
                <option v-for="p in store.state?.pilots || []" :key="p.id" :value="p.id">
                  {{ p.name }}（技巧{{ p.skill }} · 胆识{{ p.courage }}）
                </option>
              </select>
            </div>
            <div class="lu-row">
              <span class="lu-label">🔧 技工</span>
              <select :value="lineup?.mechanicId ?? ''" :disabled="savingLineup" @change="setMech">
                <option value="">自动 · 最强技工</option>
                <option v-for="m in store.state?.mechanics || []" :key="m.id" :value="m.id">
                  {{ m.name }}（技能{{ m.skill }}）
                </option>
              </select>
            </div>
            <div class="lu-row">
              <span class="lu-label">🛸 出赛飞艇</span>
              <div class="lu-modes">
                <button class="btn sm" :class="lineup?.shipMode === 'auto' ? 'primary' : 'ghost'"
                  :disabled="savingLineup" @click="setShip('auto')">自动</button>
                <button class="btn sm" :class="lineup?.shipMode === 'own' ? 'primary' : 'ghost'"
                  :disabled="savingLineup" @click="setShip('own')">自有艇</button>
                <button class="btn sm" :class="lineup?.shipMode === 'rental' ? 'primary' : 'ghost'"
                  :disabled="savingLineup" @click="setShip('rental')">租赁艇</button>
              </div>
            </div>
            <div class="lu-next">下一站：{{ lineupNext }}</div>
            <div v-if="lineup?.rentalMissing" class="lu-warn">
              ⚠️ 排班指定租赁艇出赛，但当前没有在履租约，签约后方可开赛
            </div>
          </div>
        </section>

        <!-- 飞艇租赁：签约扣押金+租金，比赛磨损记入租约，归还时按磨损结算退款 -->
        <section>
          <div class="sec-h">
            <b>🛟 飞艇租赁</b><span class="d-sub">押金+租金签约 · 归还按磨损结算</span>
          </div>

          <!-- 当前租约：履行状态与归还结算预览 -->
          <div v-if="rental" class="rent-card active">
            <div class="rent-top">
              <b>{{ rental.name }}</b>
              <span class="tag rose">租约履行中</span>
            </div>
            <div class="rent-rows">
              <div class="rent-row"><span>剩余场次</span><b class="mono">{{ rental.max_races - rental.races_used }} / {{ rental.max_races }}</b></div>
              <div class="rent-row"><span>部件健康</span><b class="mono" :class="{ low: rental.parts_dur < 40 }">{{ rental.parts_dur }}%</b></div>
              <div class="rent-row"><span>累计磨损</span><b class="mono" style="color:var(--rose)">{{ rental.wear_total }} 点</b></div>
              <div class="rent-row"><span>磨损费预估</span><b class="mono">¥{{ wearFeeNow.toLocaleString() }}</b></div>
              <div class="rent-row"><span>预计退还押金</span><b class="mono" style="color:var(--mint)">¥{{ refundNow.toLocaleString() }}</b></div>
            </div>
            <button class="btn primary w-full" :disabled="returning" @click="returnShip">
              🔁 归还结算（押金 ¥{{ rental.deposit.toLocaleString() }} − 磨损费）
            </button>
            <div class="rent-hint">场次用完后需归还租艇才能继续参赛</div>
          </div>

          <!-- 租赁目录：性能/押金/租金/场次/费率均为服务端核定 -->
          <div v-else class="rent-list">
            <div v-for="it in store.rentalShop" :key="it.id" class="rent-card">
              <div class="rent-top">
                <b>{{ it.name }}</b>
                <span class="tag b">{{ it.maxRaces }} 场租约</span>
              </div>
              <div class="rent-perf">
                <span v-for="([k, l]) in [['speed','速度'],['turn','转向'],['acc','加速'],['dur','耐久']]" :key="k" class="rp">
                  {{ l }} <em class="mono">{{ it[k] }}</em>
                </span>
              </div>
              <div class="rent-rows">
                <div class="rent-row"><span>押金（归还时按磨损结算）</span><b class="mono">¥{{ it.deposit.toLocaleString() }}</b></div>
                <div class="rent-row"><span>租金（不退）</span><b class="mono">¥{{ it.rent.toLocaleString() }}</b></div>
                <div class="rent-row"><span>磨损费率</span><b class="mono">¥{{ it.wearRate }}/点</b></div>
              </div>
              <button class="btn sm primary w-full" :disabled="renting || store.team.money < it.deposit + it.rent" @click="rent(it)">
                签约 ¥{{ (it.deposit + it.rent).toLocaleString() }}
              </button>
            </div>
          </div>

          <!-- 最近归还结算记录 -->
          <div v-if="store.rentalHistory.length" class="rent-history">
            <div v-for="h in store.rentalHistory" :key="h.id" class="rent-his-row">
              <span>{{ h.name }}</span>
              <span class="mono">磨损费 ¥{{ h.wear_fee }} · 退 ¥{{ h.refund }}</span>
            </div>
          </div>
        </section>

        <!-- 改装件道具 -->
        <section>
          <div class="sec-h">
            <b>🧩 改装件</b><span class="d-sub">点击装备 / 卸下</span>
          </div>
          <div class="up-grid">
            <div v-for="u in store.upgrades" :key="u.id" class="up-card" :class="{ eq: u.equipped }">
              <div class="up-ico">{{ slotIco[u.slot] }}</div>
              <div class="up-name">{{ u.name }}</div>
              <div class="up-stat">+{{ u.bonus }} {{ statName[u.stat] }}</div>
              <button class="btn sm" :class="u.equipped ? 'ghost' : 'primary'" @click="u.equipped ? store.unequip(u.id) : store.equip(u.id)">
                {{ u.equipped ? '卸下' : '装备' }}
              </button>
            </div>
          </div>
        </section>

        <!-- 零件商店：价格与属性均来自服务端商品配置，点击即按 id 下单 -->
        <section>
          <div class="sec-h">
            <b>🛒 零件商店</b><span class="d-sub">标价与性能由工坊核定，童叟无欺</span>
          </div>
          <div class="up-grid">
            <div v-for="it in store.shop" :key="it.id" class="up-card">
              <div class="up-ico">{{ slotIco[it.slot] }}</div>
              <div class="up-name">{{ it.name }}</div>
              <div class="up-stat">+{{ it.bonus }} {{ statName[it.stat] }}</div>
              <button class="btn sm primary" :disabled="store.team.money < it.price" @click="buy(it)">
                ¥{{ it.price.toLocaleString() }}<template v-if="ownedCount(it)"> · 已购{{ ownedCount(it) }}</template>
              </button>
            </div>
          </div>
        </section>

        <!-- 机师 -->
        <section>
          <div class="sec-h">
            <b>🧑‍✈️ 机师</b>
            <button class="btn ghost sm" @click="store.hirePilot()">＋ 招募 ¥1500</button>
          </div>
          <div class="crew-list">
            <div v-for="p in store.state?.pilots || []" :key="p.id" class="crew-row">
              <div class="crew-ava" :style="{ background: 'linear-gradient(135deg,var(--gold2),var(--violet))' }">{{ p.name[0] }}</div>
              <div class="crew-m">
                <div class="cm-name">{{ p.name }}<span class="tag b sm-tag">技巧{{ p.skill }}</span><span v-if="store.lineup?.pilotId === p.id" class="tag o sm-tag">已排班</span></div>
                <div class="cm-sub">胆识 {{ p.courage }} · 经验 {{ p.exp }} · 心情 {{ p.mood }}</div>
              </div>
              <button class="btn ghost sm" @click="store.train(p.id)">🎓</button>
            </div>
          </div>
        </section>

        <!-- 技工 -->
        <section>
          <div class="sec-h">
            <b>🔧 技工</b>
            <button class="btn ghost sm" @click="store.hireMech()">＋ 招募 ¥1000</button>
          </div>
          <div class="crew-list">
            <div v-for="m in store.state?.mechanics || []" :key="m.id" class="crew-row">
              <div class="crew-ava" style="background:linear-gradient(135deg,var(--mint),var(--sky))">{{ m.name[0] }}</div>
              <div class="crew-m">
                <div class="cm-name">{{ m.name }}<span class="tag m sm-tag">技能{{ m.skill }}</span><span v-if="store.lineup?.mechanicId === m.id" class="tag o sm-tag">已排班</span></div>
                <div class="cm-sub">心情 {{ m.mood }}</div>
              </div>
            </div>
          </div>
        </section>
      </div>
    </aside>
  </div>
</template>