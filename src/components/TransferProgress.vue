<script setup lang="ts">
import {computed} from 'vue'
import {Badge, Card, CardContent, ItemGroup} from 'nom-ui'
import WrapRequestItem from './WrapRequestItem.vue'
import UnwrapRequestItem from './UnwrapRequestItem.vue'
import {unwrapRequestProgress, wrapRequestProgress, type PendingRedeemPhase} from '@/core/approval-ux'
import type {UnwrapRequestView, WrapRequestView} from '@/types'

const props = defineProps<{
  wrapRequests: WrapRequestView[]
  unwrapRequests: UnwrapRequestView[]
  pendingWrapRedeems: Record<string, PendingRedeemPhase | undefined>
  pendingUnwrapRedeems: Record<string, PendingRedeemPhase | undefined>
}>()

const emit = defineEmits<{
  redeemWrap: [request: WrapRequestView]
  redeemUnwrap: [request: UnwrapRequestView]
  recheckWrap: [request: WrapRequestView]
  recheckUnwrap: [request: UnwrapRequestView]
}>()

const actionableCount = computed(() =>
  props.wrapRequests.filter(request =>
    wrapRequestProgress(request.status, props.pendingWrapRedeems[request.id]).actionable,
  ).length +
  props.unwrapRequests.filter(request =>
    unwrapRequestProgress(
      request.status,
      props.pendingUnwrapRedeems[request.id],
      request.totalApprovals,
    ).actionable,
  ).length,
)
</script>

<template>
  <Card
    v-if="wrapRequests.length || unwrapRequests.length"
    class="rounded-[18px] border-border/80 bg-card shadow-xl shadow-black/10"
    aria-live="polite"
  >
    <CardContent class="space-y-4 !p-5">
      <div class="flex items-center justify-between gap-3">
        <div>
          <p class="text-sm font-semibold">Transfer progress</p>
          <p class="mt-1 text-xs text-muted-foreground">Follow every remaining wallet action here.</p>
        </div>
        <Badge :variant="actionableCount ? 'default' : 'secondary'">
          {{ actionableCount ? `${actionableCount} action${actionableCount === 1 ? '' : 's'} required` : 'In progress' }}
        </Badge>
      </div>

      <ItemGroup v-if="wrapRequests.length" class="gap-2">
        <WrapRequestItem
          v-for="request in wrapRequests"
          :key="request.id"
          :request="request"
          :pending="pendingWrapRedeems[request.id]"
          @redeem="emit('redeemWrap', $event)"
          @recheck="emit('recheckWrap', $event)"
        />
      </ItemGroup>

      <ItemGroup v-if="unwrapRequests.length" class="gap-2">
        <UnwrapRequestItem
          v-for="request in unwrapRequests"
          :key="request.id"
          :request="request"
          :pending="pendingUnwrapRedeems[request.id]"
          @redeem="emit('redeemUnwrap', $event)"
          @recheck="emit('recheckUnwrap', $event)"
        />
      </ItemGroup>
    </CardContent>
  </Card>
  <p v-else class="text-sm text-muted-foreground">No active requests.</p>
</template>
