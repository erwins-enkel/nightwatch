<script lang="ts">
	import type { Snippet } from 'svelte';
	import { X } from '@lucide/svelte';
	import { goto } from '$app/navigation';
	import type { ResolvedPathname } from '$app/types';
	import { m } from '$lib/paraglide/messages.js';

	/**
	 * Die Schublade des Kundenboards (SPEC §9).
	 *
	 * Ihr Zustand steht in der URL, nicht im Client — deshalb ist das Schließen ein **Link** und
	 * kein Knopf: die Schublade lässt sich verlinken, teilen und ohne JavaScript wieder zumachen.
	 * Escape ist die Zugabe für die, die eine Tastatur benutzen.
	 */
	let {
		titel,
		schliessenHref,
		kopf,
		children
	}: {
		titel: string;
		/** Schon durch `resolve()` gegangen — der Basispfad steckt drin. */
		schliessenHref: ResolvedPathname;
		kopf?: Snippet;
		children: Snippet;
	} = $props();

	function beiTaste(event: KeyboardEvent) {
		if (event.key === 'Escape') goto(schliessenHref);
	}
</script>

<svelte:window onkeydown={beiTaste} />

<!--
	Der Vorhang ist selbst der Schließen-Link und deckt die Seite vollständig ab; ein `aria-modal`
	behauptet diese Komponente bewusst nicht, weil sie den Fokus nicht einfängt — ein Versprechen,
	das sie nicht hält, wäre für Screenreader schlechter als keines.
-->
<a
	href={schliessenHref}
	class="fixed inset-0 z-40 bg-slate-950/70 backdrop-blur-[1px]"
	aria-label={m.board_close()}
></a>

<div
	class="fixed inset-y-0 right-0 z-50 flex w-full max-w-xl flex-col gap-5 overflow-y-auto border-l border-slate-800 bg-slate-900 px-6 py-5 shadow-2xl"
	role="dialog"
	aria-label={titel}
>
	<header class="flex items-start justify-between gap-4">
		<div class="flex min-w-0 flex-col gap-1">
			{#if kopf}{@render kopf()}{/if}
			<h2 class="text-lg font-semibold break-words text-slate-50">{titel}</h2>
		</div>
		<a
			href={schliessenHref}
			class="shrink-0 rounded border border-slate-700 p-1.5 text-slate-400 hover:border-slate-500 hover:text-slate-200"
			aria-label={m.board_close()}
		>
			<X class="size-4" aria-hidden="true" />
		</a>
	</header>

	{@render children()}
</div>
