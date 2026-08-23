<script setup lang="ts">
import {ref, watch} from 'vue'
import QRCode from 'qrcode'
import {
  CopyButton,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from 'nom-ui'
import {useZenonWallet} from '@/core'

// In-app replacement for the deprecated @walletconnect/modal: shows the
// WalletConnect pairing URI as a QR code (scan from Syrius) and as copyable
// text (paste into Syrius → WalletConnect). Closing the dialog cancels the
// pending pairing; the service closes it on approval, rejection, or timeout.
const {pairingUri, cancelPairing} = useZenonWallet()
const qrDataUrl = ref<string | null>(null)
const qrError = ref<string | null>(null)

watch(
  pairingUri,
  async uri => {
    qrDataUrl.value = null
    qrError.value = null
    if (!uri) return
    try {
      const rendered = await QRCode.toDataURL(uri, {margin: 1, width: 256, errorCorrectionLevel: 'M'})
      // The uri may have changed (or closed) while rendering.
      if (pairingUri.value === uri) qrDataUrl.value = rendered
    } catch (e) {
      qrError.value = e instanceof Error ? e.message : 'Could not render QR code'
    }
  },
  {immediate: true},
)

function onOpenChange(open: boolean): void {
  if (!open) cancelPairing()
}
</script>

<template>
  <Dialog :open="pairingUri !== null" @update:open="onOpenChange">
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>Connect Syrius</DialogTitle>
        <DialogDescription>
          Scan this code from Syrius, or copy the pairing link and paste it into Syrius → WalletConnect.
          The code expires after five minutes.
        </DialogDescription>
      </DialogHeader>
      <div v-if="pairingUri" class="flex min-w-0 flex-col items-center gap-4">
        <div class="rounded-xl bg-white p-3" aria-live="polite">
          <img
            v-if="qrDataUrl"
            :src="qrDataUrl"
            alt="WalletConnect pairing QR code"
            width="256"
            height="256"
            class="block"
          />
          <div
            v-else
            class="flex h-64 w-64 items-center justify-center text-sm text-neutral-600"
          >
            {{ qrError ?? 'Rendering…' }}
          </div>
        </div>
        <div class="flex w-full min-w-0 items-center gap-2 rounded-md border bg-muted/40 px-3 py-2">
          <code class="min-w-0 flex-1 truncate font-mono text-xs" :title="pairingUri">{{ pairingUri }}</code>
          <CopyButton :value="pairingUri" aria-label="Copy pairing link" />
        </div>
        <p class="text-center text-xs text-muted-foreground">
          Waiting for approval in Syrius…
        </p>
      </div>
    </DialogContent>
  </Dialog>
</template>
