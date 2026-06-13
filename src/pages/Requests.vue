<script setup lang="ts">
import {Card, CardContent} from 'nom-ui'
import {History} from 'lucide-vue-next'
</script>

<template>
  <Card>
    <CardContent class="flex flex-col items-center gap-3 py-12 text-center">
      <span class="grid h-10 w-10 place-items-center rounded-full border bg-card/40">
        <History class="h-5 w-5 text-muted-foreground" />
      </span>
      <p class="font-mono text-sm text-muted-foreground">Request history — coming soon</p>
    </CardContent>
  </Card>
</template>
