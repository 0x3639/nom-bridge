<script setup lang="ts">
import {ItemGroup} from 'nom-ui'
import WrapRequestItem from './WrapRequestItem.vue'
import type {WrapRequestView} from '@/types'

const props = defineProps<{
  requests: WrapRequestView[]
}>()

const emit = defineEmits<{
  redeem: [request: WrapRequestView]
}>()
</script>

<template>
  <ItemGroup v-if="props.requests.length" class="gap-2">
    <WrapRequestItem
      v-for="request in props.requests"
      :key="request.id"
      :request="request"
      @redeem="emit('redeem', $event)"
    />
  </ItemGroup>
  <p v-else class="text-sm text-muted-foreground">No active requests.</p>
</template>
