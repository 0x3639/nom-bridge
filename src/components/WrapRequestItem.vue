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
import type {WrapRequestView} from '@/types'

const props = defineProps<{
  request: WrapRequestView
}>()

const emit = defineEmits<{
  redeem: [request: WrapRequestView]
}>()

type BadgeVariant = 'default' | 'secondary' | 'outline'

const badge = computed<{variant: BadgeVariant; label: string}>(() => {
  switch (props.request.status) {
    case 'signing':
      return {variant: 'secondary', label: 'Signing'}
    case 'redeemable':
      return {variant: 'default', label: 'Redeem'}
    case 'waiting-delay':
      return {variant: 'outline', label: formatCountdown(props.request.remainingSeconds ?? 0)}
    case 'redeemable-2':
      return {variant: 'default', label: 'Redeem (2/2)'}
    case 'redeemed':
      return {variant: 'secondary', label: 'Redeemed'}
  }
})

const canRedeem = computed(
  () => props.request.status === 'redeemable' || props.request.status === 'redeemable-2',
)
</script>

<template>
  <Item variant="outline">
    <ItemContent>
      <ItemTitle>
        {{ formatAmount(props.request.amount, props.request.decimals) }} {{ props.request.symbol }}
        <Badge :variant="badge.variant">{{ badge.label }}</Badge>
      </ItemTitle>
      <ItemDescription>To {{ truncateAddress(props.request.toAddress) }}</ItemDescription>
    </ItemContent>
    <ItemActions>
      <Button
        type="button"
        size="sm"
        :disabled="!canRedeem"
        @click="emit('redeem', props.request)"
      >
        Redeem
      </Button>
    </ItemActions>
  </Item>
</template>
