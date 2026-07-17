<script setup lang="ts">
import {onMounted, onUnmounted, watch} from 'vue'
import {Alert, AlertDescription, AlertTitle, Badge, Card, CardContent, CardHeader, CardTitle} from 'nom-ui'
import {config} from '@/config'
import {useBridge, useEvmWallet, useRequests, useZenonWallet} from '@/core'
import {formatAmount, truncateAddress} from '@/core/composables/utils/formatters'

const {tokenPairs, bridgeAddress, momentumTime, error: bridgeError, load} = useBridge()
const {account: evmAccount} = useEvmWallet()
const {address: zenonAddress} = useZenonWallet()
const {
  wrapRequests,
  unwrapRequests,
  isLoading,
  pollingError,
  startPolling,
  stopPolling,
  refreshForAccountChange,
} = useRequests()

watch([evmAccount, zenonAddress], () => {
  void refreshForAccountChange().catch(() => undefined)
})

onMounted(async () => {
  try {
    await load()
  } catch {
    return
  }
  startPolling(
    () => evmAccount.value,
    () => bridgeAddress.value,
    () => zenonAddress.value,
    () => momentumTime.value,
    () => tokenPairs.value,
  )
})

onUnmounted(stopPolling)
</script>

<template>
  <Card>
    <CardHeader>
      <CardTitle>Bridge history</CardTitle>
    </CardHeader>
    <CardContent class="space-y-5">
      <Alert v-if="pollingError" variant="destructive">
        <AlertTitle>History refresh failed</AlertTitle>
        <AlertDescription>{{ pollingError }}</AlertDescription>
      </Alert>
      <Alert v-else-if="bridgeError" variant="destructive">
        <AlertTitle>Bridge configuration unavailable</AlertTitle>
        <AlertDescription>{{ bridgeError }}</AlertDescription>
      </Alert>

      <p v-if="!evmAccount && !zenonAddress" class="text-sm text-muted-foreground">
        Connect a wallet to load its bridge history.
      </p>
      <p v-else-if="isLoading" class="text-sm text-muted-foreground">Loading history…</p>

      <section v-if="evmAccount" class="space-y-2">
        <h2 class="text-sm font-semibold">Zenon → Ethereum</h2>
        <a
          v-for="request in wrapRequests"
          :key="request.id"
          :href="config.zenonExplorerTxUrl + request.id"
          target="_blank"
          rel="noopener noreferrer"
          class="flex items-center justify-between gap-3 rounded-md border p-3 text-sm hover:border-primary/50"
        >
          <span>
            <span class="block font-mono">
              {{ formatAmount(request.amount, request.decimals) }} {{ request.symbol }}
            </span>
            <span class="text-xs text-muted-foreground">To {{ truncateAddress(request.toAddress) }}</span>
          </span>
          <Badge variant="secondary">{{ request.status }}</Badge>
        </a>
        <p v-if="!wrapRequests.length" class="text-sm text-muted-foreground">No wrap requests found.</p>
      </section>

      <section v-if="zenonAddress" class="space-y-2">
        <h2 class="text-sm font-semibold">Ethereum → Zenon</h2>
        <div
          v-for="request in unwrapRequests"
          :key="request.id"
          class="flex items-center justify-between gap-3 rounded-md border p-3 text-sm hover:border-primary/50"
        >
          <a
            :href="config.evmExplorerTxUrl + request.transactionHash"
            target="_blank"
            rel="noopener noreferrer"
            class="min-w-0 flex-1"
          >
            <span class="block font-mono">
              {{ formatAmount(request.amount, request.decimals) }} {{ request.symbol }}
            </span>
            <span class="text-xs text-muted-foreground">To {{ truncateAddress(request.toAddress) }}</span>
          </a>
          <div class="flex items-center gap-2">
            <Badge variant="secondary">{{ request.status }}</Badge>
          </div>
        </div>
        <p v-if="!unwrapRequests.length" class="text-sm text-muted-foreground">No unwrap requests found.</p>
      </section>
    </CardContent>
  </Card>
</template>
