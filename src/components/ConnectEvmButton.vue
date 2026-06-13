<script setup lang="ts">
import {Button} from 'nom-ui'
import {useEvmWallet} from '@/core'

const {account, isConnecting, connect, disconnect} = useEvmWallet()

function truncate(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a
}
</script>

<template>
  <Button v-if="!account" :disabled="isConnecting" @click="connect().catch(() => {})">
    {{ isConnecting ? 'Connecting…' : 'Connect MetaMask' }}
  </Button>
  <Button v-else variant="outline" @click="disconnect">
    <span class="mr-2 inline-block w-2 h-2 rounded-full bg-primary" />{{ truncate(account) }} · Disconnect
  </Button>
</template>
