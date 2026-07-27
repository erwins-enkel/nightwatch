<script lang="ts">
	import { Activity } from '@lucide/svelte';
	import { resolve } from '$app/paths';
	import LocaleSwitcher from '$lib/components/LocaleSwitcher.svelte';
	import { m } from '$lib/paraglide/messages.js';
</script>

<svelte:head><title>Nightwatch</title></svelte:head>

<main class="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 px-6 py-16">
	<header class="flex items-center justify-between gap-4">
		<h1 class="flex items-center gap-3 text-2xl font-semibold text-slate-50">
			<Activity class="size-7 text-emerald-400" aria-hidden="true" />
			Nightwatch
		</h1>
		<LocaleSwitcher />
	</header>

	<p class="text-lg text-slate-300">{m.tagline()}</p>
	<p class="text-sm text-slate-400">{m.scaffold_notice()}</p>

	<a href={resolve('/health')} class="text-sm text-emerald-400 underline underline-offset-4">
		{m.health_link()}
	</a>
</main>
