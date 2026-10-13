<template><span>{{ label }}</span></template>
<script setup lang="ts">
import { computed } from 'vue'
const props = withDefaults(defineProps<{ count?: number }>(), {
  count: 0,
})
const label = computed(() => (props.count > 9 ? '9+' : String(props.count)))
</script>
