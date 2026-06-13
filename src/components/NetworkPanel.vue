<script setup lang="ts">
// Presentational only: one side of the bridge (a network + its token
// representation). Zenon-accented panels carry the momentum pulse — the
// network produces a momentum roughly every `momentumTime` seconds.
defineProps<{
  role: string // 'From' | 'To'
  network: string // 'Zenon' | 'Ethereum'
  symbol: string // 'ZNN' | 'wZNN'
  accent: 'zenon' | 'evm'
  pulse?: boolean
  momentumTime?: number
}>()

// Literal class names so Tailwind's scanner picks them up (no dynamic concat).
const accentClasses = {
  zenon: {dot: 'bg-zenon-green', text: 'text-zenon-green', border: 'border-zenon-green/30'},
  evm: {dot: 'bg-zenon-blue', text: 'text-zenon-blue', border: 'border-zenon-blue/30'},
} as const
</script>

<template>
  <div class="rounded-lg border bg-card/40 p-3" :class="accentClasses[accent].border">
    <div class="mb-3 flex items-center justify-between">
      <div class="flex items-center gap-2">
        <span class="relative flex h-2.5 w-2.5">
          <span
            v-if="pulse"
            class="momentum-ring absolute inline-flex h-full w-full rounded-full"
            :class="accentClasses[accent].dot"
            :style="{'--momentum-duration': (momentumTime ?? 10) + 's'}"
          />
          <span
            class="relative inline-flex h-2.5 w-2.5 rounded-full"
            :class="accentClasses[accent].dot"
          />
        </span>
        <span class="font-mono text-sm font-medium" :class="accentClasses[accent].text">
          {{ network }}
        </span>
      </div>
      <div class="flex items-center gap-2">
        <span class="rounded border border-border/60 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
          {{ symbol }}
        </span>
        <span class="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
          {{ role }}
        </span>
      </div>
    </div>

    <slot />

    <p
      v-if="pulse"
      class="mt-3 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground"
    >
      momentum · ~{{ momentumTime ?? 10 }}s
    </p>
  </div>
</template>

<style scoped>
@keyframes momentum-ring {
  0% {
    transform: scale(1);
    opacity: 0.6;
  }
  75%,
  100% {
    transform: scale(2.4);
    opacity: 0;
  }
}
.momentum-ring {
  animation: momentum-ring var(--momentum-duration, 10s) cubic-bezier(0, 0, 0.2, 1) infinite;
}
@media (prefers-reduced-motion: reduce) {
  .momentum-ring {
    animation: none;
  }
}
</style>
