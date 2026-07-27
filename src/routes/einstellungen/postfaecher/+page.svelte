<script lang="ts">
	import { AlertTriangle, CheckCircle2, Inbox, KeyRound, Trash2 } from '@lucide/svelte';
	import { enhance } from '$app/forms';
	import { m } from '$lib/paraglide/messages.js';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const fehler = $derived(form?.fehler ?? {});
	const eingaben = $derived(form?.eingaben);

	const FELD_FEHLER: Record<string, () => string> = {
		pflicht: m.error_required,
		adresse: m.error_address,
		bereich: m.error_interval,
		datum: m.error_date
	};

	function meldung(feld: string): string | undefined {
		const schluessel = fehler[feld];
		if (!schluessel) return undefined;
		if (feld === 'lernfensterTage' && schluessel === 'bereich') return m.error_learning_window();
		return FELD_FEHLER[schluessel]?.() ?? m.error_required();
	}

	/**
	 * Deliberately not `toLocaleString()`: this page is server-rendered and then hydrated, and the
	 * container's locale and time zone are not the browser's — the two would render different text
	 * for the same instant and the hydration would mismatch. UTC is also the honest unit for a
	 * monitoring timestamp; localising it belongs to the dashboard milestone.
	 */
	function zeitpunkt(wert: Date | string | null): string {
		if (!wert) return m.mailbox_never();
		return `${new Date(wert).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
	}

	const CREDENTIAL_TEXT = {
		ok: m.credential_ok,
		bald: m.credential_soon,
		abgelaufen: m.credential_expired,
		unbekannt: m.credential_unknown
	};

	const eingabeKlasse =
		'w-full rounded border border-slate-700 bg-slate-900 px-3 py-2 text-slate-100 ' +
		'placeholder:text-slate-500 focus:border-emerald-500 focus:outline-none';
</script>

<svelte:head><title>{m.mailboxes_title()} · Nightwatch</title></svelte:head>

<main class="mx-auto flex min-h-screen max-w-4xl flex-col gap-8 px-6 py-12">
	<header class="flex flex-col gap-2">
		<h1 class="flex items-center gap-3 text-2xl font-semibold text-slate-50">
			<Inbox class="size-6 text-emerald-400" aria-hidden="true" />
			{m.mailboxes_title()}
		</h1>
		<p class="max-w-2xl text-sm text-slate-400">{m.mailboxes_intro()}</p>
	</header>

	{#if form?.erfolg}
		<p
			class="rounded border border-emerald-800 bg-emerald-950/40 px-4 py-2 text-sm text-emerald-300"
			role="status"
		>
			{m.saved()}
		</p>
	{/if}

	<section class="flex flex-col gap-4">
		{#each data.postfaecher as postfach (postfach.id)}
			<article class="rounded-lg border border-slate-800 bg-slate-900/50">
				<div class="flex flex-wrap items-start justify-between gap-4 p-4">
					<div class="flex flex-col gap-1">
						<h2 class="text-lg font-medium text-slate-100">{postfach.bezeichnung}</h2>
						<p class="font-mono text-sm text-slate-400">{postfach.adresse}</p>
					</div>

					<div class="flex items-center gap-2">
						<span
							class="rounded-full px-2 py-1 text-xs {postfach.aktiv
								? 'bg-emerald-950 text-emerald-300'
								: 'bg-slate-800 text-slate-400'}"
						>
							{postfach.aktiv ? m.mailbox_active() : m.mailbox_paused()}
						</span>

						<form method="POST" action="?/umschalten" use:enhance>
							<input type="hidden" name="id" value={postfach.id} />
							<input type="hidden" name="aktiv" value={String(!postfach.aktiv)} />
							<button
								type="submit"
								class="rounded border border-slate-700 px-3 py-1 text-xs text-slate-300 hover:border-slate-500"
							>
								{postfach.aktiv ? m.mailbox_pause() : m.mailbox_resume()}
							</button>
						</form>

						<form
							method="POST"
							action="?/entfernen"
							use:enhance={({ cancel }) => {
								if (!confirm(m.mailbox_remove_confirm())) cancel();
							}}
						>
							<input type="hidden" name="id" value={postfach.id} />
							<button
								type="submit"
								class="flex items-center gap-1 rounded border border-slate-700 px-3 py-1 text-xs text-rose-300 hover:border-rose-700"
							>
								<Trash2 class="size-3" aria-hidden="true" />
								{m.mailbox_remove()}
							</button>
						</form>
					</div>
				</div>

				<dl class="grid gap-x-6 gap-y-2 border-t border-slate-800 p-4 text-sm sm:grid-cols-2">
					<dt class="text-slate-500">{m.mailbox_last_poll()}</dt>
					<dd class="text-slate-300">{zeitpunkt(postfach.letzterErfolgreicherPoll)}</dd>

					{#if postfach.letzterFehlerCode}
						<dt class="text-slate-500">{m.mailbox_last_error()}</dt>
						<dd class="text-amber-300">
							<span class="font-mono">{postfach.letzterFehlerCode}</span>
							{#if postfach.letzterFehlerText}
								<span class="text-slate-400"> — {postfach.letzterFehlerText}</span>
							{/if}
							<span class="text-slate-500"> ({zeitpunkt(postfach.letzterFehlerAm)})</span>
						</dd>
					{/if}

					<dt class="text-slate-500">{m.mailbox_status()}</dt>
					<dd class="text-slate-300">
						{postfach.lernfensterAbgeschlossenAm
							? m.mailbox_backfill_done()
							: m.mailbox_backfill_running()}
					</dd>

					<dt class="text-slate-500"><KeyRound class="inline size-3" aria-hidden="true" /></dt>
					<dd
						class={postfach.credentialZustand === 'ok'
							? 'text-slate-300'
							: postfach.credentialZustand === 'unbekannt'
								? 'text-slate-400'
								: 'text-amber-300'}
					>
						{#if postfach.credentialZustand === 'ok'}
							<CheckCircle2 class="inline size-3" aria-hidden="true" />
						{:else if postfach.credentialZustand !== 'unbekannt'}
							<AlertTriangle class="inline size-3" aria-hidden="true" />
						{/if}
						{CREDENTIAL_TEXT[postfach.credentialZustand]()}
						{#if postfach.secretAblaufAm}
							<span class="text-slate-500"> ({zeitpunkt(postfach.secretAblaufAm)})</span>
						{/if}
					</dd>
				</dl>

				<details class="border-t border-slate-800">
					<summary class="cursor-pointer px-4 py-3 text-sm text-emerald-400">
						{m.onboarding_title()}
					</summary>

					<div class="flex flex-col gap-6 px-4 pb-4">
						<div class="flex flex-col gap-2">
							<h3 class="text-sm font-medium text-slate-200">{m.onboarding_consent()}</h3>
							<p class="text-sm text-slate-400">{m.onboarding_consent_hint()}</p>
							<p class="text-sm text-slate-400">
								{m.onboarding_redirect_hint()}
								<code class="mt-1 block font-mono text-xs break-all text-slate-300">
									{data.redirectUri}
								</code>
							</p>
							<!-- eslint-disable svelte/no-navigation-without-resolve --
							Absolute URL to login.microsoftonline.com. `resolve()` maps this app's own
							routes and must not be applied to a foreign origin. -->
							<a
								href={postfach.consentUrl}
								target="_blank"
								rel="noreferrer noopener"
								class="w-fit rounded border border-emerald-800 px-3 py-1 text-sm text-emerald-300 hover:border-emerald-600"
							>
								{m.onboarding_consent_open()}
							</a>
							<!-- eslint-enable svelte/no-navigation-without-resolve -->
						</div>

						<div class="flex flex-col gap-2">
							<h3 class="text-sm font-medium text-slate-200">{m.onboarding_rbac()}</h3>
							<p class="text-sm text-slate-400">{m.onboarding_rbac_hint()}</p>
							<pre class="overflow-x-auto rounded bg-slate-950 p-3 text-xs text-slate-300"><code
									>{postfach.rbacSnippet}</code
								></pre>
						</div>
					</div>
				</details>
			</article>
		{:else}
			<p class="rounded-lg border border-dashed border-slate-800 p-6 text-sm text-slate-400">
				{m.mailboxes_empty()}
			</p>
		{/each}
	</section>

	<section class="rounded-lg border border-slate-800 bg-slate-900/50 p-4">
		<h2 class="mb-4 text-lg font-medium text-slate-100">{m.mailbox_add()}</h2>

		{#if fehler.formular}
			<p class="mb-4 rounded border border-rose-900 bg-rose-950/40 px-3 py-2 text-sm text-rose-300">
				{m.error_create()}
			</p>
		{/if}

		<form method="POST" action="?/anlegen" use:enhance class="grid gap-4 sm:grid-cols-2">
			{#snippet feld(
				name: string,
				label: string,
				hinweis: string,
				typ: string,
				wert: string | number,
				pflicht: boolean
			)}
				<div class="flex flex-col gap-1">
					<label class="text-sm text-slate-300" for={name}>{label}</label>
					<input
						class={eingabeKlasse}
						id={name}
						{name}
						type={typ}
						value={wert}
						required={pflicht}
						aria-describedby="{name}-hinweis"
						aria-invalid={meldung(name) ? 'true' : undefined}
					/>
					<p id="{name}-hinweis" class="text-xs text-slate-500">{hinweis}</p>
					{#if meldung(name)}
						<p class="text-xs text-rose-400">{meldung(name)}</p>
					{/if}
				</div>
			{/snippet}

			{@render feld(
				'bezeichnung',
				m.mailbox_label(),
				m.mailbox_label_hint(),
				'text',
				eingaben?.bezeichnung ?? '',
				true
			)}
			{@render feld(
				'adresse',
				m.mailbox_address(),
				'noc@example.com',
				'email',
				eingaben?.adresse ?? '',
				true
			)}
			{@render feld(
				'tenantId',
				m.mailbox_tenant(),
				m.mailbox_tenant_hint(),
				'text',
				eingaben?.tenantId ?? '',
				true
			)}
			{@render feld(
				'clientId',
				m.mailbox_client(),
				m.mailbox_client_hint(),
				'text',
				eingaben?.clientId ?? '',
				true
			)}
			<!-- Bewusst ohne `value`: ein Secret wird nie an den Browser zurückgegeben (SPEC §12). -->
			{@render feld(
				'clientSecret',
				m.mailbox_secret(),
				m.mailbox_secret_hint(),
				'password',
				'',
				true
			)}
			{@render feld(
				'secretAblaufAm',
				m.mailbox_secret_expiry(),
				m.mailbox_secret_expiry_hint(),
				'date',
				eingaben?.secretAblaufAm ?? '',
				false
			)}
			{@render feld(
				'pollIntervallSekunden',
				m.mailbox_interval(),
				m.mailbox_interval_hint(),
				'number',
				eingaben?.pollIntervallSekunden ?? 120,
				true
			)}
			{@render feld(
				'lernfensterTage',
				m.mailbox_learning_window(),
				m.mailbox_learning_window_hint(),
				'number',
				eingaben?.lernfensterTage ?? 30,
				true
			)}

			<div class="sm:col-span-2">
				<button
					type="submit"
					class="rounded bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500"
				>
					{m.mailbox_save()}
				</button>
			</div>
		</form>
	</section>
</main>
