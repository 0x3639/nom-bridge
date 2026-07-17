<script setup lang="ts">
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from 'nom-ui'
import type {TokenPairView} from '@/types'

const props = defineProps<{
  modelValue: string | null
  pairs: TokenPairView[]
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

function onUpdate(value: unknown): void {
  if (typeof value === 'string') emit('update:modelValue', value)
}
</script>

<template>
  <Select :model-value="props.modelValue ?? undefined" @update:model-value="onUpdate">
    <SelectTrigger class="w-full">
      <SelectValue placeholder="Select a token" />
    </SelectTrigger>
    <SelectContent>
      <SelectItem v-for="pair in props.pairs" :key="pair.zts" :value="pair.zts">
        {{ pair.symbol }}
      </SelectItem>
    </SelectContent>
  </Select>
</template>
