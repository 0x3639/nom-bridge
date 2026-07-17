<script setup lang="ts">
import {onMounted} from 'vue'
import {Heading, Toaster, useTheme} from 'nom-ui'
import {SunIcon, MoonIcon} from 'lucide-vue-next'
import ConnectZenonButton from '@/components/ConnectZenonButton.vue'
import ConnectEvmButton from '@/components/ConnectEvmButton.vue'

const {initTheme, toggleTheme, theme} = useTheme()

onMounted(() => {
  initTheme()
})
</script>

<template>
  <div class="relative min-h-screen overflow-x-hidden">
    <Toaster />
    <div
      class="pointer-events-none fixed -top-40 left-1/2 -z-10 h-72 w-[40rem] -translate-x-1/2 rounded-full bg-zenon-green/15 blur-[110px]"
      aria-hidden="true"
    />
    <header class="sticky top-0 z-20 border-b p-4 bg-card/60 backdrop-blur">
      <div class="container mx-auto max-w-3xl flex justify-between items-center">
        <Heading as="h1" class="flex items-center gap-2 text-xl font-semibold tracking-tight">
          <span class="inline-block h-3 w-3 rotate-45 rounded-[2px] bg-zenon-green" aria-hidden="true" />
          NoM <span class="text-primary">Bridge</span>
        </Heading>
        <div class="flex items-center gap-2">
          <button
            type="button"
            class="text-muted-foreground hover:text-foreground transition-colors p-2"
            title="Toggle theme"
            @click="toggleTheme()"
          >
            <SunIcon v-if="theme === 'dark'" class="w-5 h-5" />
            <MoonIcon v-else class="w-5 h-5" />
          </button>
          <ConnectZenonButton />
          <ConnectEvmButton />
        </div>
      </div>
    </header>
    <nav class="container mx-auto flex max-w-md gap-4 px-6 pt-4 text-sm">
      <router-link to="/" class="text-muted-foreground hover:text-foreground" active-class="text-foreground font-medium">
        Bridge
      </router-link>
      <router-link to="/requests" class="text-muted-foreground hover:text-foreground" active-class="text-foreground font-medium">
        History
      </router-link>
    </nav>
    <main class="container mx-auto max-w-md p-6">
      <router-view />
    </main>
  </div>
</template>
