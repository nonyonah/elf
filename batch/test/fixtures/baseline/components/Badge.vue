<script setup lang="ts">
interface Props {
  label?: string;
}

const props = defineProps<Props>();
</script>

<template>
  <span class="badge">{{ props.label ?? "New" }}</span>
</template>
