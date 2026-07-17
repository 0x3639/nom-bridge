<script setup lang="ts">
import {computed} from 'vue'
import {
  Badge,
  Button,
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from 'nom-ui'
import {formatAmount, formatCountdown, truncateAddress} from '@/core/composables/utils/formatters'
import {wrapRequestProgress, type PendingRedeemPhase} from '@/core/approval-ux'
import type {WrapRequestView} from '@/types'

const props = defineProps<{
  request: WrapRequestView
  pending?: PendingRedeemPhase
}>()

const emit = defineEmits<{
  redeem: [request: WrapRequestView]
  recheck: [request: WrapRequestView]
}>()

const progress = computed(() => wrapRequestProgress(props.request.status, props.pending))
const badgeLabel = computed(() =>
  props.request.status === 'waiting-delay'
    ? `Security delay · ${formatCountdown(props.request.remainingSeconds ?? 0)}`
    : progress.value.badge,
)

function redeem(): void {
  if (progress.value.actionable && !props.pending) emit('redeem', props.request)
}
</script>

<template>
  <Item variant="outline">
    <ItemContent>
      <ItemTitle>
        {{ formatAmount(props.request.amount, props.request.decimals) }} {{ props.request.symbol }}
        <Badge :variant="progress.actionable ? 'default' : 'secondary'">{{ badgeLabel }}</Badge>
      </ItemTitle>
      <ItemDescription class="space-y-1">
        <span class="block font-medium text-foreground">{{ progress.title }}</span>
        <span class="block">{{ progress.description }}</span>
        <span class="block">To {{ truncateAddress(props.request.toAddress) }}</span>
      </ItemDescription>
    </ItemContent>
    <ItemActions v-if="progress.action">
      <div class="flex flex-wrap justify-end gap-2">
        <Button
          v-if="pending === 'confirming'"
          type="button"
          size="sm"
          variant="outline"
          @click="emit('recheck', request)"
        >
          Recheck status
        </Button>
        <Button
          v-if="pending !== 'confirming'"
          type="button"
          size="sm"
          :disabled="!progress.actionable || Boolean(pending)"
          @click="redeem"
        >
          {{ progress.action }}
        </Button>
      </div>
    </ItemActions>
  </Item>
</template>
