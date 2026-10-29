<script lang="ts">
	import type { AnzeigeZustand } from '$lib/board/anzeige';
	import { m } from '$lib/paraglide/messages.js';

	/**
	 * Die Ampel eines Monitors oder eines Kunden.
	 *
	 * Farbe trägt hier nie allein: jeder Zustand hat zusätzlich eine eigene **Form** — Kreis, Raute,
	 * Balken, gestrichelter Ring — und immer seinen Text daneben. Ein Board, das nur über Rot und
	 * Grün spricht, ist für rund jeden zwölften Mann nicht lesbar, und dieses Board ist das erste,
	 * worauf morgens jemand schaut.
	 */
	let {
		zustand,
		anzahl,
		klein = false
	}: { zustand: AnzeigeZustand; anzahl?: number; klein?: boolean } = $props();

	const TEXT: Record<AnzeigeZustand, () => string> = {
		gesund: m.state_healthy,
		gestoert: m.state_disturbed,
		pausiert: m.state_paused,
		entwurf: m.state_draft
	};

	const FORM: Record<AnzeigeZustand, string> = {
		gesund: 'rounded-full bg-emerald-400',
		gestoert: 'rotate-45 bg-rose-400',
		pausiert: 'rounded-xs bg-slate-400',
		entwurf: 'rounded-full border border-dashed border-amber-400'
	};

	const FARBE: Record<AnzeigeZustand, string> = {
		gesund: 'text-emerald-300',
		gestoert: 'text-rose-300',
		pausiert: 'text-slate-400',
		entwurf: 'text-amber-300'
	};
</script>

<span
	class="inline-flex items-center gap-1.5 font-medium whitespace-nowrap {klein
		? 'text-xs'
		: 'text-sm'} {FARBE[zustand]}"
>
	<span class="size-2.5 shrink-0 {FORM[zustand]}" aria-hidden="true"></span>
	{#if anzahl !== undefined}{anzahl}&nbsp;{/if}{TEXT[zustand]()}
</span>
