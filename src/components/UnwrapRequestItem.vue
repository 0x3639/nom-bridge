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
import type {UnwrapRequestView} from '@/types'

const props = defineProps<{
  request: UnwrapRequestView
}>()

const emit = defineEmits<{
  redeem: [request: UnwrapRequestView]
}>()

type BadgeVariant = 'default' | 'secondary' | 'outline'

const badge = computed<{variant: BadgeVariant; label: string}>(() => {
  switch (props.request.status) {
    case 'pending':
      return {variant: 'secondary', label: 'Pending'}
    case 'signing':
      return {variant: 'secondary', label: 'Signing'}
    case 'waiting':
      return {variant: 'outline', label: formatCountdown(props.request.remainingSeconds ?? 0)}
    case 'redeemable':
      return {variant: 'default', label: 'Redeem'}
    case 'redeemed':
      return {variant: 'secondary', label: 'Redeemed'}
    case 'revoked':
      return {variant: 'secondary', label: 'Revoked'}
    case 'broken':
      return {variant: 'secondary', label: 'Broken'}
  }
})

const canRedeem = computed(() => props.request.status === 'redeemable')
</script>

<template>
  <Item variant="outline">
    <ItemContent>
      <ItemTitle>
        {{ formatAmount(props.request.amount, 8) }}
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
