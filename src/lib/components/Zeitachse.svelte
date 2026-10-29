<script lang="ts">
	import { lage, type Tageslage, type Tagesspalte } from '$lib/board/anzeige';
	import { formatiereTag } from '$lib/board/zeit';
	import { m } from '$lib/paraglide/messages.js';
	import { getLocale } from '$lib/paraglide/runtime';

	/**
	 * „Erwartet vs. eingetroffen" über sieben Tage (SPEC §9).
	 *
	 * Wie die Ampel spricht auch die Achse nicht nur über Farbe: jede Lage hat ihre eigene Form, und
	 * jede Spalte trägt ihren Klartext als `title` und als Beschriftung für Screenreader. Gerechnet
	 * wird nichts hier — die Spalten kommen fertig aus `board/zeitachse.ts`.
	 */
	let { spalten }: { spalten: Tagesspalte[] } = $props();

	const TEXT: Record<Tageslage, () => string> = {
		ok: m.day_ok,
		fehler: m.day_error,
		unklar: m.day_unclear,
		verfehlt: m.day_missed,
		erwartet: m.day_expected,
		pausiert: m.day_paused,
		ausnahmetag: m.day_exception,
		unbewertet: m.day_unjudged,
		leer: m.day_empty
	};

	const MARKE: Record<Tageslage, string> = {
		ok: 'size-3 rounded-full bg-emerald-400',
		fehler: 'size-3 rotate-45 bg-rose-400',
		unklar: 'size-3 rounded-full bg-amber-400',
		verfehlt: 'size-3 rotate-45 border-2 border-rose-400',
		erwartet: 'size-3 rounded-full border border-dashed border-slate-500',
		pausiert: 'h-1 w-3 rounded-xs bg-slate-400',
		ausnahmetag: 'h-1 w-3 rounded-xs bg-slate-700',
		unbewertet: 'size-1 rounded-full bg-slate-700',
		leer: 'size-1 rounded-full bg-slate-800'
	};

	const locale = $derived(getLocale());
</script>

<ol class="flex gap-1">
	{#each spalten as spalte (spalte.datum)}
		{@const zustand = lage(spalte)}
		{@const tag = formatiereTag(spalte.datum, locale)}
		<li
			class="flex flex-1 flex-col items-center gap-1.5 rounded border border-slate-800 bg-slate-950/40 px-1 py-2"
			title="{tag} — {TEXT[zustand]()}"
		>
			<span class="text-[0.65rem] text-slate-500">{tag}</span>
			<span class="flex h-3 items-center justify-center">
				<span class={MARKE[zustand]} aria-hidden="true"></span>
			</span>
			<span class="sr-only">{tag} — {TEXT[zustand]()}</span>
			<span class="text-[0.65rem] text-slate-500 tabular-nums">
				{#if spalte.erwartet > 0}
					{spalte.eingetroffen}/{spalte.erwartet}
				{:else if spalte.eingetroffen > 0}
					{spalte.eingetroffen}
				{:else}
					&nbsp;
				{/if}
			</span>
		</li>
	{/each}
</ol>
