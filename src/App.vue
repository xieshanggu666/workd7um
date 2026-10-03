<script setup>
import { ref } from 'vue'
import { useSkyStore } from '@/store/sky'
import MainScene from '@/components/MainScene.vue'
import RaceAnim from '@/components/RaceAnim.vue'
import HangarDrawer from '@/components/HangarDrawer.vue'
import TrophyDrawer from '@/components/TrophyDrawer.vue'
import InsuranceDrawer from '@/components/InsuranceDrawer.vue'

const store = useSkyStore()
store.init()

const drawer = ref('')            // '' | 'hangar' | 'trophy' | 'insurance'
// 当前观看的比赛：{ race, mode: 'live' | 'replay' }，三者（动画/实时排名/结算卡）共用同一份记录
const viewing = ref(null)

// live：开赛或中断续看；replay：历史回放（绝不再次结算）
function openRace(race, mode = 'live') { viewing.value = { race, mode } }
async function goBack() {
  viewing.value = null
  await store.refresh()
}
function openHangar() { drawer.value = drawer.value === 'hangar' ? '' : 'hangar' }
function openTrophy() { drawer.value = drawer.value === 'trophy' ? '' : 'trophy' }
function openInsurance() { drawer.value = drawer.value === 'insurance' ? '' : 'insurance' }
// 结算卡「去理赔」：关掉比赛镜头并直接打开保险抽屉
async function gotoClaim() {
  viewing.value = null
  await store.refresh()
  drawer.value = 'insurance'
}
</script>

<template>
  <div class="game">
    <div v-if="store.toast" class="toast">✨ {{ store.toast }}</div>

    <!-- 顶栏状态条 -->
    <header class="topbar">
      <div class="brand">
        <div class="logo">🛸</div>
        <div class="t">天空之城<small>AIRWAVE RACING · S{{ store.team.season }}</small></div>
      </div>
      <div class="stat-chips">
        <span class="chipx"><b class="ic">🪙</b> ¥{{ store.team.money?.toLocaleString() }}</span>
        <span class="chipx"><b class="ic">✨</b> 声望 {{ store.team.rep }}</span>
        <span class="chipx gold"><b class="ic">🏅</b> 积分 {{ store.team.season_pts }}</span>
        <span class="chipx"><b class="ic">🗼</b> {{ store.state ? store.state.seasonDone + ' / ' + store.state.seasonTotal + ' 站' : '' }}</span>
      </div>
    </header>

    <!-- 主游戏场景：云海浮岛航线图 -->
    <MainScene class="scene" @view="openRace" />

    <!-- 竞速镜头：live（开赛/续看）或 replay（历史回放） -->
    <RaceAnim v-if="viewing" :race="viewing.race" :mode="viewing.mode" @back="goBack" @claim="gotoClaim" />

    <!-- 右下操作钮 -->
    <div class="fab-col">
      <button class="fab" :class="{ on: drawer === 'trophy' }" @click="openTrophy">🏆<span>赛季之巅</span></button>
      <button class="fab" :class="{ on: drawer === 'insurance' }" @click="openInsurance">🛡️<span>赛事保险</span></button>
      <button class="fab" :class="{ on: drawer === 'hangar' }" @click="openHangar">✈️<span>机库</span></button>
    </div>

    <!-- 抽屉 -->
    <transition name="slide">
      <div v-if="drawer === 'hangar'"><HangarDrawer @close="drawer = ''" /></div>
    </transition>
    <transition name="slide">
      <div v-if="drawer === 'trophy'"><TrophyDrawer @close="drawer = ''" @replay="r => openRace(r, 'replay')" /></div>
    </transition>
    <transition name="slide">
      <div v-if="drawer === 'insurance'"><InsuranceDrawer @close="drawer = ''" /></div>
    </transition>
  </div>
</template>
