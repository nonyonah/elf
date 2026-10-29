<script lang="ts">
  interface Props {
    tone?: "positive" | "negative";
    label: string;
  }

  let { tone = "positive", label }: Props = $props();
</script>

<span class="status" data-tone={tone}>{label}</span>
