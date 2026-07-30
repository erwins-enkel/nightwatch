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

	let dialog = $state<HTMLDialogElement | null>(null);

	/**
	 * Serverseitig steht die Schublade als gewöhnliches `open` da, damit sie ohne JavaScript
	 * sichtbar und über ihren Schließen-Link bedienbar bleibt. Sobald JavaScript läuft, wird sie
	 * zur echten Modal-Schublade.
	 *
	 * `showModal()` statt eines selbstgebauten Fokus-Käfigs: die Plattform legt den Fokus hinein,
	 * hält ihn dort, macht den Rest des Dokuments **inert** — Bedienelemente im Hintergrund sind
	 * damit nicht mehr per Tab erreichbar — und meldet Screenreadern die Modal-Semantik
	 * (`aria-modal`) selbst. Ein handgeschriebener Käfig könnte das nur nachahmen, und schlechter:
	 * er müsste jede fokussierbare Sorte kennen, die HTML kennt.
	 */
	$effect(() => {
		if (dialog === null || dialog.matches(':modal')) return;
		// Nicht-modal geöffnet (so kam sie vom Server) — `showModal()` würde daran scheitern.
		dialog.close();
		dialog.showModal();
	});

	/** Escape: nicht bloß zumachen — der Zustand steht in der URL, also wird dorthin navigiert. */
	function beiAbbruch(event: Event) {
		event.preventDefault();
		goto(schliessenHref);
	}

	/**
	 * Klick auf den Backdrop. Der trifft das `dialog` selbst; alles Inhaltliche liegt im `div`
	 * darin, das die Schublade vollständig ausfüllt.
	 */
	function beiKlick(event: MouseEvent) {
		if (event.target === dialog) goto(schliessenHref);
	}
</script>

<dialog
	bind:this={dialog}
	open
	aria-label={titel}
	class="fixed inset-y-0 right-0 left-auto m-0 h-full max-h-none w-full max-w-xl border-l border-slate-800 bg-slate-900 p-0 text-slate-200 shadow-2xl backdrop:bg-slate-950/70"
	oncancel={beiAbbruch}
	onclick={beiKlick}
>
	<div class="flex h-full flex-col gap-5 overflow-y-auto px-6 py-5">
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
</dialog>
