<script setup lang="ts">
import {Button} from 'nom-ui'
import {useZenonWallet} from '@/core'

const {address, isConnecting, connect, disconnect} = useZenonWallet()

function truncate(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a
}
</script>

<template>
  <Button v-if="!address" :disabled="isConnecting" @click="connect().catch(() => {})">
    {{ isConnecting ? 'Connecting…' : 'Connect Zenon' }}
  </Button>
  <Button v-else variant="outline" @click="disconnect().catch(() => {})">
    <span class="mr-2 inline-block w-2 h-2 rounded-full bg-primary" />{{ truncate(address) }} · Disconnect
  </Button>
  <p v-if="!address && isConnecting" class="mt-1 text-xs text-muted-foreground">
    Approve in Syrius — if nothing opens, copy the link from the QR screen and paste it into Syrius's WalletConnect tab.
  </p>
</template>
