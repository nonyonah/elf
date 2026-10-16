<script setup lang="ts">
import Badge from "./Badge.vue";

interface Props {
  title?: string;
}

const props = defineProps<Props>();
</script>

<template>
  <div class="card">
    <h2>{{ props.title }}</h2>
    <Badge label="New" />
  </div>
</template>
