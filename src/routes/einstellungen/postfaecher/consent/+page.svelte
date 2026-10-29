<script lang="ts">
	import { CheckCircle2, XCircle } from '@lucide/svelte';
	import { resolve } from '$app/paths';
	import { m } from '$lib/paraglide/messages.js';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head><title>{m.consent_title()} · Nightwatch</title></svelte:head>

<main class="mx-auto flex min-h-screen max-w-xl flex-col gap-6 px-6 py-16">
	<h1 class="flex items-center gap-3 text-2xl font-semibold text-slate-50">
		{#if data.erteilt}
			<CheckCircle2 class="size-6 text-emerald-400" aria-hidden="true" />
		{:else}
			<XCircle class="size-6 text-rose-400" aria-hidden="true" />
		{/if}
		{m.consent_title()}
	</h1>

	<p class="text-slate-300">
		{data.erteilt ? m.consent_granted() : m.consent_failed()}
	</p>

	{#if data.fehler}
		<!-- Der Fehlercode von Entra ID, roh — er ist die einzige belastbare Spur für den Support. -->
		<p class="font-mono text-sm break-all text-slate-500">{data.fehler}</p>
	{/if}

	<a
		href={resolve('/einstellungen/postfaecher')}
		class="w-fit text-sm text-emerald-400 underline underline-offset-4"
	>
		{m.consent_back()}
	</a>
</main>
