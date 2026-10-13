<template>
  <div>
    <span>{{ n }}</span>
  </div>
  <p>x</p>
</template>
<script setup lang="ts">
import { ref } from 'vue'
const props = withDefaults(
  defineProps<{
    a?: number
  }>(),
  {
    a: 1,
  },
)
const n = ref(props.a + 1)
</script>
