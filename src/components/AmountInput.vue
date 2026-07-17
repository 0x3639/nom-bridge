<script setup lang="ts">
import {computed} from 'vue'
import {addNumberDecimals} from 'znn-typescript-sdk'
import {
  Field,
  FieldDescription,
  FieldLabel,
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from 'nom-ui'
import {FEE_DENOMINATOR} from '@/config'
import {formatAmount} from '@/core/composables/utils/formatters'
import {parseAmount} from '@/core/amount'

const props = defineProps<{
  modelValue: string
  decimals: number
  balance?: bigint
  feePercentage: number
  minAmount: bigint
  disabled?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

function onInput(e: Event): void {
  emit('update:modelValue', (e.target as HTMLInputElement).value)
}

function setMax(): void {
  if (props.balance === undefined) return
  emit('update:modelValue', addNumberDecimals(props.balance.toString(), props.decimals))
}

const parsedBase = computed<bigint>(() => {
  if (!props.modelValue) return 0n
  try {
    return parseAmount(props.modelValue, props.decimals)
  } catch {
    return 0n
  }
})

const feePreview = computed<bigint>(
  () => (parsedBase.value * BigInt(props.feePercentage)) / FEE_DENOMINATOR,
)
</script>

<template>
  <Field>
    <FieldLabel for="wrap-amount">Amount</FieldLabel>
    <InputGroup>
      <InputGroupInput
        id="wrap-amount"
        :value="props.modelValue"
        type="text"
        step="any"
        placeholder="0.00"
        :disabled="props.disabled"
        class="font-mono"
        autocomplete="off"
        @input="onInput"
      />
      <InputGroupAddon align="inline-end">
        <InputGroupButton
          v-if="props.balance !== undefined"
          type="button"
          variant="ghost"
          size="xs"
          :disabled="props.disabled"
          @click="setMax"
        >
          MAX
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
    <FieldDescription>
      Estimated fee: {{ formatAmount(feePreview, props.decimals) }} (indicative; the
      authoritative fee is read back from the wrap request).
      Min amount: {{ formatAmount(props.minAmount, props.decimals) }}.
    </FieldDescription>
  </Field>
</template>
