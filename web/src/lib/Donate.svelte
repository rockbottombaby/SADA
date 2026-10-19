<script lang="ts">
  // Where money is needed: the fundraisers for Sha'ban al-Dalou's family and others in Gaza. Shown by the "Buy me a coffee" button and in About.
  const CAMPAIGNS = [
    { title: "Support Sha'ban's family", by: 'GoFundMe · started for Sha\'ban\'s family of seven, organised by Mohamad Ali',
      url: 'https://www.gofundme.com/f/donate-to-me-those-affected-by-the-war-in-gaza' },
    { title: "Sha'ban's cousin's fundraiser", by: 'GoFundMe · family member in Gaza',
      url: 'https://gofund.me/005519d20' },
    { title: 'Gaza Skate Team', by: 'GoFundMe · the skateboarding community in Gaza',
      url: 'https://www.gofundme.com/f/donate-to-the-gaza-skate-team-gm8ut' },
    { title: 'Save the Raneen family', by: 'Chuffed · a family in Gaza',
      url: 'https://chuffed.org/project/157829-save-the-raneen-family' },
  ];
</script>

<div class="links">
  {#each CAMPAIGNS as c}
    <a class="camp" href={c.url} target="_blank" rel="noopener noreferrer">
      <span class="t">{c.title}</span><span class="b">{c.by}</span><i>↗</i>
    </a>
  {/each}
</div>
<p class="note">All of these are run by others, not by SADA. Please read each page before giving.</p>

<style>
  .links { display: flex; flex-direction: column; gap: 8px; margin: 14px 0 8px; }
  .camp { display: grid; grid-template-columns: 1fr auto; grid-template-rows: auto auto; column-gap: 12px; padding: 12px 14px; border: 1px solid var(--line2);
    border-radius: var(--r); color: var(--ink); text-decoration: none; transition: border-color .15s, background .15s; }
  .camp:hover { border-color: var(--ink); background: rgba(232,232,232,.04); }
  .t { font-size: 14px; font-weight: 600; }
  .b { grid-column: 1; font-size: 11.5px; color: var(--muted); margin-top: 2px; }
  .camp i { grid-row: 1 / 3; grid-column: 2; align-self: center; font-style: normal; color: var(--muted); }
  .note { font-size: 11.5px; color: var(--faint); margin: 4px 0 0; }
</style>
