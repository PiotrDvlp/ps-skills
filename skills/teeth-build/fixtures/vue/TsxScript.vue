<script setup lang="tsx">
const label = (n: number) => <span>{n + 1}</span>
defineProps<{ n: number }>()
</script>

<template>
  <p>x</p>
</template>
